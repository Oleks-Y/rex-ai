// RexClient — framework-agnostic transport client for the rex-ai chat SDK.
//
// Owns the SSE downstream + POST upstream. Exposes an `AsyncIterable` of
// `WireEvent`s; consumers (the React hook, vanilla apps) iterate it and
// drive their own UI state.
//
// v0 scope: open → events → send → close. Reconnect / Last-Event-ID /
// transcript-resync are intentionally out of v0 — they're tracked in the
// plan and will land as a follow-up. A network drop currently terminates
// the events iterator with an error so the consumer surfaces it.

import type { WireEvent, WireFrame } from "./types";

export interface RexClientOptions {
  /** Base URL of the agent host. Example: `http://localhost:8787`. */
  baseUrl: string;
  /** Optional fetch override for tests / SSR. */
  fetch?: typeof fetch;
  /** Headers to attach to every request (e.g. an auth bearer). */
  headers?: () => Record<string, string>;
}

export class RexClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: () => Record<string, string>;
  #sessionId: string | null = null;
  #abortController: AbortController | null = null;
  #queue: AsyncQueue<WireEvent> | null = null;

  constructor(opts: RexClientOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#headers = opts.headers ?? (() => ({}));
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  /** Create a server-side session and start streaming events. */
  async open(initialTask: string): Promise<{ sessionId: string }> {
    if (this.#sessionId !== null) {
      throw new Error("RexClient.open: session already open");
    }
    const res = await this.#fetch(`${this.#baseUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#headers() },
      body: JSON.stringify({ initialTask }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`RexClient.open: ${res.status} ${text}`);
    }
    const body = (await res.json()) as { sessionId: string };
    this.#sessionId = body.sessionId;
    this.#queue = new AsyncQueue<WireEvent>();
    this.#startStream();
    return { sessionId: body.sessionId };
  }

  /** Queue a user message. Fire-and-forget; transport errors land on the
   *  events iterator as a synthetic `abort`. */
  send(content: string): void {
    if (this.#sessionId === null) {
      throw new Error("RexClient.send: no open session");
    }
    const id = this.#sessionId;
    this.#fetch(`${this.#baseUrl}/session/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.#headers() },
      body: JSON.stringify({ kind: "user_message", content }),
    }).then((res) => {
      if (!res.ok) {
        this.#queue?.push({
          kind: "abort",
          error: `send failed: ${res.status}`,
          turn: 0,
          cause: "user",
        });
      }
    }).catch((e) => {
      this.#queue?.push({
        kind: "abort",
        error: `send error: ${(e as Error).message}`,
        turn: 0,
        cause: "user",
      });
    });
  }

  /** Async iterator over wire events. Includes `phase` and `resync` —
   *  consumers should switch on `kind`. */
  events(): AsyncIterable<WireEvent> {
    if (!this.#queue) {
      throw new Error("RexClient.events: call open() first");
    }
    return this.#queue;
  }

  /** Close the session. Idempotent. */
  async close(): Promise<void> {
    const id = this.#sessionId;
    this.#sessionId = null;
    this.#abortController?.abort();
    this.#abortController = null;
    this.#queue?.close();
    this.#queue = null;
    if (id === null) return;
    try {
      await this.#fetch(`${this.#baseUrl}/session/${id}/close`, {
        method: "POST",
        headers: this.#headers(),
      });
    } catch {
      // Server-side close failure is non-fatal for the client.
    }
  }

  #startStream(): void {
    const id = this.#sessionId!;
    const q = this.#queue!;
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    (async () => {
      try {
        const res = await this.#fetch(`${this.#baseUrl}/session/${id}/events`, {
          headers: { accept: "text/event-stream", ...this.#headers() },
          signal,
        });
        if (!res.ok || !res.body) {
          q.push({
            kind: "abort",
            error: `event stream: ${res.status}`,
            turn: 0,
            cause: "user",
          });
          q.close();
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are separated by blank lines.
          let nl: number;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, nl);
            buf = buf.slice(nl + 2);
            const frame = parseSSEBlock(raw);
            if (frame) q.push(frame.event);
          }
        }
        q.close();
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          q.close();
          return;
        }
        q.push({
          kind: "abort",
          error: `stream error: ${(e as Error).message}`,
          turn: 0,
          cause: "user",
        });
        q.close();
      }
    })();
  }
}

/** Parse a single SSE event block: lines like `event: …`, `id: …`,
 *  `data: …`. Comments (`:`) and unknown fields are ignored. Returns null
 *  for heartbeats / malformed blocks. */
function parseSSEBlock(raw: string): WireFrame | null {
  let data = "";
  let id: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      data += line.slice(5).trimStart();
    } else if (line.startsWith("id:")) {
      const n = Number(line.slice(3).trim());
      if (Number.isFinite(n)) id = n;
    }
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as WireFrame;
    if (id !== null) parsed.seq = id;
    return parsed;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Internal: small async queue
// ────────────────────────────────────────────────────────────────────────────

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) {
      w({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    while (this.#waiters.length > 0) {
      this.#waiters.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.#items.length > 0) {
          return Promise.resolve({ value: this.#items.shift()!, done: false });
        }
        if (this.#closed) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
