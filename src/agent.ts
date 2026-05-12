// Agent — orchestrates the code-action loop.
//
// Per §4:
//   step = 0; while step < maxSteps:
//     completion = generateText({ model, prompt })
//     code = CodeExtractor.extract(completion.text)
//     event = await Sandbox.run(code, ...)
//     dispatch on event.kind:
//       reply      → return { kind: "reply", ... }
//       abort      → return { kind: "abort", ... }
//       reflect / permission_denied / throw → record step, ++step, loop
//   return { kind: "exhausted", steps }
//
// History strategy is option B from §8: re-render the full prompt each
// step with the accumulated prior steps + current session state. We use the
// AI SDK's simple `prompt` form rather than chat messages — the prompt
// builder already produces the complete instruction.
//
// Internal shape (since async-wakeup-mode redesign): the loop is driven by
// a queue of `LoopEvent`s. Each event triggers an inner sandbox-step loop
// that runs until a terminal frame or a per-turn step cap. Step 1 of the
// async-wakeup plan only ever produces one event (the initial task), so
// behavior is identical to the previous implementation. Later steps add
// user-message and wakeup events to the same queue.

import { generateText } from "ai";
import { AgentSessionImpl } from "./agent_session.ts";
import {
  DreamPool,
  type DreamerDefinition,
  type DreamPayload,
} from "./dreamer.ts";
import { CodeExtractor, noCodeBlockEvent } from "./extractor.ts";
import {
  type GuardrailDefinition,
  type GuardrailEvaluation,
  GuardrailRunner,
} from "./guardrail.ts";
import { PromptBuilder, type PriorStep, type SessionSnapshot } from "./prompt.ts";
import { Sandbox } from "./sandbox.ts";
import { SessionStore } from "./session.ts";
import { ToolRegistry } from "./tools.ts";
import {
  type AgentOptions,
  type AgentPhase,
  type AgentSession,
  DEFAULT_SIZE_CAPS,
  type GuardrailBlockedOriginal,
  NoCodeBlockError,
  type RunResult,
  type SandboxEvent,
  type SandboxLog,
  type SizeCaps,
} from "./types.ts";

/** Internal: events that drive the session loop. Step 1 only emits
 *  `user_task`; later phases will add `user_message` and `wakeup_fired`.
 *  `#runOneStep` reads from this so each event kind can contribute its
 *  own context to the next prompt without `#opts.task` being the only
 *  source of truth. */
type LoopEvent = { kind: "user_task"; task: string };

/** Internal: mutable state threaded through the loop. */
interface LoopState {
  priorSteps: PriorStep[];
  /** Number of steps replayed from a transcript on resume. Used only for
   *  the 1-based `index` field on `StepRecord` so callers can distinguish
   *  resumed from fresh steps. */
  resumedCount: number;
  /** Steps actually executed during this `run()` (i.e. fresh, not resumed).
   *  Drives the `maxSteps` exhaustion check and the `RunResult.exhausted`
   *  count returned to the caller. */
  freshStepCount: number;
  /** Set by `#dispatchEvent` when a terminal RunResult is produced —
   *  reply, abort, or exhausted. The outer loop stops dispatching events
   *  once this is non-null. */
  terminal: RunResult | null;
}

export class Agent {
  readonly #opts: AgentOptions;
  readonly #tools: ToolRegistry;
  readonly #sizeCaps: SizeCaps;
  readonly #maxSteps: number;
  readonly #forceFinalReply: boolean;
  readonly #guardrails: GuardrailDefinition[];
  readonly #dreamers: DreamerDefinition[];

  constructor(opts: AgentOptions) {
    if (typeof opts.task !== "string" || opts.task.length === 0) {
      throw new Error("Agent: `task` must be a non-empty string");
    }
    if (!opts.model) {
      throw new Error("Agent: `model` is required");
    }
    this.#opts = opts;
    // ToolRegistry constructor enforces reserved names + dupes + identifier rules.
    this.#tools = new ToolRegistry(opts.tools ?? []);
    this.#sizeCaps = { ...DEFAULT_SIZE_CAPS, ...(opts.sizeCaps ?? {}) };
    const ms = opts.maxSteps ?? 8;
    if (!Number.isInteger(ms) || ms < 1) {
      throw new Error("Agent: `maxSteps` must be a positive integer");
    }
    this.#maxSteps = ms;
    this.#forceFinalReply = opts.forceFinalReply ?? true;
    // Snapshot so a later mutation to the caller's array doesn't change
    // behavior mid-run. Names need not be unique — multiple guardrails
    // with the same name are legal (different models, different prompts).
    this.#guardrails = [...(opts.guardrails ?? [])];
    this.#dreamers = [...(opts.dreamers ?? [])];
  }

  /**
   * Open a long-lived duplex session. Requires
   * `experimental.asyncWakeups: true`. The session emits events on
   * `events`, accepts user messages via `send`, and is closed via
   * `close()`. The first turn is driven by `opts.task`; subsequent
   * turns are driven by `send()` (and, in step 4+, by wakeups).
   */
  async openSession(): Promise<AgentSession> {
    if (this.#opts.experimental?.asyncWakeups !== true) {
      throw new Error(
        "Agent.openSession requires `experimental.asyncWakeups: true`",
      );
    }
    return await AgentSessionImpl.open({
      model: this.#opts.model,
      task: this.#opts.task,
      tools: this.#tools,
      permissions: this.#opts.permissions,
      sizeCaps: this.#sizeCaps,
      maxSteps: this.#maxSteps,
      resumeHistory: this.#opts.resumeHistory ?? false,
      sessionId: this.#opts.sessionId,
      sessionsRoot: this.#opts.sessionsRoot,
      onStep: this.#opts.onStep,
      onPhase: this.#opts.onPhase,
      autoWakeOnTimer: this.#opts.experimental?.autoWakeOnTimer === true,
      forceFinalReply: this.#forceFinalReply,
      guardrails: this.#guardrails,
      onGuardrail: this.#opts.onGuardrail,
      dreamers: this.#dreamers,
      onDream: this.#opts.onDream,
      awaitDreamsOnClose: this.#opts.awaitDreamsOnClose === true,
      extraReadOnlyPaths: this.#opts.extraReadOnlyPaths,
    });
  }

  async run(): Promise<RunResult> {
    // When `asyncWakeups` is on, run() is a thin wrapper around
    // openSession that returns on the first terminal turn. The session
    // (and its persistent sandbox) is closed before returning.
    if (this.#opts.experimental?.asyncWakeups === true) {
      return await this.#runViaSession();
    }
    return await this.#runPerStep();
  }

  async #runViaSession(): Promise<RunResult> {
    const session = await this.openSession();
    let terminal: RunResult | null = null;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          terminal = { kind: "reply", message: ev.message };
          break;
        }
        if (ev.kind === "abort") {
          terminal = { kind: "abort", error: ev.error };
          break;
        }
        if (ev.kind === "exhausted") {
          terminal = { kind: "exhausted", steps: ev.steps };
          break;
        }
        // step / session_closed: keep iterating
      }
    } finally {
      await session.close();
    }
    return terminal ?? { kind: "exhausted", steps: 0 };
  }

  async #runPerStep(): Promise<RunResult> {
    const session = await SessionStore.open({
      sessionId: this.#opts.sessionId,
      rootDir: this.#opts.sessionsRoot,
      sizeCaps: this.#sizeCaps,
    });

    // DreamPool lifetime is bounded by this run. It opens after the
    // parent SessionStore (so the parent dir exists for the readonly
    // mount) and closes before the parent session closes (so the
    // dreamer's own SessionStore inside <parent>/dreams/ releases its
    // lock first). Cleanup is in `finally` to handle abort paths.
    let dreamPool: DreamPool | null = null;
    if (this.#dreamers.length > 0) {
      try {
        dreamPool = await DreamPool.open({
          parentSession: session,
          dreamers: this.#dreamers,
          onDream: this.#opts.onDream,
        });
      } catch (e) {
        // A failure here is a configuration error — don't proceed with
        // half-attached dreamers, abort the run cleanly so the caller
        // sees the exact reason.
        try { await session.close(); } catch { /* */ }
        throw e;
      }
    }
    this.#activeDreamPool = dreamPool;

    try {
      const state: LoopState = {
        priorSteps: [],
        resumedCount: 0,
        freshStepCount: 0,
        terminal: null,
      };

      if (this.#opts.resumeHistory) {
        await this.#replayTranscript(session, state);
      }

      const queue: LoopEvent[] = [{ kind: "user_task", task: this.#opts.task }];

      while (state.terminal === null && queue.length > 0) {
        const ev = queue.shift()!;
        await this.#dispatchEvent(ev, session, state);
      }

      // If the queue drained without anything setting `terminal`, the run
      // is exhausted. (`#dispatchEvent` already sets the exhausted result
      // when it hits the cap, so this branch is currently defensive.)
      return state.terminal ?? { kind: "exhausted", steps: state.freshStepCount };
    } finally {
      // Close dreamers BEFORE the parent session — the dreamer's own
      // SessionStore lives under the parent dir, so closing the parent
      // first would leave the dreamer's lock orphaned.
      if (dreamPool) {
        try {
          await dreamPool.close({
            awaitDrain: this.#opts.awaitDreamsOnClose === true,
          });
        } catch { /* dreamer cleanup errors are non-fatal */ }
      }
      this.#activeDreamPool = null;
      await session.close();
    }
  }

  /** Active DreamPool for the current run. Used by `#applyGuardrails`
   *  to dispatch post-guardrail events without threading the pool
   *  through every method. Cleared in `finally` so a follow-up run
   *  can't fan out to a closed pool. */
  #activeDreamPool: DreamPool | null = null;

  /** Drives the inner sandbox-step loop for a single event. Stops when a
   *  step returns a terminal frame OR the per-turn `maxSteps` cap is hit.
   *  In both cases `state.terminal` is set before returning. */
  async #dispatchEvent(
    ev: LoopEvent,
    session: SessionStore,
    state: LoopState,
  ): Promise<void> {
    while (state.freshStepCount < this.#maxSteps && state.terminal === null) {
      const terminal = await this.#runOneStep(ev, session, state);
      state.freshStepCount++;
      if (terminal !== null) {
        state.terminal = terminal;
        return;
      }
    }
    if (state.terminal === null) {
      state.terminal = { kind: "exhausted", steps: state.freshStepCount };
    }
  }

  /** Run a single sandbox step. Returns the terminal `RunResult` if the
   *  step ended in reply/abort, or `null` if it was non-terminal (in which
   *  case the step has been pushed to `state.priorSteps`). A missing
   *  code fence is recoverable: it surfaces as a synthetic `throw` step
   *  the model sees on the next turn. Other extractor or sandbox
   *  failures still bubble. */
  async #runOneStep(
    ev: LoopEvent,
    session: SessionStore,
    state: LoopState,
  ): Promise<RunResult | null> {
    const snapshot = await this.#sessionSnapshot(session);
    // `ev` only carries `user_task` today; reading `ev.task` here makes the
    // shape ready for `user_message` / `wakeup_fired` events to inject their
    // own prompt context in step 2 without changing this site again.
    // freshStepCount is the count of fresh steps ALREADY executed in this
    // run. The step we're about to run is the (freshStepCount + 1)-th. So
    // when freshStepCount === maxSteps - 1, this is the final allowed step.
    const lastStep = this.#forceFinalReply &&
      state.freshStepCount === this.#maxSteps - 1;
    const prompt = PromptBuilder.build({
      task: ev.task,
      tools: this.#tools.describe(),
      permissions: this.#opts.permissions,
      session: snapshot,
      priorSteps: state.priorSteps,
      lastStep,
    });

    const stepIndex = state.resumedCount + state.freshStepCount + 1;
    emitPhase(this.#opts.onPhase, "generating", stepIndex);

    const completion = await generateText({
      model: this.#opts.model,
      prompt,
    });

    // Missing-fence is recoverable: synthesize a `throw` event and let
    // the model retry on the next turn. The prompt's prior-steps section
    // feeds the error back so the model can self-correct. The synthetic
    // event still goes through guardrails — a policy that watches
    // `throw` (or `any`) should fire whether the throw came from the
    // sandbox or from the extractor. Other extractor failures (none
    // today) would still bubble.
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
        ev.task,
        state.priorSteps,
      );
      this.#dispatchToDreamers(event, code, completion.text, stepIndex, ev.task);
      return await this.#recordStep(session, state, stepIndex, code, event);
    }

    emitPhase(this.#opts.onPhase, "running", stepIndex);

    rawEvent = await Sandbox.run({
      llmCode: code,
      tools: this.#tools,
      session,
      permissions: this.#opts.permissions,
      sizeCaps: this.#sizeCaps,
      extraReadOnlyPaths: this.#opts.extraReadOnlyPaths,
    });

    // Guardrail evaluation happens between the sandbox emitting an event
    // and the host seeing it. A blocking guardrail replaces the event
    // with a non-terminal `guardrail_blocked` step (carrying the original
    // payload + reason) so the loop can keep going and the model gets
    // another chance to revise. The transcript / onStep / return value
    // all reflect the post-guardrail event so resume readers see what
    // really happened.
    const event = await this.#applyGuardrails(
      rawEvent,
      code,
      stepIndex,
      ev.task,
      state.priorSteps,
    );

    // Dreamer fanout sits BETWEEN guardrail evaluation and `#recordStep`
    // so dreamers see post-guardrail events (matches plan §3). The call
    // is sync-enqueue + fire-and-forget; the parent loop never waits.
    this.#dispatchToDreamers(event, code, completion.text, stepIndex, ev.task);

    return await this.#recordStep(session, state, stepIndex, code, event);
  }

  /** Build a `DreamPayload` and dispatch it to the active DreamPool.
   *  No-op when no pool is open or no dreamers match. Synchronous —
   *  the worker LLM call happens out-of-band on its own task. */
  #dispatchToDreamers(
    event: SandboxEvent,
    code: string,
    llmCompletion: string,
    stepIndex: number,
    task: string,
  ): void {
    const pool = this.#activeDreamPool;
    if (!pool) return;
    const payload: DreamPayload = {
      event,
      llmCompletion,
      code,
      stepIndex,
      task,
      // Per-step Agent has only one user input (the initial task), no
      // subsequent user_message turns. Turn is always 1.
      userInputs: [{ kind: "task", content: task, turn: 1 }],
      turn: 1,
    };
    if (!pool.hasMatch(payload)) return;
    pool.dispatch(payload);
  }

  /** Append the step to the transcript, fire `onStep`, and return either a
   *  terminal `RunResult` (reply/abort) or `null` after pushing the step
   *  to `state.priorSteps` to keep looping. Shared by the normal path and
   *  the missing-fence recovery path. */
  async #recordStep(
    session: SessionStore,
    state: LoopState,
    stepIndex: number,
    code: string,
    event: SandboxEvent,
  ): Promise<RunResult | null> {
    // Always log the step to the transcript for resume / audit.
    await session.appendTranscript({
      step: stepIndex,
      code,
      event: { kind: event.kind, ...summarizeEvent(event) },
    });

    // Notify the caller (CLI / UI) before returning, so it sees the
    // terminal step too.
    await this.#opts.onStep?.({
      index: stepIndex,
      source: "fresh",
      code,
      event,
    });

    if (event.kind === "reply") {
      return { kind: "reply", message: event.message };
    }
    if (event.kind === "abort") {
      return { kind: "abort", error: event.error };
    }

    // Non-terminal: record and signal "keep looping".
    state.priorSteps.push({ code, event });
    return null;
  }

  /** Run the configured guardrails against the raw sandbox event. Returns
   *  the original event when no guardrail blocks; otherwise a non-terminal
   *  `guardrail_blocked` event tagged with the guardrail's name + reason
   *  and carrying the original payload. Each evaluation is forwarded to
   *  `onGuardrail` for observability (errors swallowed). */
  async #applyGuardrails(
    rawEvent: SandboxEvent,
    code: string,
    stepIndex: number,
    task: string,
    priorSteps: PriorStep[],
  ): Promise<SandboxEvent> {
    if (this.#guardrails.length === 0) return rawEvent;
    const evaluations = await GuardrailRunner.evaluate(this.#guardrails, {
      event: rawEvent,
      code,
      stepIndex,
      task,
      priorSteps,
    });
    for (const e of evaluations) emitGuardrail(this.#opts.onGuardrail, e, stepIndex);
    const blocking = GuardrailRunner.firstBlock(evaluations);
    if (blocking === null) return rawEvent;
    return GuardrailRunner.blockedEvent(rawEvent, blocking);
  }

  /** Replay transcript.jsonl as priorSteps. Lets a CLI/UI continue a
   *  conversation: state already comes back from disk (lib.ts +
   *  storage.json); resumeHistory adds the transcript on top. */
  async #replayTranscript(session: SessionStore, state: LoopState): Promise<void> {
    const replay = await loadPriorStepsFromTranscript(session);
    for (const step of replay) {
      state.priorSteps.push(step);
      state.resumedCount++;
      await this.#opts.onStep?.({
        index: state.resumedCount,
        source: "resumed",
        code: step.code,
        event: step.event,
      });
    }
  }

  async #sessionSnapshot(session: SessionStore): Promise<SessionSnapshot> {
    const [libSource, libExports] = await Promise.all([
      session.readLib(),
      session.libExports(),
    ]);
    return {
      libExports,
      libSource,
      storageKeys: session.storageKeys(),
    };
  }
}

/** Fire the optional onPhase callback. Errors are swallowed — phase is
 *  pure observability and a noisy host should never wedge a step. */
function emitPhase(
  cb: ((p: AgentPhase, idx: number) => void) | undefined,
  phase: AgentPhase,
  stepIndex: number,
): void {
  if (!cb) return;
  try {
    cb(phase, stepIndex);
  } catch { /* host callback errors are not fatal */ }
}

/** Fire the optional onGuardrail callback. Errors are swallowed — this is
 *  observability only; a host's noisy callback shouldn't change the
 *  agent's policy outcome. */
function emitGuardrail(
  cb: ((e: GuardrailEvaluation, idx: number) => void) | undefined,
  evaluation: GuardrailEvaluation,
  stepIndex: number,
): void {
  if (!cb) return;
  try {
    cb(evaluation, stepIndex);
  } catch { /* host callback errors are not fatal */ }
}

/** Build a transcript entry for `ev`. Logs are preserved so guardrails on
 *  a resumed run see the same evidence the original step's prompt did.
 *  (Earlier versions stripped logs to keep the JSONL small; that left
 *  resume-mode guardrails blind. If transcript bulk becomes a concern,
 *  cap the per-step log byte budget at the SizeCaps level rather than
 *  dropping logs here.) */
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

/** Reconstruct PriorStep[] from a session's transcript.jsonl. Logs are
 *  persisted on each entry, so resumed steps come back with full logs —
 *  guardrails on a resumed run see the same evidence the live run did. */
async function loadPriorStepsFromTranscript(session: SessionStore): Promise<PriorStep[]> {
  const raw = await session.loadTranscript();
  const out: PriorStep[] = [];
  for (const entry of raw) {
    const code = typeof entry.code === "string" ? entry.code : "";
    const ev = entry.event as Record<string, unknown> | undefined;
    if (!code || !ev || typeof ev.kind !== "string") continue;
    const event = reconstructEvent(ev);
    if (event) out.push({ code, event });
  }
  return out;
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
 *  Tolerant of older transcripts that omit `logs` (returns `[]`) and of
 *  individual entries with the wrong shape (those are dropped). */
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
  // Older transcript entries (pre-`original`-field) only carry
  // `originalKind`; synthesize an empty-payload variant so resume still
  // works. The original payload is irretrievable in that case.
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
