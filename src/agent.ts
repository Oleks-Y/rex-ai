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
import { CodeExtractor } from "./extractor.ts";
import { PromptBuilder, type PriorStep, type SessionSnapshot } from "./prompt.ts";
import { Sandbox } from "./sandbox.ts";
import { SessionStore } from "./session.ts";
import { ToolRegistry } from "./tools.ts";
import {
  type AgentOptions,
  type AgentSession,
  DEFAULT_SIZE_CAPS,
  type RunResult,
  type SandboxEvent,
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
      await session.close();
    }
  }

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
   *  case the step has been pushed to `state.priorSteps`). Throws on
   *  unrecoverable errors (e.g. NoCodeBlockError from extractor). */
  async #runOneStep(
    ev: LoopEvent,
    session: SessionStore,
    state: LoopState,
  ): Promise<RunResult | null> {
    const snapshot = await this.#sessionSnapshot(session);
    // `ev` only carries `user_task` today; reading `ev.task` here makes the
    // shape ready for `user_message` / `wakeup_fired` events to inject their
    // own prompt context in step 2 without changing this site again.
    const prompt = PromptBuilder.build({
      task: ev.task,
      tools: this.#tools.describe(),
      permissions: this.#opts.permissions,
      session: snapshot,
      priorSteps: state.priorSteps,
    });

    const completion = await generateText({
      model: this.#opts.model,
      prompt,
    });

    // CodeExtractor throws NoCodeBlockError on missing fence — that's a
    // hard fail per §10. Caller catches if they want to.
    const code = CodeExtractor.extract(completion.text);

    const event = await Sandbox.run({
      llmCode: code,
      tools: this.#tools,
      session,
      permissions: this.#opts.permissions,
      sizeCaps: this.#sizeCaps,
    });

    const stepIndex = state.resumedCount + state.freshStepCount + 1;

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

/** Strip the heavy `logs` field from transcript entries — they go to the
 *  prompt for the *next* step, but persisting them in the JSONL transcript
 *  adds bulk without much resume value. Keep one summary per kind. */
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

/** Reconstruct PriorStep[] from a session's transcript.jsonl. Logs are not
 *  persisted to the transcript, so resumed steps come back with empty logs. */
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
