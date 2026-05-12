// Shared types for the agent library.
//
// This file is the single source of truth for the discriminated unions that
// flow between Agent → Sandbox → Prelude → tool handlers, plus the typed
// errors users (and tools) can encounter.

import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { z } from "zod";
import type { GuardrailDefinition, GuardrailEvaluation } from "./guardrail.ts";

// ────────────────────────────────────────────────────────────────────────────
// Public surface (Agent options + result)
// ────────────────────────────────────────────────────────────────────────────

export interface PermissionsConfig {
  /** Hostnames the sandbox may reach. Empty / undefined → no net. */
  net?: string[];
  /** Filesystem read paths. `.rex/sessions/<id>` is auto-added. */
  read?: string[];
  /** Filesystem write paths. */
  write?: string[];
  /** Whether the sandbox may spawn subprocesses. MVP: boolean only. */
  run?: boolean;
  /** Module specifiers the sandbox may import. */
  modules?: string[];
}

export interface ToolDefinition<
  // deno-lint-ignore no-explicit-any
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TResult = unknown,
> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<TResult> | TResult;
  /** Optional override for what TS signature the LLM sees in the prompt. */
  tsSignature?: string;
}

export interface SizeCaps {
  /** Per-step cumulative log bytes. Default 64 KiB. */
  logBytes: number;
  /** Max bytes for a single `reflect(state)` JSON. Default 256 KiB. */
  reflectStateBytes: number;
  /** Max bytes for a single tool result JSON. Default 256 KiB. */
  toolResultBytes: number;
  /** Max bytes for `lib.ts` source. Default 64 KiB. */
  libBytes: number;
  /** Max bytes for storage.json total. Default 1 MiB. */
  storageBytes: number;
  /** Per-step wall-clock cap in ms. Default 60_000. */
  stepTimeoutMs: number;
  /** Wall-clock cap for awaiting a promise passed to `reflect(promise)`,
   *  in ms. Independent of `stepTimeoutMs` because the whole point of
   *  `reflect(promise)` is "I don't know how long this takes." Default
   *  300_000 (5 min). */
  reflectPromiseTimeoutMs: number;
}

export const DEFAULT_SIZE_CAPS: SizeCaps = {
  logBytes: 64 * 1024,
  reflectStateBytes: 256 * 1024,
  toolResultBytes: 256 * 1024,
  libBytes: 64 * 1024,
  storageBytes: 1024 * 1024,
  stepTimeoutMs: 60_000,
  reflectPromiseTimeoutMs: 5 * 60_000,
};

export interface StepRecord {
  /** 1-based index of the step within this run. */
  index: number;
  /** Whether this step came from the transcript (resume) or just executed. */
  source: "fresh" | "resumed";
  code: string;
  event: SandboxEvent;
}

/** Lifecycle phase of a single in-flight sandbox step.
 *
 *  - `generating`: the LLM call (`generateText`) is in flight. The agent
 *    is waiting on the model to produce code.
 *  - `running`: the model returned and the sandbox is now executing the
 *    extracted code.
 *
 *  Emitted via `AgentOptions.onPhase` so UIs (CLI spinner, IDE status
 *  bar, etc.) can show which phase the agent is in without polling. */
export type AgentPhase = "generating" | "running";

export interface ExperimentalOptions {
  /**
   * Run all steps inside a single persistent Deno subprocess for the
   * lifetime of `Agent.run()`, instead of spawning a fresh subprocess
   * per step. Required for the timer-based wakeup primitives
   * (`setTimeout` / `setInterval` / `reflect(promise)`) and the duplex
   * `AgentSession` surface. Default false.
   *
   * Behavior with this flag is intended to match the per-step path for
   * all currently-tested cases. Differences:
   *   - Permissions and module allowlist are fixed at session spawn.
   *   - V8 heap is bounded with `--v8-flags=--max-old-space-size=512`
   *     by default.
   */
  asyncWakeups?: boolean;
  /**
   * If true, every fire of an intercepted `setTimeout` / `setInterval`
   * callback automatically wakes the agent — the callback's return
   * value becomes the synthetic prior step's reflect state. Default
   * false: a callback only wakes the agent if it explicitly calls
   * `reflect` (or `reply` / `abort`, which are translated to reflect).
   *
   * Useful for monitoring loops that should always surface their
   * verdict; the default (silent) is better for cheap-predicate polls.
   * The LLM uses native `setTimeout` / `setInterval` either way — this
   * flag is a host-side policy, not exposed to the agent code.
   */
  autoWakeOnTimer?: boolean;
}

export interface AgentOptions {
  model: LanguageModelV2;
  task: string;
  // deno-lint-ignore no-explicit-any
  tools?: ToolDefinition<any, any>[];
  permissions?: PermissionsConfig;
  /** Persistent session id. Omit to use an ephemeral session. */
  sessionId?: string;
  /** Hard cap on agent loop iterations. Default 8. */
  maxSteps?: number;
  /** Override default size caps. */
  sizeCaps?: Partial<SizeCaps>;
  /** Root for `.rex/sessions/<id>/`. Defaults to cwd. */
  sessionsRoot?: string;
  /**
   * If true, replays `transcript.jsonl` as priorSteps when resuming a
   * session. Default false (state persists, history doesn't — original
   * §14a contract).
   */
  resumeHistory?: boolean;
  /**
   * Called after each step (both replayed-from-transcript and freshly-
   * executed). Useful for CLI / UI rendering. Awaited if it returns a
   * promise.
   */
  onStep?: (step: StepRecord) => void | Promise<void>;
  /**
   * Called before each fresh step transitions into a new phase
   * (`generating` then `running`). Lets a UI surface "where" the agent
   * is mid-step — useful for spinners that distinguish LLM latency from
   * sandbox latency. Not called for replayed-from-transcript steps.
   * Host callback errors are swallowed (this is observability only).
   */
  onPhase?: (phase: AgentPhase, stepIndex: number) => void;
  /**
   * When true (default), the prompt for the FINAL allowed step (the
   * `maxSteps`-th one within a turn) carries an explicit directive
   * telling the model it must `return reply(...)` or `return abort(...)`
   * — anything else ends the turn as `exhausted` with no answer to the user.
   *
   * Helpful when an agent has otherwise been making progress via
   * `reflect(...)` and would silently exhaust its step budget on the last
   * turn. Set to false to keep the legacy behavior (no directive,
   * exhaustion possible).
   */
  forceFinalReply?: boolean;
  /** Experimental, off by default. See `ExperimentalOptions`. */
  experimental?: ExperimentalOptions;
  /**
   * Guardrails — independent LLM checks that run on each sandbox step
   * and may veto the event. Use `defineGuardrail()` to construct one.
   * Each guardrail declares which event kinds it cares about and
   * receives an audit log of the conversation when triggered. A
   * blocking verdict replaces the original event with a non-terminal
   * `guardrail_blocked` step tagged with the guardrail's name + reason
   * and carrying the original payload; the agent loop pushes it to
   * prior history and runs another step so the model can revise.
   *
   * Guardrails fire AFTER the sandbox produces an event but BEFORE it
   * is written to the transcript or surfaced via `onStep`. The
   * transcript / step record therefore reflects the post-guardrail
   * event, so resume / replay sees the same thing the host did.
   */
  guardrails?: GuardrailDefinition[];
  /**
   * Optional observability hook called once per guardrail evaluation —
   * including evaluations that allowed the event. Useful for surfacing
   * guardrail activity in a CLI / UI without parsing the transcript.
   * Host callback errors are swallowed.
   */
  onGuardrail?: (
    evaluation: GuardrailEvaluation,
    stepIndex: number,
  ) => void;
}

export type RunResult =
  | { kind: "reply"; message: string }
  | { kind: "abort"; error: string }
  | { kind: "exhausted"; steps: number };

// ────────────────────────────────────────────────────────────────────────────
// AgentSession (experimental, behind asyncWakeups flag)
// ────────────────────────────────────────────────────────────────────────────

/** Inbound message the host sends into a session via `AgentSession.send`. */
export interface UserMessage {
  /** Always "user_message". Discriminator for future inbound kinds. */
  kind: "user_message";
  content: string;
}

/** Source of a turn's terminal event. `wakeup` is reserved for step 4+. */
export type TurnCause = "user" | "wakeup";

/** Event emitted on `AgentSession.events`. */
export type AgentEvent =
  | {
    kind: "step";
    /** 1-based step index across the session. */
    index: number;
    source: "fresh" | "resumed";
    code: string;
    event: SandboxEvent;
  }
  | {
    kind: "reply";
    message: string;
    /** 1-based turn index across the session (a turn = one user/wakeup
     *  cause, possibly multiple sandbox steps, ending in a terminal). */
    turn: number;
    cause: TurnCause;
  }
  | { kind: "abort"; error: string; turn: number; cause: TurnCause }
  | { kind: "exhausted"; steps: number; turn: number; cause: TurnCause }
  | {
    kind: "wakeup_scheduled";
    id: string;
    reason: string;
    wakeupKind: WakeupKind;
    /** Configured delay (ms) at registration time. Set for timer kinds
     *  to the `ms` arg passed to `setTimeout` / `setInterval`. Omitted
     *  for `promise` (no configured period). */
    delayMs?: number;
  }
  | { kind: "wakeup_resolved"; id: string; payload?: WakeupResolvedPayload }
  | { kind: "wakeup_rejected"; id: string; error: string }
  | { kind: "wakeup_cancelled"; id: string; reason: string }
  | { kind: "session_closed"; reason: string };

/** What kind of underlying primitive scheduled this wakeup. */
export type WakeupKind = "timeout" | "interval" | "promise";

/** Payload attached to a `wakeup_resolved` frame.
 *  - `state`: a value reflected by the callback (or returned, when the
 *    `autoWakeOnTimer` policy is on).
 *  - `intent`: a translated `reply` / `abort` from inside a callback,
 *    surfaced so the next turn's prompt can render it without firing
 *    the corresponding side effect from the callback context. */
export interface WakeupResolvedPayload {
  state?: unknown;
  intent?: { kind: "reply" | "abort"; text: string };
}

export interface AgentSession {
  /** Outbound stream of session events. Iteration ends after
   *  `session_closed` is emitted. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Inject a user message. Synchronous; queues for the worker. */
  send(msg: UserMessage): void;
  /** Cooperative shutdown. Drains the in-flight turn (if any), then
   *  emits `session_closed` and ends iteration. Idempotent. */
  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────
// Sandbox events (parent's view of one step)
// ────────────────────────────────────────────────────────────────────────────

export type SandboxLog = {
  level: "log" | "info" | "warn" | "error" | "debug";
  // deno-lint-ignore no-explicit-any
  args: any[];
};

export type PermissionKind = "net" | "read" | "write" | "run" | "env" | "ffi" | "sys";

export type SandboxEvent =
  | { kind: "reply"; message: string; logs: SandboxLog[] }
  | { kind: "abort"; error: string; logs: SandboxLog[] }
  | { kind: "reflect"; state: unknown; logs: SandboxLog[] }
  | {
    kind: "permission_denied";
    permission: PermissionKind;
    target: string;
    logs: SandboxLog[];
  }
  | { kind: "throw"; error: string; logs: SandboxLog[] }
  /**
   * Synthetic event produced when a guardrail BLOCKS the sandbox's
   * original event. Non-terminal: the agent loop pushes it to prior
   * history and runs another step so the model can revise. The host
   * sees it via onStep / the transcript like any other event; only the
   * agent loop's terminal-event check (reply / abort) ignores it.
   *
   * `originalKind` is the kind the sandbox actually produced — useful
   * when the policy reason references the rejected output (e.g.
   * "your reply was…" vs "your reflect was…").
   *
   * `original` carries the full original event payload (minus logs —
   * those live on the parent `guardrail_blocked` event's `logs` field).
   * Observers and the next prompt can render exactly what was blocked
   * so the model knows specifically what to revise.
   */
  | {
    kind: "guardrail_blocked";
    guardrail: string;
    reason: string;
    originalKind: GuardrailBlockedOriginal["kind"];
    original: GuardrailBlockedOriginal;
    logs: SandboxLog[];
  };

/** Original event payload preserved on a `guardrail_blocked` event.
 *  Same shape as the corresponding `SandboxEvent` variant, minus `logs`
 *  (those are kept once on the parent `guardrail_blocked` event). */
export type GuardrailBlockedOriginal =
  | { kind: "reply"; message: string }
  | { kind: "abort"; error: string }
  | { kind: "reflect"; state: unknown }
  | { kind: "permission_denied"; permission: PermissionKind; target: string }
  | { kind: "throw"; error: string };

// ────────────────────────────────────────────────────────────────────────────
// RPC frames (parent ↔ child)
// ────────────────────────────────────────────────────────────────────────────

// Child → Parent (wakeup lifecycle, persistent-sandbox only)
export interface FrameWakeupScheduled {
  type: "wakeup_scheduled";
  id: string;
  reason: string;
  /** Source primitive: `setTimeout` / `setInterval` (timer-based) or an
   *  unwrapped `reflect(promise)` (`promise`). */
  wakeupKind: WakeupKind;
  /** Configured delay (ms) at registration time. Set for timer kinds
   *  to the `ms` argument passed to `setTimeout` / `setInterval`. Omitted
   *  for `promise` (no configured period — the promise dictates timing). */
  delayMs?: number;
}
export interface FrameWakeupResolved {
  type: "wakeup_resolved";
  id: string;
  /** Optional payload describing what (if anything) the callback wants
   *  to surface to the agent on the next turn. Absent for a silent
   *  tick (the timer fired but the callback did not call any control
   *  fn and `autoWakeOnTimer` is off — in which case we skip emitting
   *  this frame entirely on the child side). */
  payload?: WakeupResolvedPayload;
}
export interface FrameWakeupRejected {
  type: "wakeup_rejected";
  id: string;
  error: string;
}
export interface FrameWakeupCancelled {
  type: "wakeup_cancelled";
  id: string;
  reason: string;
}

// Child → Parent (one-shot terminal events)
export interface FrameReply {
  type: "reply";
  message: string;
}
export interface FrameAbort {
  type: "abort";
  error: string;
}
export interface FrameReflect {
  type: "reflect";
  state: unknown;
}
export interface FramePermissionDenied {
  type: "permission_denied";
  permission: PermissionKind;
  target: string;
}
export interface FrameThrow {
  type: "throw";
  error: string;
}
export interface FrameLog {
  type: "log";
  level: SandboxLog["level"];
  // deno-lint-ignore no-explicit-any
  args: any[];
}

// Child → Parent (request/response style — child awaits a *_result)
export interface FrameToolCall {
  type: "tool_call";
  id: string;
  name: string;
  args: unknown;
}
export interface FrameStorageGet {
  type: "storage_get";
  id: string;
  key: string;
}
export interface FrameStorageSet {
  type: "storage_set";
  id: string;
  key: string;
  value: unknown;
}
export interface FrameStorageDel {
  type: "storage_del";
  id: string;
  key: string;
}
export interface FrameStorageKeys {
  type: "storage_keys";
  id: string;
}
export interface FrameWriteLib {
  type: "write_lib";
  id: string;
  source: string;
}

// Parent → Child (responses)
export interface FrameToolResult {
  type: "tool_result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export interface FrameStorageResult {
  type: "storage_result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export interface FrameWriteLibResult {
  type: "write_lib_result";
  id: string;
  ok: boolean;
  error?: string;
}
/** Parent → Child request to interrupt the in-flight step. Currently
 *  used to cut short an awaited `reflect(promise)` when the host
 *  injects a user message — the prelude resolves the wait with an
 *  `__interrupted_by` sentinel and dispatches the original reflect
 *  with that payload as state. */
export interface FrameCancelStep {
  type: "cancel_step";
  reason: string;
}

export type ChildFrame =
  | FrameReply
  | FrameAbort
  | FrameReflect
  | FramePermissionDenied
  | FrameThrow
  | FrameLog
  | FrameToolCall
  | FrameStorageGet
  | FrameStorageSet
  | FrameStorageDel
  | FrameStorageKeys
  | FrameWriteLib
  | FrameWakeupScheduled
  | FrameWakeupResolved
  | FrameWakeupRejected
  | FrameWakeupCancelled;

export type ParentFrame =
  | FrameToolResult
  | FrameStorageResult
  | FrameWriteLibResult
  | FrameCancelStep;

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

/** Thrown by `CodeExtractor.extract` when no ts/typescript fence is found. */
export class NoCodeBlockError extends Error {
  constructor(message = "no ts/typescript code block found in model output") {
    super(message);
    this.name = "NoCodeBlockError";
  }
}

/** Thrown inside the sandbox when a tool call fails (incl. zod validation). */
export class ToolError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

/** Returned to the sandbox when a tool result exceeds the size cap.
 *
 *  Extends `ToolError` so a single `catch (e) { if (e instanceof ToolError) }`
 *  in agent code handles both validation failures and oversize results.
 *  `instanceof ToolResultTooLargeError` still works for callers that want
 *  to discriminate. */
export class ToolResultTooLargeError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = "ToolResultTooLargeError";
  }
}

/** Returned to the sandbox when `writeLib` is rejected. */
export class WriteLibError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteLibError";
  }
}

/** Thrown by `Agent.run` when another run is already holding the session lock. */
export class SessionLockedError extends Error {
  constructor(sessionId: string, holderPid: number | null) {
    super(
      `session "${sessionId}" is locked${holderPid !== null ? ` by pid ${holderPid}` : ""}`,
    );
    this.name = "SessionLockedError";
  }
}

/** Reserved tool / global names — Agent rejects user tools that collide.
 *
 *  This list MUST stay in sync with the globals installed by the
 *  prelude(s). Adding a new global to either prelude requires adding
 *  the name here, otherwise a user tool with the same name would
 *  silently clobber the prelude declaration. */
export const RESERVED_NAMES = [
  "reply",
  "abort",
  "reflect",
  "writeLib",
  "storage",
  "console",
  // prelude_v2 only (gated on `experimental.asyncWakeups`):
  "tasks",
  // prelude_v2 wraps the standard timer globals to drive wakeups; a
  // user-defined tool with one of these names would clobber the
  // wrapper and silently disable the interception:
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
] as const;

// ────────────────────────────────────────────────────────────────────────────
// Trace events (observability — emitted by Tracer, defined in src/trace.ts)
// ────────────────────────────────────────────────────────────────────────────

/** Envelope fields stamped onto every trace event by `Tracer.emit`. */
export interface TraceEventEnvelope {
  /** Monotonically increasing milliseconds since `Tracer` construction. */
  ts: number;
  /** Monotonically increasing per-Tracer sequence (starts at 0). */
  seq: number;
}

/**
 * Discriminated union of every structured event the Tracer fans out. The
 * Tracer fills in `ts` and `seq`; producers pass the variant fields minus
 * the envelope (see `TraceEventInput` in `src/trace.ts`).
 *
 * Re-exported from this module so callers can `import type { TraceEvent }
 * from "rex/types"` without reaching into the trace module's internals.
 */
export type TraceEvent = TraceEventEnvelope & (
  | {
    type: "run_started";
    task: string;
    maxSteps: number;
    sessionId: string | null;
  }
  | { type: "step_started"; index: number }
  | { type: "sandbox_spawned"; index: number; pid?: number }
  | {
    type: "tool_call_started";
    index: number;
    callId: string;
    name: string;
    argsBytes: number;
  }
  | {
    type: "tool_call_finished";
    index: number;
    callId: string;
    name: string;
    ok: boolean;
    /** Bytes of the JSON-encoded result. Omitted when `ok=false`. */
    resultBytes?: number;
    /** Error message when `ok=false`. */
    error?: string;
    durationMs: number;
  }
  | {
    type: "storage_op";
    index: number;
    op: "get" | "set" | "del" | "keys";
    /** Key the op was applied to. `null` for `keys` (no key). */
    key: string | null;
    ok: boolean;
  }
  | {
    type: "write_lib";
    index: number;
    ok: boolean;
    sourceBytes: number;
  }
  | {
    type: "sandbox_log";
    index: number;
    level: SandboxLog["level"];
  }
  | {
    type: "permission_denied";
    index: number;
    permission: PermissionKind;
    target: string;
  }
);
