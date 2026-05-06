// AgentSessionImpl — duplex event-driven session.
//
// Behind `experimental.asyncWakeups`. The session opens a single
// PersistentSandbox and drives a single-threaded worker that consumes
// events from an inbound queue. Event sources:
//   - the initial task (passed to `open`)
//   - `send(UserMessage)` from the host
//   - `wakeup_fired` from the sandbox (via PersistentSandbox handlers)
// User events preempt queued wakeups; everything is FIFO within a kind.
// Signal-based wakeups (`scheduleWakeup.signal`) arrive in step 5.
//
// Public surface (re-exported via mod.ts as `AgentSession`):
//   - events:  AsyncIterable<AgentEvent>
//   - send:    queue a user message
//   - close:   graceful shutdown (idempotent)
//
// Concurrency model: one worker, one queue. Each event triggers an
// inner step loop that runs until a terminal sandbox frame or the
// per-turn `maxSteps` cap. Turns are 1-based; they advance once per
// inbound event the worker consumes (not per step).

import { generateText } from "ai";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { CodeExtractor } from "./extractor.ts";
import { PersistentSandbox } from "./persistent_sandbox.ts";
import { PromptBuilder, type PriorStep, type SessionSnapshot } from "./prompt.ts";
import { SessionStore } from "./session.ts";
import type { ToolRegistry } from "./tools.ts";
import {
  type AgentEvent,
  type AgentSession,
  type PermissionsConfig,
  type SizeCaps,
  type StepRecord,
  type TurnCause,
  type UserMessage,
} from "./types.ts";

/** Internal queue events. */
type LoopEvent =
  | { kind: "user_task"; task: string }
  | { kind: "user_message"; content: string }
  | {
    kind: "wakeup_fired";
    id: string;
    /** Mirrors the underlying handle's terminal status when fired. */
    status: "resolved" | "rejected" | "cancelled";
    /** Error message if `status === "rejected"`, cancel reason if
     *  `cancelled`, otherwise empty. */
    detail: string;
  };

interface OpenInput {
  model: LanguageModelV2;
  task: string;
  tools: ToolRegistry;
  permissions: PermissionsConfig | undefined;
  sizeCaps: SizeCaps;
  maxSteps: number;
  resumeHistory: boolean;
  sessionId: string | undefined;
  sessionsRoot: string | undefined;
  onStep?: (step: StepRecord) => void | Promise<void>;
}

export class AgentSessionImpl implements AgentSession {
  readonly #model: LanguageModelV2;
  readonly #tools: ToolRegistry;
  readonly #permissions: PermissionsConfig | undefined;
  readonly #sizeCaps: SizeCaps;
  readonly #maxSteps: number;
  readonly #onStep?: (step: StepRecord) => void | Promise<void>;

  readonly #session: SessionStore;
  readonly #sandbox: PersistentSandbox;

  readonly #inbox: AsyncQueueInternal<LoopEvent>;
  readonly #outbox: AsyncQueueInternal<AgentEvent>;
  #workerDone: Promise<void>;

  #priorSteps: PriorStep[] = [];
  #resumedCount = 0;
  #freshStepCount = 0;
  #turnCount = 0;
  /** Last user-supplied task. Wakeup-driven turns reuse it as the
   *  prompt's task framing — the model still needs to know what the
   *  user originally asked for. */
  #lastUserTask: string;

  #closed = false;
  #closeResult: Promise<void> | null = null;

  readonly events: AsyncIterable<AgentEvent>;

  private constructor(args: {
    model: LanguageModelV2;
    tools: ToolRegistry;
    permissions: PermissionsConfig | undefined;
    sizeCaps: SizeCaps;
    maxSteps: number;
    onStep?: (step: StepRecord) => void | Promise<void>;
    session: SessionStore;
    sandbox: PersistentSandbox;
    initialTask: string;
  }) {
    this.#model = args.model;
    this.#tools = args.tools;
    this.#permissions = args.permissions;
    this.#sizeCaps = args.sizeCaps;
    this.#maxSteps = args.maxSteps;
    this.#onStep = args.onStep;
    this.#session = args.session;
    this.#sandbox = args.sandbox;
    this.#inbox = new AsyncQueueInternal<LoopEvent>();
    this.#outbox = new AsyncQueueInternal<AgentEvent>();
    this.events = this.#outbox;
    this.#workerDone = Promise.resolve();
    this.#lastUserTask = args.initialTask;
  }

  static async open(input: OpenInput): Promise<AgentSessionImpl> {
    const session = await SessionStore.open({
      sessionId: input.sessionId,
      rootDir: input.sessionsRoot,
      sizeCaps: input.sizeCaps,
    });

    // We need to thread `impl` into the wakeup handlers below. Declare
    // the variable up front and capture it via closure; the handlers
    // are only invoked AFTER `impl` is assigned.
    // deno-lint-ignore prefer-const
    let impl!: AgentSessionImpl;

    let sandbox: PersistentSandbox;
    try {
      sandbox = await PersistentSandbox.open({
        tools: input.tools,
        session,
        permissions: input.permissions,
        sizeCaps: input.sizeCaps,
        wakeupHandlers: {
          onScheduled: (d) => {
            impl?.["emitWakeupScheduled"](d);
          },
          onResolved: (id) => {
            impl?.["enqueueWakeupFired"]({
              kind: "wakeup_fired",
              id,
              status: "resolved",
              detail: "",
            });
          },
          onRejected: (id, error) => {
            impl?.["enqueueWakeupFired"]({
              kind: "wakeup_fired",
              id,
              status: "rejected",
              detail: error,
            });
          },
          onCancelled: (id, reason) => {
            impl?.["enqueueWakeupFired"]({
              kind: "wakeup_fired",
              id,
              status: "cancelled",
              detail: reason,
            });
          },
        },
      });
    } catch (e) {
      await session.close();
      throw e;
    }

    impl = new AgentSessionImpl({
      model: input.model,
      tools: input.tools,
      permissions: input.permissions,
      sizeCaps: input.sizeCaps,
      maxSteps: input.maxSteps,
      onStep: input.onStep,
      session,
      sandbox,
      initialTask: input.task,
    });

    // Replay (if requested) BEFORE the worker starts. A failure here
    // leaves nothing in flight, but we still need to release the
    // sandbox + session lock or we leak them.
    try {
      if (input.resumeHistory) {
        await impl.#replayTranscript();
      }
    } catch (e) {
      try { await sandbox.close(); } catch { /* */ }
      try { await session.close(); } catch { /* */ }
      throw e;
    }

    impl.#inbox.push({ kind: "user_task", task: input.task });
    impl.#workerDone = impl.#runWorker();
    return impl;
  }

  send(msg: UserMessage): void {
    if (this.#closed) return;
    if (!msg || msg.kind !== "user_message" || typeof msg.content !== "string") {
      throw new Error("AgentSession.send: expected { kind: 'user_message', content: string }");
    }
    // User messages preempt queued wakeups but stay FIFO with respect
    // to other user messages (per plan §"Ordering rules").
    this.#inbox.pushAhead(
      { kind: "user_message", content: msg.content },
      (existing) => existing.kind === "wakeup_fired",
    );
  }

  // ── wakeup hooks called by PersistentSandbox handlers ────────────────

  /** @internal — called by the wakeup handler closure in `open()`. */
  private emitWakeupScheduled(d: import("./persistent_sandbox.ts").WakeupDescriptor): void {
    this.#emit({
      kind: "wakeup_scheduled",
      id: d.id,
      reason: d.reason,
      wakeupKind: d.wakeupKind,
    });
  }

  /** @internal — called by the wakeup handler closures in `open()`. */
  private enqueueWakeupFired(ev: Extract<LoopEvent, { kind: "wakeup_fired" }>): void {
    // Always surface the lifecycle event to the host, even after
    // `close()` (the host may want to log the cancellation). Only the
    // turn enqueue is gated on closed.
    if (ev.status === "resolved") {
      this.#emit({ kind: "wakeup_resolved", id: ev.id });
    } else if (ev.status === "rejected") {
      this.#emit({ kind: "wakeup_rejected", id: ev.id, error: ev.detail });
    } else {
      this.#emit({ kind: "wakeup_cancelled", id: ev.id, reason: ev.detail });
    }
    if (!this.#closed) this.#inbox.push(ev);
  }

  close(reason = "closed by host"): Promise<void> {
    if (this.#closeResult) return this.#closeResult;
    this.#closeResult = (async () => {
      this.#closed = true;
      this.#inbox.close(); // worker will drain remaining items, then exit.
      try {
        await this.#workerDone;
      } catch { /* worker errors are surfaced via events; ignore here */ }
      try {
        await this.#sandbox.close();
      } catch { /* */ }
      try {
        await this.#session.close();
      } catch { /* */ }
      this.#emit({ kind: "session_closed", reason });
      this.#outbox.close();
    })();
    return this.#closeResult;
  }

  // ── worker ────────────────────────────────────────────────────────────

  async #runWorker(): Promise<void> {
    while (true) {
      const next = await this.#inbox.next();
      if (next.done) return;
      // `#processEvent` now owns its own error handling so the same
      // `turn` local is reused for the abort emit. Any error escaping
      // here would be a bug — log defensively and continue rather than
      // killing the worker silently.
      try {
        await this.#processEvent(next.value);
      } catch (e) {
        this.#emit({
          kind: "abort",
          error: `agent worker error: ${(e as Error).message}`,
          turn: this.#turnCount,
          cause: "user",
        });
      }
    }
  }

  async #processEvent(ev: LoopEvent): Promise<void> {
    const turn = ++this.#turnCount;
    const cause: TurnCause = ev.kind === "wakeup_fired" ? "wakeup" : "user";

    // Update last-seen user task; wakeup-driven turns reuse it.
    if (ev.kind === "user_task" || ev.kind === "user_message") {
      this.#lastUserTask = ev.kind === "user_task" ? ev.task : ev.content;
    }

    // For wakeup-driven turns, inject a synthetic prior step so the
    // model sees "wakeup w_X resolved" inline with prior history. The
    // payload itself stays in the live JS promise — the agent reads it
    // via `tasks.get(id).done`.
    if (ev.kind === "wakeup_fired") {
      this.#priorSteps.push({
        code: `// (synthetic) wakeup ${ev.id} ${ev.status}`,
        event: {
          kind: "reflect",
          state: {
            __wakeup: {
              id: ev.id,
              status: ev.status,
              detail: ev.detail,
            },
          },
          logs: [],
        },
      });
    }

    // Follow-up user_message turns: record the new user input as a
    // synthetic prior step so the conversation thread (prior task + prior
    // reply + new question) is visible in the next prompt. The first
    // turn (`user_task`) doesn't need this — its content is already the
    // prompt's `task` field with no prior history above it.
    if (ev.kind === "user_message") {
      this.#priorSteps.push({
        code: `// (synthetic) user said:`,
        event: {
          kind: "reflect",
          state: { __user_message: ev.content },
          logs: [],
        },
      });
    }

    const taskForPrompt = this.#lastUserTask;

    try {
      let stepsThisTurn = 0;
      while (stepsThisTurn < this.#maxSteps) {
        if (this.#closed) return;
        const result = await this.#runOneStep(taskForPrompt);
        stepsThisTurn++;
        this.#freshStepCount++;
        if (result.kind === "reply") {
          this.#emit({ kind: "reply", message: result.message, turn, cause });
          return;
        }
        if (result.kind === "abort") {
          this.#emit({ kind: "abort", error: result.error, turn, cause });
          return;
        }
      }
      this.#emit({ kind: "exhausted", steps: this.#freshStepCount, turn, cause });
    } catch (e) {
      this.#emit({
        kind: "abort",
        error: `agent loop error: ${(e as Error).message}`,
        turn,
        cause,
      });
    }
  }

  async #runOneStep(taskForPrompt: string): Promise<
    { kind: "reply"; message: string }
    | { kind: "abort"; error: string }
    | { kind: "non_terminal" }
  > {
    const snapshot = await this.#sessionSnapshot();
    const prompt = PromptBuilder.build({
      task: taskForPrompt,
      tools: this.#tools.describe(),
      permissions: this.#permissions,
      session: snapshot,
      priorSteps: this.#priorSteps,
      // The persistent-session path always exposes scheduleWakeup +
      // tasks; teach the model about them.
      wakeupsEnabled: true,
    });

    const completion = await generateText({
      model: this.#model,
      prompt,
    });

    const code = CodeExtractor.extract(completion.text);
    const event = await this.#sandbox.runStep({ llmCode: code });

    const stepIndex = this.#resumedCount + this.#freshStepCount + 1;

    await this.#session.appendTranscript({
      step: stepIndex,
      code,
      event: { kind: event.kind, ...summarizeEvent(event) },
    });

    const stepRecord: StepRecord = {
      index: stepIndex,
      source: "fresh",
      code,
      event,
    };
    if (this.#onStep) {
      try {
        await this.#onStep(stepRecord);
      } catch { /* host callback errors are not fatal */ }
    }
    this.#emit({
      kind: "step",
      index: stepIndex,
      source: "fresh",
      code,
      event,
    });

    // Always record the step in prior history — including terminal
    // reply/abort. In a single-turn run() that's wasteful but harmless
    // (the session is closed afterwards). In a multi-turn interactive
    // session it's essential: the next turn's prompt needs to see what
    // the agent told the user last time, otherwise the model has no
    // memory of the prior reply.
    this.#priorSteps.push({ code, event });
    if (event.kind === "reply") return { kind: "reply", message: event.message };
    if (event.kind === "abort") return { kind: "abort", error: event.error };
    return { kind: "non_terminal" };
  }

  async #replayTranscript(): Promise<void> {
    const raw = await this.#session.loadTranscript();
    for (const entry of raw) {
      const code = typeof entry.code === "string" ? entry.code : "";
      const ev = entry.event as Record<string, unknown> | undefined;
      if (!code || !ev || typeof ev.kind !== "string") continue;
      const reconstructed = reconstructEvent(ev);
      if (!reconstructed) continue;
      this.#priorSteps.push({ code, event: reconstructed });
      this.#resumedCount++;
      const rec: StepRecord = {
        index: this.#resumedCount,
        source: "resumed",
        code,
        event: reconstructed,
      };
      if (this.#onStep) {
        try {
          await this.#onStep(rec);
        } catch { /* */ }
      }
      this.#emit({
        kind: "step",
        index: rec.index,
        source: "resumed",
        code,
        event: reconstructed,
      });
    }
  }

  async #sessionSnapshot(): Promise<SessionSnapshot> {
    const [libSource, libExports] = await Promise.all([
      this.#session.readLib(),
      this.#session.libExports(),
    ]);
    return {
      libExports,
      libSource,
      storageKeys: this.#session.storageKeys(),
    };
  }

  #emit(ev: AgentEvent): void {
    this.#outbox.push(ev);
  }
}

// ── helpers (mirrors agent.ts; kept local so step 3 doesn't churn agent.ts) ──

import type { SandboxEvent } from "./types.ts";

// deno-lint-ignore no-explicit-any
function summarizeEvent(ev: SandboxEvent): Record<string, any> {
  switch (ev.kind) {
    case "reply":
      return { message: ev.message };
    case "abort":
      return { error: ev.error };
    case "reflect":
      return { state: ev.state };
    case "permission_denied":
      return { permission: ev.permission, target: ev.target };
    case "throw":
      return { error: ev.error };
  }
}

function reconstructEvent(ev: Record<string, unknown>): SandboxEvent | null {
  switch (ev.kind) {
    case "reply":
      return { kind: "reply", message: String(ev.message ?? ""), logs: [] };
    case "abort":
      return { kind: "abort", error: String(ev.error ?? ""), logs: [] };
    case "reflect":
      return { kind: "reflect", state: ev.state, logs: [] };
    case "permission_denied":
      return {
        kind: "permission_denied",
        permission: (ev.permission ?? "read") as SandboxEvent extends
          { kind: "permission_denied"; permission: infer P } ? P : never,
        target: String(ev.target ?? ""),
        logs: [],
      };
    case "throw":
      return { kind: "throw", error: String(ev.error ?? ""), logs: [] };
    default:
      return null;
  }
}

// ── AsyncQueue ─────────────────────────────────────────────────────────────

/** Single-producer-or-multi, single-consumer async queue. Closing
 *  delivers any buffered items to the consumer, then ends iteration.
 *  Exported (with the `Internal` suffix) so tests can assert ordering
 *  invariants deterministically — not part of the public API. */
export class AsyncQueueInternal<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    if (this.#waiters.length > 0) {
      const w = this.#waiters.shift()!;
      w({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  /** Insert `item` ahead of the first existing buffered item for which
   *  `before` returns true. If no such item exists, falls through to a
   *  normal push. Used to enforce the plan's "user messages preempt
   *  queued wakeups" rule without resorting to two physical channels. */
  pushAhead(item: T, before: (existing: T) => boolean): void {
    if (this.#closed) return;
    // If a consumer is parked AND nothing is buffered, the splice is
    // moot — hand the item over directly.
    if (this.#waiters.length > 0 && this.#items.length === 0) {
      this.#waiters.shift()!({ value: item, done: false });
      return;
    }
    const idx = this.#items.findIndex(before);
    if (idx === -1) this.#items.push(item);
    else this.#items.splice(idx, 0, item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Drain any waiting consumers; they get a `done` after queued items.
    if (this.#items.length === 0) {
      while (this.#waiters.length > 0) {
        this.#waiters.shift()!({ value: undefined, done: true });
      }
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      const value = this.#items.shift()!;
      // If we were closed while items were buffered, the *next* call after
      // the last item will see done.
      return Promise.resolve({ value, done: false });
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
