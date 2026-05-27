// serveChat — minimal HTTP adapter that puts an `AgentSession` behind
// SSE + POST so a browser-side SDK can drive it.
//
// Single-process, single-subscriber per session. Each SessionEntry owns
// the AgentSession, the ring buffer for reconnect replay, and the active
// SSE reader (if any). Phase events (`onPhase`) ride the same wire as
// AgentEvents so the client can show a generating/running indicator.
//
// Routes:
//   POST   /session                       → create + return { sessionId }
//   GET    /session/:id/events            → SSE stream
//   POST   /session/:id/messages          → forward to session.send()
//   POST   /session/:id/close             → session.close()
//   GET    /session/:id/transcript        → ring buffer dump (resync fallback)
//   OPTIONS *                             → CORS preflight
//
// Auth, multi-subscriber broadcast, and persistent sessionStore are
// deferred. The interface keeps room for them — see ServeChatOptions.

import type { Agent } from "../agent.ts";
import type { AgentEvent, AgentPhase } from "../types.ts";
import {
  encodeHeartbeat,
  encodeSSE,
  parseInboundMessage,
  parseLastEventId,
  SSE_EVENT_NAME as _SSE,
  type WireEvent,
  type WireFrame,
} from "./protocol.ts";

// ────────────────────────────────────────────────────────────────────────────
// Public options
// ────────────────────────────────────────────────────────────────────────────

export interface BuildAgentInput {
  req: Request;
  sessionId: string;
  initialTask: string;
  /** Provided by serveChat. Agents MUST forward this to
   *  `new Agent({ onPhase })` so the client can show a generating /
   *  running indicator. */
  onPhase: (phase: AgentPhase, stepIndex: number) => void;
}

export interface ServeChatOptions {
  buildAgent: (input: BuildAgentInput) => Promise<Agent> | Agent;
  /** Per-session ring buffer (events). Default 256. */
  reconnectBuffer?: number;
  /** SSE heartbeat interval (ms). Default 15_000. Set to 0 to disable. */
  heartbeatMs?: number;
  /** CORS Access-Control-Allow-Origin. Default `*`. Pass a function for
   *  per-request decisions. Return `null` to omit the header (browser
   *  will block the call). When the function form returns a specific origin
   *  (not `*`), the response also gets `access-control-allow-credentials:
   *  true` so the browser will send cookies / Authorization headers on
   *  `credentials: "include"` requests. */
  cors?: string | ((req: Request) => string | null);
}

/**
 * Throw from `buildAgent` to signal the caller is unauthenticated.
 * serveChat catches it and responds 401 instead of the generic 500.
 *
 * Example:
 *   buildAgent: async ({ req }) => {
 *     const session = await validate(extractToken(req));
 *     if (!session) throw new UnauthorizedError("invalid session");
 *     return new Agent(...);
 *   }
 */
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: SessionEntry
// ────────────────────────────────────────────────────────────────────────────

/** Reader callback registered by an active SSE connection. */
type ReaderFn = (frame: WireFrame) => void;

class SessionEntry {
  readonly sessionId: string;
  readonly #ringMax: number;
  #ring: WireFrame[] = [];
  #seq = 0;
  #reader: ReaderFn | null = null;
  /** Set once the agent is wired up. Until then, `emit()` only fills the
   *  ring (no subscriber yet — that's fine, the next SSE GET will replay). */
  // deno-lint-ignore no-explicit-any
  #agentSession: any = null;
  #pumpDone: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(sessionId: string, ringMax: number) {
    this.sessionId = sessionId;
    this.#ringMax = ringMax;
  }

  /** Push a wire event. Increments seq, appends to ring, fans out to the
   *  active reader (if any). Always returns the assigned seq. */
  emit(event: WireEvent): number {
    if (this.#closed) return this.#seq;
    const seq = ++this.#seq;
    const frame: WireFrame = { seq, event };
    this.#ring.push(frame);
    if (this.#ring.length > this.#ringMax) {
      // Drop the oldest. Once the head rolls past a client's
      // Last-Event-ID, a reconnect with that id will fall through to a
      // `resync` frame and the client refetches /transcript.
      this.#ring.shift();
    }
    try {
      this.#reader?.(frame);
    } catch {
      // Reader errors are best-effort — typically caused by the underlying
      // stream being torn down. We drop the reference and rely on the
      // close handler set by `subscribe` for cleanup.
      this.#reader = null;
    }
    return seq;
  }

  /** Attach the live AgentSession and start the event pump. */
  // deno-lint-ignore no-explicit-any
  attachSession(session: any): void {
    this.#agentSession = session;
    this.#pumpDone = (async () => {
      try {
        for await (const ev of session.events as AsyncIterable<AgentEvent>) {
          this.emit(ev);
        }
      } catch (e) {
        // Surface pump failures as a synthetic abort so the client UI
        // doesn't hang on a dead stream.
        this.emit({
          kind: "abort",
          error: `event pump: ${(e as Error).message}`,
          turn: 0,
          cause: "user",
        });
      }
    })();
  }

  /** Subscribe an SSE reader. Replays from `lastEventId + 1` if possible,
   *  emits a `resync` frame otherwise. Returns a teardown fn. */
  subscribe(lastEventId: number | null, write: ReaderFn): () => void {
    if (lastEventId !== null) {
      const firstSeq = this.#ring.length === 0 ? this.#seq + 1 : this.#ring[0].seq;
      if (lastEventId + 1 < firstSeq) {
        // Ring rolled. Tell the client to refetch via /transcript.
        write({ seq: ++this.#seq, event: { kind: "resync", reason: "ring_rolled" } });
      } else {
        for (const f of this.#ring) {
          if (f.seq > lastEventId) write(f);
        }
      }
    }
    this.#reader = write;
    return () => {
      if (this.#reader === write) this.#reader = null;
    };
  }

  /** Snapshot of the ring buffer for the /transcript endpoint. */
  ringSnapshot(): WireFrame[] {
    return [...this.#ring];
  }

  send(content: string): void {
    if (!this.#agentSession) {
      throw new Error("session not yet open");
    }
    this.#agentSession.send({ kind: "user_message", content });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#agentSession?.close();
    } catch { /* close errors swallowed; we're tearing down */ }
    try {
      await this.#pumpDone;
    } catch { /* */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public factory
// ────────────────────────────────────────────────────────────────────────────

export function serveChat(opts: ServeChatOptions): (req: Request) => Promise<Response> {
  const ringMax = opts.reconnectBuffer ?? 256;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const sessions = new Map<string, SessionEntry>();

  const corsHeaders = (req: Request): HeadersInit => {
    const allow = typeof opts.cors === "function"
      ? opts.cors(req)
      : (opts.cors ?? "*");
    if (allow === null) return {};
    const headers: Record<string, string> = {
      "access-control-allow-origin": allow,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, last-event-id",
    };
    // Browsers reject `credentials: include` against `*`. Only set the
    // credentials header when the host has explicitly echoed a single
    // origin back, which is the safe pattern.
    if (allow !== "*") {
      headers["access-control-allow-credentials"] = "true";
      // Vary on Origin so caches don't mix per-origin responses.
      headers["vary"] = "origin";
    }
    return headers;
  };

  const json = (req: Request, body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...corsHeaders(req) },
    });

  const error = (req: Request, status: number, message: string): Response =>
    json(req, { error: message }, status);

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // POST /session
    if (req.method === "POST" && path === "/session") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return error(req, 400, "invalid JSON body");
      }
      const initialTask = (body as { initialTask?: unknown })?.initialTask;
      if (typeof initialTask !== "string" || initialTask.length === 0) {
        return error(req, 400, "`initialTask` is required");
      }

      const sessionId = crypto.randomUUID();
      const entry = new SessionEntry(sessionId, ringMax);
      sessions.set(sessionId, entry);

      let agent: Agent;
      try {
        agent = await opts.buildAgent({
          req,
          sessionId,
          initialTask,
          onPhase: (phase, stepIndex) => {
            entry.emit({ kind: "phase", phase, stepIndex });
          },
        });
      } catch (e) {
        sessions.delete(sessionId);
        if (e instanceof UnauthorizedError) {
          return error(req, 401, e.message);
        }
        return error(req, 500, `buildAgent failed: ${(e as Error).message}`);
      }

      let session;
      try {
        session = await agent.openSession();
      } catch (e) {
        sessions.delete(sessionId);
        return error(req, 500, `openSession failed: ${(e as Error).message}`);
      }
      entry.attachSession(session);

      return json(req, { sessionId });
    }

    // Routes below all expect /session/:id/...
    const match = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return error(req, 404, "not found");
    const sessionId = match[1];
    const rest = match[2] ?? "";

    const entry = sessions.get(sessionId);
    if (!entry) return error(req, 404, "session not found");

    // GET /session/:id/events
    if (req.method === "GET" && rest === "/events") {
      const lastEventId = parseLastEventId(req.headers.get("last-event-id"));
      const encoder = new TextEncoder();
      let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
      let teardown: (() => void) | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (frame: WireFrame) => {
            try {
              controller.enqueue(encoder.encode(encodeSSE(frame)));
            } catch {
              // Stream torn down; teardown will be called via cancel.
            }
          };
          teardown = entry.subscribe(lastEventId, write);
          // Initial heartbeat opens the stream promptly (some browsers
          // delay the "open" event until the first byte arrives).
          controller.enqueue(encoder.encode(encodeHeartbeat()));
          if (heartbeatMs > 0) {
            heartbeatHandle = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(encodeHeartbeat()));
              } catch { /* */ }
            }, heartbeatMs);
          }
        },
        cancel() {
          teardown?.();
          if (heartbeatHandle !== null) clearInterval(heartbeatHandle);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          // Disable nginx buffering for live streaming.
          "x-accel-buffering": "no",
          ...corsHeaders(req),
        },
      });
    }

    // POST /session/:id/messages
    if (req.method === "POST" && rest === "/messages") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return error(req, 400, "invalid JSON body");
      }
      try {
        const msg = parseInboundMessage(body);
        entry.send(msg.content);
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      } catch (e) {
        return error(req, 400, (e as Error).message);
      }
    }

    // POST /session/:id/close
    if (req.method === "POST" && rest === "/close") {
      await entry.close();
      sessions.delete(sessionId);
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    // GET /session/:id/transcript
    if (req.method === "GET" && rest === "/transcript") {
      return json(req, { events: entry.ringSnapshot() });
    }

    return error(req, 404, "not found");
  };
}
