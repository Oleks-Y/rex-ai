// AgentSessionImpl — duplex event-driven session.
//
// Behind `experimental.asyncWakeups`. The session opens a single
// PersistentSandbox and drives a single-threaded worker that consumes
// events from an inbound queue. Event sources:
//   - the initial task (passed to `open`)
//   - `send(UserMessage)` from the host
//   - `wakeup_fired` from the sandbox (via PersistentSandbox handlers)
// User events preempt queued wakeups; everything is FIFO within a kind.
// A user_message arriving while a `reflect(promise)` wait is in flight
// also fires a sandbox-side `cancel_step` so the wait resolves
// synthetically with `__interrupted_by` instead of holding the worker.
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
import {
  DreamPool,
  type DreamerDefinition,
  type DreamLifecycleEvent,
  type DreamPayload,
  type DreamUserInput,
} from "./dreamer.ts";
import { CodeExtractor, noCodeBlockEvent } from "./extractor.ts";
import {
  type GuardrailDefinition,
  type GuardrailEvaluation,
  GuardrailRunner,
} from "./guardrail.ts";
import { PersistentSandbox } from "./persistent_sandbox.ts";
import { PromptBuilder, type PriorStep, type SessionSnapshot } from "./prompt.ts";
import { SessionStore } from "./session.ts";
import type { ToolRegistry } from "./tools.ts";
import {
  type AgentEvent,
  type AgentPhase,
  type AgentSession,
  type GuardrailBlockedOriginal,
  NoCodeBlockError,
  type PermissionsConfig,
  type SandboxEvent,
  type SandboxLog,
  type SizeCaps,
  type StepRecord,
  type TurnCause,
  type UserMessage,
  type WakeupResolvedPayload,
} from "./types.ts";

/** Internal queue events. */
type LoopEvent =
  | { kind: "user_task"; task: string }
  | { kind: "user_message"; content: string }
  | {
    kind: "wakeup_fired";
    id: string;
    /** Underlying primitive that produced the fire. */
    wakeupKind: "timeout" | "interval" | "promise";
    /** Mirrors the descriptor's status at the moment it fired. */
    status: "resolved" | "rejected" | "cancelled";
    /** Error message if `status === "rejected"`, cancel reason if
     *  `cancelled`, otherwise empty. */
    detail: string;
    /** Payload from the resolving frame. Present only on payload-bearing
     *  ticks (callback called a control fn, or `autoWakeOnTimer` is on). */
    payload?: WakeupResolvedPayload;
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
  onPhase?: (phase: AgentPhase, stepIndex: number) => void;
  autoWakeOnTimer?: boolean;
  forceFinalReply?: boolean;
  guardrails?: GuardrailDefinition[];
  onGuardrail?: (evaluation: GuardrailEvaluation, stepIndex: number) => void;
  /** Dreamers attached to this session. Same semantics as
   *  `AgentOptions.dreamers`; the AgentSession threads them through to
   *  the DreamPool it owns for the lifetime of the session. */
  dreamers?: DreamerDefinition[];
  onDream?: (event: DreamLifecycleEvent) => void;
  awaitDreamsOnClose?: boolean;
  /** Extra read-only paths spliced into the sandbox's --allow-read.
   *  Dreamer-only; every other caller leaves this unset. */
  extraReadOnlyPaths?: string[];
}

export class AgentSessionImpl implements AgentSession {
  readonly #model: LanguageModelV2;
  readonly #tools: ToolRegistry;
  readonly #permissions: PermissionsConfig | undefined;
  readonly #sizeCaps: SizeCaps;
  readonly #maxSteps: number;
  readonly #onStep?: (step: StepRecord) => void | Promise<void>;
  readonly #onPhase?: (phase: AgentPhase, stepIndex: number) => void;
  readonly #autoWakeOnTimer: boolean;
  readonly #forceFinalReply: boolean;
  readonly #guardrails: GuardrailDefinition[];
  readonly #onGuardrail?: (
    evaluation: GuardrailEvaluation,
    stepIndex: number,
  ) => void;

  readonly #session: SessionStore;
  readonly #sandbox: PersistentSandbox;
  #dreamPool: DreamPool | null = null;
  readonly #dreamers: DreamerDefinition[];
  readonly #onDream?: (event: DreamLifecycleEvent) => void;
  readonly #awaitDreamsOnClose: boolean;

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
  /** Accumulated user inputs for the current turn. Reset each time
   *  `#processEvent` runs (turn boundary). Populated by the initial
   *  user_task, follow-up user_message events, and used by the dreamer
   *  fanout to give dreamers the conversation context the user
   *  promised them ("only what's coming from the hook and main LLM
   *  responses and user input"). */
  #turnUserInputs: DreamUserInput[] = [];

  #closed = false;
  #closeResult: Promise<void> | null = null;
  /** id of the wakeup descriptor for an in-flight `reflect(promise)`
   *  wait, if one is currently being awaited inside the sandbox.
   *  Set on `wakeup_scheduled` with `wakeupKind: "promise"` and
   *  cleared on the matching resolved/rejected/cancelled. Used by
   *  `send()` to fire `cancel_step` so a user message can preempt a
   *  long promise wait instead of being queued behind it. */
  #activePromiseWaitId: string | null = null;

  readonly events: AsyncIterable<AgentEvent>;

  private constructor(args: {
    model: LanguageModelV2;
    tools: ToolRegistry;
    permissions: PermissionsConfig | undefined;
    sizeCaps: SizeCaps;
    maxSteps: number;
    onStep?: (step: StepRecord) => void | Promise<void>;
    onPhase?: (phase: AgentPhase, stepIndex: number) => void;
    session: SessionStore;
    sandbox: PersistentSandbox;
    initialTask: string;
    autoWakeOnTimer: boolean;
    forceFinalReply: boolean;
    guardrails: GuardrailDefinition[];
    onGuardrail?: (evaluation: GuardrailEvaluation, stepIndex: number) => void;
    dreamers: DreamerDefinition[];
    onDream?: (event: DreamLifecycleEvent) => void;
    awaitDreamsOnClose: boolean;
  }) {
    this.#model = args.model;
    this.#tools = args.tools;
    this.#permissions = args.permissions;
    this.#sizeCaps = args.sizeCaps;
    this.#maxSteps = args.maxSteps;
    this.#onStep = args.onStep;
    this.#onPhase = args.onPhase;
    this.#session = args.session;
    this.#sandbox = args.sandbox;
    this.#autoWakeOnTimer = args.autoWakeOnTimer;
    this.#forceFinalReply = args.forceFinalReply;
    this.#guardrails = args.guardrails;
    this.#onGuardrail = args.onGuardrail;
    this.#dreamers = args.dreamers;
    this.#onDream = args.onDream;
    this.#awaitDreamsOnClose = args.awaitDreamsOnClose;
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
        autoWakeOnTimer: input.autoWakeOnTimer,
        extraReadOnlyPaths: input.extraReadOnlyPaths,
        wakeupHandlers: {
          onScheduled: (d) => {
            impl?.["onWakeupScheduled"](d);
          },
          onResolved: (id, payload) => {
            impl?.["onWakeupResolved"](id, payload);
          },
          onRejected: (id, error) => {
            impl?.["onWakeupRejected"](id, error);
          },
          onCancelled: (id, reason) => {
            impl?.["onWakeupCancelled"](id, reason);
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
      onPhase: input.onPhase,
      session,
      sandbox,
      initialTask: input.task,
      autoWakeOnTimer: input.autoWakeOnTimer === true,
      forceFinalReply: input.forceFinalReply ?? true,
      guardrails: [...(input.guardrails ?? [])],
      onGuardrail: input.onGuardrail,
      dreamers: [...(input.dreamers ?? [])],
      onDream: input.onDream,
      awaitDreamsOnClose: input.awaitDreamsOnClose === true,
    });

    // Open the DreamPool once the parent session is established (so its
    // dir exists for the readonly mount) but before the worker starts
    // consuming events — that way the first turn can already fan out to
    // dreamers. Failure here releases both the sandbox and session lock.
    if (impl.#dreamers.length > 0) {
      try {
        impl.#dreamPool = await DreamPool.open({
          parentSession: session,
          dreamers: impl.#dreamers,
          onDream: impl.#onDream,
        });
      } catch (e) {
        try { await sandbox.close(); } catch { /* */ }
        try { await session.close(); } catch { /* */ }
        throw e;
      }
    }

    // Replay (if requested) BEFORE the worker starts. A failure here
    // leaves nothing in flight, but we still need to release the
    // sandbox + session lock or we leak them.
    try {
      if (input.resumeHistory) {
        await impl.#replayTranscript();
      }
    } catch (e) {
      if (impl.#dreamPool) {
        try { await impl.#dreamPool.close({ awaitDrain: false }); } catch { /* */ }
      }
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
    // If a step is currently awaiting a `reflect(promise)` wait, fire
    // a cancel_step so the wait resolves with `__interrupted_by` and
    // the step terminates promptly. The user message can then be
    // processed without queueing behind a long promise. Best-effort —
    // a missed window just means the user waits a bit longer.
    if (this.#activePromiseWaitId !== null) {
      this.#sandbox.cancelStep("user_message").catch(() => {});
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
  private onWakeupScheduled(d: import("./persistent_sandbox.ts").WakeupDescriptor): void {
    if (d.wakeupKind === "promise") this.#activePromiseWaitId = d.id;
    this.#emit({
      kind: "wakeup_scheduled",
      id: d.id,
      reason: d.reason,
      wakeupKind: d.wakeupKind,
      delayMs: d.delayMs,
    });
  }

  /** @internal — called per `wakeup_resolved` frame. For payload-bearing
   *  fires, we enqueue a wakeup-driven turn; silent fires only update
   *  the descriptor (and are not emitted by the prelude in the first
   *  place for intervals, only for one-shot timeouts). */
  private onWakeupResolved(id: string, payload?: WakeupResolvedPayload): void {
    if (this.#activePromiseWaitId === id) this.#activePromiseWaitId = null;
    this.#emit({ kind: "wakeup_resolved", id, payload });
    if (this.#closed) return;
    // Lookup the descriptor to know what kind this was. Default to
    // "timeout" if absent — silent timeouts already self-pruned but
    // the worker's own state is unaffected.
    const desc = this.#sandbox.wakeups().find((w) => w.id === id);
    const wakeupKind = desc?.wakeupKind ?? "timeout";
    // Silent fires (no payload) — never wake the agent. Per plan
    // Issue 8, only explicit reflect / translated reply / abort or the
    // autoWakeOnTimer policy produces a payload, so this gate is the
    // single source of truth.
    if (!payload) return;
    this.#inbox.push({
      kind: "wakeup_fired",
      id,
      wakeupKind,
      status: "resolved",
      detail: "",
      payload,
    });
  }

  /** @internal */
  private onWakeupRejected(id: string, error: string): void {
    if (this.#activePromiseWaitId === id) this.#activePromiseWaitId = null;
    this.#emit({ kind: "wakeup_rejected", id, error });
    if (this.#closed) return;
    const desc = this.#sandbox.wakeups().find((w) => w.id === id);
    const wakeupKind = desc?.wakeupKind ?? "timeout";
    this.#inbox.push({
      kind: "wakeup_fired",
      id,
      wakeupKind,
      status: "rejected",
      detail: error,
    });
  }

  /** @internal */
  private onWakeupCancelled(id: string, reason: string): void {
    if (this.#activePromiseWaitId === id) this.#activePromiseWaitId = null;
    this.#emit({ kind: "wakeup_cancelled", id, reason });
    // Cancellation is a lifecycle event; do NOT enqueue a turn.
  }

  close(reason = "closed by host"): Promise<void> {
    if (this.#closeResult) return this.#closeResult;
    this.#closeResult = (async () => {
      this.#closed = true;
      this.#inbox.close(); // worker will drain remaining items, then exit.
      try {
        await this.#workerDone;
      } catch { /* worker errors are surfaced via events; ignore here */ }
      // Close dreamers BEFORE the parent session — their SessionStores
      // live under the parent dir, so the parent must outlive them.
      if (this.#dreamPool) {
        try {
          await this.#dreamPool.close({ awaitDrain: this.#awaitDreamsOnClose });
        } catch { /* dreamer cleanup is non-fatal */ }
        this.#dreamPool = null;
      }
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
      // Track inputs for the dreamer fanout. The user's plan is "only
      // what's coming from the hook and main LLM responses and user
      // input" — this is the user-input half.
      this.#turnUserInputs.push({
        kind: ev.kind === "user_task" ? "task" : "message",
        content: ev.kind === "user_task" ? ev.task : ev.content,
        turn,
      });
      // Fire the synthetic `user_message` trigger BEFORE generation
      // starts, so a dreamer subscribed to "user_message" can capture
      // the user's intent verbatim before the model has a chance to
      // paraphrase it. user_task triggers the same kind on turn 1 too —
      // a dreamer that wants only follow-ups can filter by turn.
      this.#dispatchSyntheticToDreamers(
        "user_message",
        ev.kind === "user_task" ? ev.task : ev.content,
        turn,
      );
    }

    // For wakeup-driven turns, inject a synthetic prior step the next
    // prompt can render. Shape depends on what fired:
    //   - timer fire (timeout / interval): a `__from_timer` block with
    //     id / kind / delayMs, plus the optional `callback_state`
    //     (whatever the callback reflected) and `translated_intent`
    //     (a callback-context reply / abort that we converted).
    //   - reflect(promise) resolution: state is the resolved value.
    //   - rejection: state surfaces the error.
    if (ev.kind === "wakeup_fired") {
      const synth = buildWakeupReflectState(ev, this.#sandbox.wakeups().find((w) => w.id === ev.id));
      this.#priorSteps.push({
        code: `// (synthetic) wakeup ${ev.id} ${ev.status}`,
        event: { kind: "reflect", state: synth, logs: [] },
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
        // The step we're about to run is the (stepsThisTurn + 1)-th in
        // this turn. When that equals maxSteps it's the final allowed
        // step and the prompt carries a "last step" directive (if the
        // option is enabled).
        const lastStep = this.#forceFinalReply &&
          stepsThisTurn === this.#maxSteps - 1;
        const result = await this.#runOneStep(taskForPrompt, lastStep, turn);
        stepsThisTurn++;
        this.#freshStepCount++;
        if (result.kind === "reply") {
          this.#emit({ kind: "reply", message: result.message, turn, cause });
          this.#dispatchTurnEndToDreamers(result.message, "reply", turn);
          this.#turnUserInputs = [];
          return;
        }
        if (result.kind === "abort") {
          this.#emit({ kind: "abort", error: result.error, turn, cause });
          this.#dispatchTurnEndToDreamers(result.error, "abort", turn);
          this.#turnUserInputs = [];
          return;
        }
        // If the step terminated because a parent-issued cancel_step
        // unblocked an in-flight reflect(promise), the new user message
        // is already on the inbox. Stop the inner step loop so it gets
        // processed as its own turn, with the interrupt visible in
        // priorSteps. This is the only "non_terminal triggers turn end"
        // case.
        if (result.kind === "non_terminal" && result.interruptedByUserMessage) {
          // Don't fire turn_end — the turn was preempted, not terminated.
          // Userinputs stay; the preempting message will append.
          return;
        }
      }
      this.#emit({ kind: "exhausted", steps: this.#freshStepCount, turn, cause });
      this.#dispatchTurnEndToDreamers(
        `exhausted after ${this.#freshStepCount} steps`,
        "exhausted",
        turn,
      );
      this.#turnUserInputs = [];
    } catch (e) {
      this.#emit({
        kind: "abort",
        error: `agent loop error: ${(e as Error).message}`,
        turn,
        cause,
      });
      this.#turnUserInputs = [];
    }
  }

  async #runOneStep(taskForPrompt: string, lastStep: boolean, turn: number): Promise<
    { kind: "reply"; message: string }
    | { kind: "abort"; error: string }
    | { kind: "non_terminal"; interruptedByUserMessage?: boolean }
  > {
    const snapshot = await this.#sessionSnapshot();
    const prompt = PromptBuilder.build({
      task: taskForPrompt,
      tools: this.#tools.describe(),
      permissions: this.#permissions,
      session: snapshot,
      priorSteps: this.#priorSteps,
      // Persistent-session path always exposes timer-driven wakeups and
      // reflect(promise); teach the model about them.
      wakeupsEnabled: true,
      autoWakeOnTimer: this.#autoWakeOnTimer,
      lastStep,
    });

    const stepIndex = this.#resumedCount + this.#freshStepCount + 1;
    this.#emitPhase("generating", stepIndex);

    const completion = await generateText({
      model: this.#model,
      prompt,
    });

    // Missing-fence is recoverable: synthesize a `throw` event so the
    // model sees the error on the next turn and can retry. `maxSteps`
    // still bounds a chronically broken model. The synthetic event also
    // runs through guardrails — a policy watching `throw` (or `any`)
    // should fire whether the throw came from the sandbox or from the
    // extractor.
    let code: string;
    let rawEvent: SandboxEvent;
    try {
      code = CodeExtractor.extract(completion.text);
    } catch (e) {
      if (!(e instanceof NoCodeBlockError)) throw e;
      code = "";
      rawEvent = noCodeBlockEvent(completion.text);
      const event = await this.#applyGuardrails(
        rawEvent,
        code,
        stepIndex,
        taskForPrompt,
      );
      this.#dispatchToDreamers(event, code, completion.text, stepIndex, taskForPrompt, turn);
      return await this.#recordAndContinue(stepIndex, code, event);
    }

    this.#emitPhase("running", stepIndex);
    rawEvent = await this.#sandbox.runStep({ llmCode: code });

    // Guardrails run between the sandbox emitting an event and the host
    // seeing it. A blocking guardrail replaces the event with a
    // non-terminal `guardrail_blocked` step carrying the original
    // payload + reason; the loop keeps going so the model can revise.
    // The transcript / step / outbox all reflect the post-guardrail
    // event so resume readers see what really happened.
    const event = await this.#applyGuardrails(
      rawEvent,
      code,
      stepIndex,
      taskForPrompt,
    );

    // Dreamer fanout sits between guardrail eval and `recordAndContinue`
    // so dreamers see post-guardrail events, mirroring the per-step path
    // in agent.ts.
    this.#dispatchToDreamers(event, code, completion.text, stepIndex, taskForPrompt, turn);

    return await this.#recordAndContinue(stepIndex, code, event);
  }

  #dispatchToDreamers(
    event: SandboxEvent,
    code: string,
    llmCompletion: string,
    stepIndex: number,
    task: string,
    turn: number,
  ): void {
    const pool = this.#dreamPool;
    if (!pool) return;
    const payload: DreamPayload = {
      event,
      llmCompletion,
      code,
      stepIndex,
      task,
      userInputs: [...this.#turnUserInputs],
      turn,
    };
    if (!pool.hasMatch(payload)) return;
    pool.dispatch(payload);
  }

  /** Fire a synthetic-trigger payload (`user_message` / `turn_end`). The
   *  payload's `event` is a placeholder reflect-with-state describing
   *  what happened; the dreamer's prompt knows the synthetic-trigger
   *  shape via `renderPayloadAsUserMessage`. */
  #dispatchSyntheticToDreamers(
    kind: "user_message" | "turn_end",
    content: string,
    turn: number,
    extra?: { terminalKind?: "reply" | "abort" | "exhausted" },
  ): void {
    const pool = this.#dreamPool;
    if (!pool) return;
    const synthState = kind === "user_message"
      ? { __user_message: content }
      : { __turn_end: content, terminal: extra?.terminalKind ?? "reply" };
    const payload: DreamPayload = {
      event: { kind: "reflect", state: synthState, logs: [] },
      llmCompletion: "",
      code: "",
      stepIndex: this.#resumedCount + this.#freshStepCount + 1,
      task: this.#lastUserTask,
      userInputs: [...this.#turnUserInputs],
      turn,
      syntheticTrigger: kind,
    };
    if (!pool.hasMatch(payload)) return;
    pool.dispatch(payload);
  }

  /** Fire the `turn_end` synthetic trigger. Called from the turn loop
   *  on every terminal outcome (reply / abort / exhausted). */
  #dispatchTurnEndToDreamers(
    summary: string,
    terminalKind: "reply" | "abort" | "exhausted",
    turn: number,
  ): void {
    this.#dispatchSyntheticToDreamers("turn_end", summary, turn, { terminalKind });
  }

  /** Append the step to the transcript, fire `onStep` + outbox `step`
   *  event, push to prior history, and return a terminal `reply`/`abort`
   *  or a non-terminal continuation. Shared by the normal path and the
   *  missing-fence recovery path. */
  async #recordAndContinue(
    stepIndex: number,
    code: string,
    event: SandboxEvent,
  ): Promise<
    { kind: "reply"; message: string }
    | { kind: "abort"; error: string }
    | { kind: "non_terminal"; interruptedByUserMessage?: boolean }
  > {
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
    // Detect the interrupt-by-user-message synthetic reflect (set by
    // the prelude when a parent cancel_step landed during a
    // reflect(promise) wait). The state shape is fixed at the prelude
    // side: `{ __interrupted_by: <reason> }`.
    if (
      event.kind === "reflect" && event.state && typeof event.state === "object" &&
      // deno-lint-ignore no-explicit-any
      (event.state as any).__interrupted_by === "user_message"
    ) {
      return { kind: "non_terminal", interruptedByUserMessage: true };
    }
    return { kind: "non_terminal" };
  }

  async #applyGuardrails(
    rawEvent: SandboxEvent,
    code: string,
    stepIndex: number,
    taskForPrompt: string,
  ): Promise<SandboxEvent> {
    if (this.#guardrails.length === 0) return rawEvent;
    const evaluations = await GuardrailRunner.evaluate(this.#guardrails, {
      event: rawEvent,
      code,
      stepIndex,
      task: taskForPrompt,
      priorSteps: this.#priorSteps,
    });
    for (const e of evaluations) this.#emitGuardrail(e, stepIndex);
    const blocking = GuardrailRunner.firstBlock(evaluations);
    if (blocking === null) return rawEvent;
    return GuardrailRunner.blockedEvent(rawEvent, blocking);
  }

  #emitGuardrail(evaluation: GuardrailEvaluation, stepIndex: number): void {
    if (!this.#onGuardrail) return;
    try {
      this.#onGuardrail(evaluation, stepIndex);
    } catch { /* host callback errors are not fatal */ }
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

  /** Fire the optional onPhase callback. Errors are swallowed — phase is
   *  pure observability and a noisy host should never wedge a step. */
  #emitPhase(phase: AgentPhase, stepIndex: number): void {
    if (!this.#onPhase) return;
    try {
      this.#onPhase(phase, stepIndex);
    } catch { /* host callback errors are not fatal */ }
  }
}

// ── helpers (mirrors agent.ts; kept local so step 3 doesn't churn agent.ts) ──

import type { WakeupDescriptor } from "./persistent_sandbox.ts";

/** Build the synthetic `state` blob shown in the wakeup-driven turn's
 *  prior step. The prompt knows this shape and renders it inline. */
function buildWakeupReflectState(
  ev: Extract<LoopEvent, { kind: "wakeup_fired" }>,
  desc: WakeupDescriptor | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ev.wakeupKind === "promise") {
    // The promise resolved value lives in the actual reflect state of
    // the previous (real) step — there's nothing extra to inject here.
    // We only emit a wakeup_fired turn for the rejection case (the
    // success case is collapsed into the same step's reflect terminal).
    out.__wakeup = {
      id: ev.id,
      kind: "promise",
      status: ev.status,
      detail: ev.detail,
    };
    return out;
  }
  // Timer-driven (timeout / interval). `delayMs` is the configured
  // period from the original setTimeout/setInterval call (mirrored on
  // the descriptor), not elapsed wall time.
  out.__from_timer = {
    id: ev.id,
    kind: ev.wakeupKind,
    delayMs: desc?.delayMs ?? null,
  };
  if (ev.status === "rejected") {
    out.error = ev.detail;
    return out;
  }
  if (ev.payload?.intent) {
    out.translated_intent = {
      kind: ev.payload.intent.kind,
      [ev.payload.intent.kind === "reply" ? "message" : "error"]: ev.payload.intent.text,
    };
  }
  if (ev.payload && Object.prototype.hasOwnProperty.call(ev.payload, "state")) {
    out.callback_state = ev.payload.state;
  }
  return out;
}

/** Build a transcript entry for `ev`. Logs are preserved so guardrails on
 *  a resumed run see the same evidence the original step's prompt did. */
// deno-lint-ignore no-explicit-any
function summarizeEvent(ev: SandboxEvent): Record<string, any> {
  switch (ev.kind) {
    case "reply":
      return { message: ev.message, logs: ev.logs };
    case "abort":
      return { error: ev.error, logs: ev.logs };
    case "reflect":
      return { state: ev.state, logs: ev.logs };
    case "permission_denied":
      return { permission: ev.permission, target: ev.target, logs: ev.logs };
    case "throw":
      return { error: ev.error, logs: ev.logs };
    case "guardrail_blocked":
      return {
        guardrail: ev.guardrail,
        reason: ev.reason,
        originalKind: ev.originalKind,
        original: ev.original,
        logs: ev.logs,
      };
  }
}

function reconstructEvent(ev: Record<string, unknown>): SandboxEvent | null {
  const logs = reconstructLogs(ev.logs);
  switch (ev.kind) {
    case "reply":
      return { kind: "reply", message: String(ev.message ?? ""), logs };
    case "abort":
      return { kind: "abort", error: String(ev.error ?? ""), logs };
    case "reflect":
      return { kind: "reflect", state: ev.state, logs };
    case "permission_denied":
      return {
        kind: "permission_denied",
        permission: (ev.permission ?? "read") as SandboxEvent extends
          { kind: "permission_denied"; permission: infer P } ? P : never,
        target: String(ev.target ?? ""),
        logs,
      };
    case "throw":
      return { kind: "throw", error: String(ev.error ?? ""), logs };
    case "guardrail_blocked": {
      const original = reconstructGuardrailOriginal(
        ev.original,
        ev.originalKind,
      );
      return {
        kind: "guardrail_blocked",
        guardrail: String(ev.guardrail ?? "unknown"),
        reason: String(ev.reason ?? ""),
        originalKind: original.kind,
        original,
        logs,
      };
    }
    default:
      return null;
  }
}

/** Rehydrate a `SandboxLog[]` from a transcript entry's `logs` field.
 *  Tolerant of older transcripts (no `logs` → `[]`) and malformed
 *  entries (skipped). */
function reconstructLogs(raw: unknown): SandboxLog[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<SandboxLog["level"]>(["log", "info", "warn", "error", "debug"]);
  const out: SandboxLog[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const level = valid.has(e.level as SandboxLog["level"])
      ? (e.level as SandboxLog["level"])
      : "log";
    const args = Array.isArray(e.args) ? e.args : [];
    out.push({ level, args });
  }
  return out;
}

/** Rebuild the `original` payload on a guardrail_blocked transcript entry.
 *  Prefers the persisted `original` field; falls back to a minimal payload
 *  derived from `originalKind` when the transcript predates the field. */
function reconstructGuardrailOriginal(
  raw: unknown,
  originalKindRaw: unknown,
): GuardrailBlockedOriginal {
  const allowed = new Set<GuardrailBlockedOriginal["kind"]>([
    "reply",
    "abort",
    "reflect",
    "permission_denied",
    "throw",
  ]);
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.kind === "string" && allowed.has(o.kind as GuardrailBlockedOriginal["kind"])) {
      switch (o.kind) {
        case "reply":
          return { kind: "reply", message: String(o.message ?? "") };
        case "abort":
          return { kind: "abort", error: String(o.error ?? "") };
        case "reflect":
          return { kind: "reflect", state: o.state };
        case "permission_denied":
          return {
            kind: "permission_denied",
            permission: (o.permission ?? "read") as GuardrailBlockedOriginal extends
              { kind: "permission_denied"; permission: infer P } ? P : never,
            target: String(o.target ?? ""),
          };
        case "throw":
          return { kind: "throw", error: String(o.error ?? "") };
      }
    }
  }
  const k =
    typeof originalKindRaw === "string" &&
    allowed.has(originalKindRaw as GuardrailBlockedOriginal["kind"])
      ? (originalKindRaw as GuardrailBlockedOriginal["kind"])
      : "throw";
  switch (k) {
    case "reply":
      return { kind: "reply", message: "" };
    case "abort":
      return { kind: "abort", error: "" };
    case "reflect":
      return { kind: "reflect", state: undefined };
    case "permission_denied":
      return { kind: "permission_denied", permission: "read", target: "" };
    case "throw":
      return { kind: "throw", error: "" };
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
