// Dreamers — side-channel observer agents attached to a parent `Agent` run.
//
// Mental model: a dreamer watches the parent agent's lived steps and produces
// a parallel, asynchronous narrative without changing the original timeline.
// It owns its own sandbox, model, task instructions, and workspace; the only
// thing it borrows from the parent is read-only visibility into the parent's
// session directory and a stream of trigger payloads (the post-guardrail
// event + the LLM completion that produced this step + the user inputs that
// drove the turn).
//
// Key semantics:
//   - Triggers reuse `GuardrailTrigger` plus two dreamer-only kinds
//     (`user_message`, `turn_end`).
//   - Non-blocking: dispatch is an O(1) sync enqueue at the guardrail
//     wire-point; the parent never waits on a dreamer.
//   - Stateful: each dreamer runs as a single long-lived `Agent` (in
//     async-wakeup mode) so it accumulates context across fires, which is
//     what makes "follow the workflow" useful.
//   - Isolated: the dreamer's outputs go to
//     `.rex/sessions/<parent>/dreams/<name>/`. The dreamer can read the
//     parent's session dir but never write to it.
//
// This module ships the types + `defineDreamer` factory only. Runtime
// (DreamPool, DreamWorker, queue, wire-up) lands in subsequent PRs — see
// `docs/plans/dreaming-agents.md`.

import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { GuardrailTrigger } from "./guardrail.ts";
import type {
  PermissionsConfig,
  SandboxEvent,
  SizeCaps,
  ToolDefinition,
} from "./types.ts";

/** Triggers a dreamer can subscribe to. Strict superset of
 *  `GuardrailTrigger` — the sandbox-event kinds are identical, plus two
 *  conversation-level kinds that guardrails cannot observe:
 *
 *   - `"user_message"` fires when a user message arrives in async-wakeup
 *     mode, BEFORE the model generates a response. Useful for ticket
 *     drafts that should capture the user's intent verbatim.
 *   - `"turn_end"` fires at the terminal `reply` / `abort` / `exhausted`
 *     of a turn, AFTER the sandbox event has been recorded. Useful for
 *     post-turn evaluation that wants the complete arc, not a per-step
 *     snapshot.
 */
export type DreamerTrigger = GuardrailTrigger | "user_message" | "turn_end";

/** Backpressure policy when a fire arrives while the dreamer is already
 *  running another. See plan §6 for the trade-offs. */
export type DreamerBackpressure =
  | "queue"
  | "drop_newest"
  | "drop_oldest"
  | "coalesce";

export interface DreamerDefinition {
  /** Stable identifier. Appears in `dream.jsonl`, `DreamLifecycleEvent`,
   *  and the on-disk path `dreams/<name>/`. Must be filesystem-safe — no
   *  `/`, no `..`, no leading dot, no whitespace. */
  name: string;
  /** Trigger kinds that wake this dreamer. Non-empty. `"any"` fires on
   *  every sandbox event. */
  triggers: DreamerTrigger[];
  /** Model used by the dreamer's own code-action loop. Independent of
   *  the parent's model — typically a cheaper one. */
  model: LanguageModelV2;
  /** Standing task. Becomes the dreamer's first-turn prompt; subsequent
   *  turns are driven by synthetic user messages built from the trigger
   *  payload. The dreamer keeps its own `priorSteps` across fires, so
   *  the task only needs to describe the dreamer's general role
   *  ("monitor the agent's replies for unresolved customer issues and
   *  create tickets when you see one"). */
  task: string;
  /** Tools available to the dreamer's sandbox. Independent of the
   *  parent's tool registry. A ticket-writer dreamer gets a
   *  `createTicket` tool the parent doesn't need; the parent's tools
   *  are not implicitly visible. */
  // deno-lint-ignore no-explicit-any
  tools?: ToolDefinition<any, any>[];
  /** Dreamer sandbox permissions. The parent session dir is auto-added
   *  to `read` by the runtime — do not list it here. Listing the parent
   *  dir under `write` throws at `defineDreamer` time (would break the
   *  readonly invariant). */
  permissions?: PermissionsConfig;
  /** Hard cap on dreamer loop iterations PER trigger fire. Default 4.
   *  Distinct from the parent's `maxSteps`: a dreamer that's only ever
   *  asked to reflect + reply doesn't need a deep budget. */
  maxStepsPerFire?: number;
  /** Size caps overrides for the dreamer's sandbox. Defaults inherit
   *  from `DEFAULT_SIZE_CAPS`. */
  sizeCaps?: Partial<SizeCaps>;
  /** Queue policy when a fire arrives while a previous one is still
   *  running. Default `"queue"` (buffer up to `maxQueueDepth`, then
   *  drop_oldest). See `DreamerBackpressure` and plan §6. */
  backpressure?: DreamerBackpressure;
  /** Max buffered fires when `backpressure: "queue"`. Beyond this,
   *  oldest fires are evicted (and a `dropped` lifecycle event is
   *  emitted). Default 32. */
  maxQueueDepth?: number;
  /** Per-fire wall-clock cap. The dreamer's `Agent` run for one fire
   *  is hard-cancelled on overrun. Default 5 minutes — dreamers are
   *  asynchronous so a longer-than-step budget is usually fine.
   *  Independent of `sizeCaps.stepTimeoutMs` (which caps a single
   *  sandbox step, not a whole fire). */
  fireTimeoutMs?: number;
}

/** Payload delivered to a `DreamWorker` on each trigger fire. The
 *  dreamer's first-turn prompt sees the `task` field; subsequent fires
 *  arrive as synthetic user messages rendered from this payload.
 *
 *  Deliberately does NOT include the parent's `priorSteps` — the user
 *  asked for "doesn't share context, only what's coming from the hook
 *  and main LLM responses and user input." The dreamer builds its own
 *  context in its own transcript. */
export interface DreamPayload {
  /** Sandbox event the parent saw (post-guardrail). For
   *  `syntheticTrigger`-driven fires (`user_message` / `turn_end`),
   *  carries a synthesized event describing what happened. */
  event: SandboxEvent;
  /** Raw LLM completion that produced the step. May be empty for
   *  synthetic-trigger fires that don't correspond to a model call
   *  (e.g. `user_message` fires before generation). */
  llmCompletion: string;
  /** Code block extracted from the completion. Empty when no fence
   *  was present (the parent's no-code-block recovery path) or when
   *  the trigger is synthetic. */
  code: string;
  /** 1-based step index in the parent run that produced this payload.
   *  For `user_message` triggers (which fire before the step), this is
   *  the index of the step that *will* run. */
  stepIndex: number;
  /** The parent's user-supplied task on the turn that produced this
   *  step. Wakeup-driven parent turns reuse the last user task. */
  task: string;
  /** User inputs accumulated so far in the current parent turn —
   *  the initial `task` plus any user messages in async mode. NOT a
   *  global running log; capped at the current turn. */
  userInputs: DreamUserInput[];
  /** 1-based turn index in the parent run. In per-step `Agent.run()`
   *  this is always 1; in `AgentSession` it grows per inbound event. */
  turn: number;
  /** Synthetic-trigger discriminator. Sandbox-event fires leave this
   *  undefined and the dreamer's trigger predicate uses `event.kind`.
   *  Defined values disambiguate the two dreamer-only triggers. */
  syntheticTrigger?: "user_message" | "turn_end";
}

export interface DreamUserInput {
  /** `"task"` for the initial run task; `"message"` for an inbound
   *  user message in async-wakeup mode. */
  kind: "task" | "message";
  content: string;
  /** Turn this input belongs to. Equals `payload.turn` for the most
   *  recent input. */
  turn: number;
}

/** Lifecycle event surfaced to `AgentOptions.onDream`. Per-fire flow is
 *  `fired` → (queued or `dropped`) → `started` → `finished`. Errors are
 *  swallowed by the runtime; a noisy host callback never wedges a fire. */
export type DreamLifecycleEvent =
  | {
    kind: "fired";
    dreamer: string;
    triggerKind: DreamerTrigger;
    stepIndex: number;
    payloadId: string;
  }
  | {
    kind: "started";
    dreamer: string;
    payloadId: string;
  }
  | {
    kind: "finished";
    dreamer: string;
    payloadId: string;
    ok: boolean;
    /** Dreamer's terminal `reply` message (if `ok && reply produced`). */
    reply?: string;
    /** Error / abort detail (if `!ok` or the dreamer aborted). */
    error?: string;
    /** Wall-clock ms from `started` to `finished`. */
    durationMs: number;
    /** Number of sandbox steps the dreamer's fire executed. */
    steps: number;
  }
  | {
    kind: "dropped";
    dreamer: string;
    payloadId: string;
    reason: DreamDropReason;
  };

export type DreamDropReason =
  | "queue_full"
  | "drop_newest"
  | "drop_oldest"
  | "coalesced"
  | "cancelled_on_parent_close"
  | "fire_timeout";

const VALID_TRIGGERS = new Set<DreamerTrigger>([
  "reply",
  "abort",
  "reflect",
  "permission_denied",
  "throw",
  "any",
  "user_message",
  "turn_end",
]);

const VALID_BACKPRESSURE = new Set<DreamerBackpressure>([
  "queue",
  "drop_newest",
  "drop_oldest",
  "coalesce",
]);

/** Validate + return a `DreamerDefinition`. Same shape as
 *  `defineGuardrail` / `defineTool` — catches misconfiguration at
 *  construction rather than at the first fire. */
export function defineDreamer(d: DreamerDefinition): DreamerDefinition {
  if (typeof d.name !== "string" || d.name.length === 0) {
    throw new Error("defineDreamer: `name` must be a non-empty string");
  }
  if (!FS_SAFE_NAME.test(d.name)) {
    throw new Error(
      `defineDreamer("${d.name}"): name must be filesystem-safe ` +
        `(letters, digits, dash, underscore; no slashes, no leading dot, no whitespace)`,
    );
  }
  if (!Array.isArray(d.triggers) || d.triggers.length === 0) {
    throw new Error(
      `defineDreamer("${d.name}"): \`triggers\` must be a non-empty array`,
    );
  }
  for (const t of d.triggers) {
    if (!VALID_TRIGGERS.has(t)) {
      throw new Error(
        `defineDreamer("${d.name}"): unknown trigger "${t}". ` +
          `Allowed: reply, abort, reflect, permission_denied, throw, any, user_message, turn_end.`,
      );
    }
  }
  if (!d.model) {
    throw new Error(`defineDreamer("${d.name}"): \`model\` is required`);
  }
  if (typeof d.task !== "string" || d.task.length === 0) {
    throw new Error(`defineDreamer("${d.name}"): \`task\` must be a non-empty string`);
  }
  if (d.maxStepsPerFire !== undefined) {
    if (!Number.isInteger(d.maxStepsPerFire) || d.maxStepsPerFire < 1) {
      throw new Error(
        `defineDreamer("${d.name}"): \`maxStepsPerFire\` must be a positive integer`,
      );
    }
  }
  if (d.backpressure !== undefined && !VALID_BACKPRESSURE.has(d.backpressure)) {
    throw new Error(
      `defineDreamer("${d.name}"): unknown backpressure "${d.backpressure}". ` +
        `Allowed: queue, drop_newest, drop_oldest, coalesce.`,
    );
  }
  if (d.maxQueueDepth !== undefined) {
    if (!Number.isInteger(d.maxQueueDepth) || d.maxQueueDepth < 1) {
      throw new Error(
        `defineDreamer("${d.name}"): \`maxQueueDepth\` must be a positive integer`,
      );
    }
  }
  if (d.fireTimeoutMs !== undefined) {
    if (!Number.isInteger(d.fireTimeoutMs) || d.fireTimeoutMs < 1) {
      throw new Error(
        `defineDreamer("${d.name}"): \`fireTimeoutMs\` must be a positive integer`,
      );
    }
  }
  // The parent-dir write check lives in the DreamPool (it knows the
  // actual parent directory at runtime). Here we only catch the
  // statically-detectable cases.
  return d;
}

const FS_SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Trigger predicate. Sandbox-event fires use `event.kind`; synthetic
 *  fires (`user_message` / `turn_end`) consult `syntheticTrigger`. The
 *  catch-all `"any"` matches sandbox events ONLY — synthetic triggers
 *  must be subscribed to explicitly so a dreamer that asked for
 *  `triggers: ["any"]` doesn't accidentally see conversation-level
 *  events that change the meaning of its prompt. */
export function dreamerMatches(
  d: DreamerDefinition,
  payload: DreamPayload,
): boolean {
  if (payload.syntheticTrigger) {
    return d.triggers.includes(payload.syntheticTrigger);
  }
  if (d.triggers.includes("any")) return true;
  return d.triggers.includes(payload.event.kind as DreamerTrigger);
}

/** Return the trigger kind a payload represents — i.e. what kind the
 *  user-visible lifecycle event reports. Synthetic triggers take
 *  precedence over `event.kind`. */
export function dreamerTriggerKind(payload: DreamPayload): DreamerTrigger {
  if (payload.syntheticTrigger) return payload.syntheticTrigger;
  return payload.event.kind as DreamerTrigger;
}
