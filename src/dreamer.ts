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
import { Agent } from "./agent.ts";
import type { GuardrailTrigger } from "./guardrail.ts";
import { SessionStore } from "./session.ts";
import {
  type AgentEvent,
  type AgentSession,
  DEFAULT_SIZE_CAPS,
  type PermissionsConfig,
  type SandboxEvent,
  type SizeCaps,
  type ToolDefinition,
} from "./types.ts";
import { isAbsolute, normalize, relative, resolve } from "@std/path";

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

// ───────────────────────────────────────────────────────────────────────
// Runtime
// ───────────────────────────────────────────────────────────────────────
//
// DreamPool — one per parent Agent run. Owns N DreamWorkers, fans
// trigger payloads out to each, and orchestrates open / close.
//
// DreamWorker — one per dreamer. Owns its own SessionStore (at
// .rex/sessions/<parent>/dreams/<name>/) and an Agent in async-wakeup
// mode. Maintains a FIFO queue of payloads; consumes them one at a time
// by injecting each as a synthetic user_message into the dreamer's
// AgentSession. Tracks lifecycle via DreamLifecycleEvent.
//
// Wire-up at the parent's guardrail site (DreamPool.dispatch) is added
// in PR3. The runtime in this file is invoked by integration tests in
// PR5 even without the live wire-up, by calling DreamPool.dispatch
// directly.

export interface DreamPoolOpenInput {
  /** The parent run's SessionStore. The parent dir becomes the
   *  dreamer's readonly mount and the prefix for `<parent>/dreams/<name>/`. */
  parentSession: SessionStore;
  /** Dreamer definitions to run. Each gets its own DreamWorker. */
  dreamers: readonly DreamerDefinition[];
  /** Lifecycle observer. Errors are swallowed (observability only). */
  onDream?: (event: DreamLifecycleEvent) => void;
}

export class DreamPool {
  readonly #workers: Map<string, DreamWorker>;
  readonly #onDream?: (event: DreamLifecycleEvent) => void;
  #closed = false;

  private constructor(args: {
    workers: Map<string, DreamWorker>;
    onDream?: (event: DreamLifecycleEvent) => void;
  }) {
    this.#workers = args.workers;
    this.#onDream = args.onDream;
  }

  static async open(input: DreamPoolOpenInput): Promise<DreamPool> {
    const names = new Set<string>();
    for (const d of input.dreamers) {
      if (names.has(d.name)) {
        throw new Error(`DreamPool: duplicate dreamer name "${d.name}"`);
      }
      names.add(d.name);
    }
    const workers = new Map<string, DreamWorker>();
    const opened: DreamWorker[] = [];
    try {
      for (const def of input.dreamers) {
        assertParentDirNotWritable(def, input.parentSession.dir);
        const worker = await DreamWorker.open({
          def,
          parentSession: input.parentSession,
          emit: (ev) => emitLifecycle(input.onDream, ev),
        });
        workers.set(def.name, worker);
        opened.push(worker);
      }
    } catch (e) {
      // Roll back any workers we already opened so we don't leak
      // session locks / sandboxes when one of the later workers fails.
      for (const w of opened) {
        try { await w.close({ awaitDrain: false }); } catch { /* */ }
      }
      throw e;
    }
    return new DreamPool({ workers, onDream: input.onDream });
  }

  /** Returns true iff at least one configured dreamer has at least one
   *  matching trigger for `payload`. Cheap-skip helper for the parent's
   *  hot path. */
  hasMatch(payload: DreamPayload): boolean {
    for (const w of this.#workers.values()) {
      if (dreamerMatches(w.definition, payload)) return true;
    }
    return false;
  }

  /** Fan a payload out to every matching dreamer. Synchronous — each
   *  worker only enqueues; the LLM call happens later on the worker's
   *  task. Safe to call from the parent's hot path. No-op when closed. */
  dispatch(payload: DreamPayload): void {
    if (this.#closed) return;
    for (const w of this.#workers.values()) {
      if (dreamerMatches(w.definition, payload)) {
        w.enqueue(payload);
      }
    }
  }

  /** Drain in-flight + queued fires per worker policy, then close.
   *  `awaitDrain` mirrors `AgentOptions.awaitDreamsOnClose`. */
  async close(opts: { awaitDrain: boolean } = { awaitDrain: false }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const closes: Promise<void>[] = [];
    for (const w of this.#workers.values()) {
      closes.push(w.close(opts));
    }
    await Promise.allSettled(closes);
  }

  /** Read-only access to workers (for tests + dream.jsonl readers). */
  workers(): readonly DreamWorker[] {
    return Array.from(this.#workers.values());
  }
}

interface DreamWorkerOpenInput {
  def: DreamerDefinition;
  parentSession: SessionStore;
  emit: (event: DreamLifecycleEvent) => void;
}

/** Owns one dreamer's Agent + queue. Public surface is `enqueue` and
 *  `close`; everything else is internal scheduling. */
export class DreamWorker {
  readonly definition: DreamerDefinition;
  readonly #parentDir: string;
  readonly #session: SessionStore;
  readonly #agent: Agent;
  readonly #emit: (event: DreamLifecycleEvent) => void;
  readonly #queue: DreamPayload[] = [];
  /** Payload IDs assigned per enqueue. Stable across logs so lifecycle
   *  events can be correlated with `dream.jsonl` rows in PR4. */
  #nextPayloadId = 1;
  /** Map<DreamPayload → payloadId> so we can emit a `dropped` event
   *  with the right id when we evict from the queue. */
  readonly #payloadIds = new WeakMap<DreamPayload, string>();
  #running = false;
  #session_: AgentSession | null = null;
  #sessionReady: Promise<AgentSession> | null = null;
  #closed = false;
  /** Promise tracking the currently-active fire, so `close({awaitDrain})`
   *  can wait for it. Null between fires. */
  #activeFire: Promise<void> | null = null;

  private constructor(args: {
    definition: DreamerDefinition;
    parentDir: string;
    session: SessionStore;
    agent: Agent;
    emit: (event: DreamLifecycleEvent) => void;
  }) {
    this.definition = args.definition;
    this.#parentDir = args.parentDir;
    this.#session = args.session;
    this.#agent = args.agent;
    this.#emit = args.emit;
  }

  static async open(input: DreamWorkerOpenInput): Promise<DreamWorker> {
    const { def, parentSession } = input;
    // Dreamer session dir: <parent.dir>/dreams/<name>/.
    // SessionStore composes <rootDir>/<containerDir>/<id>, so:
    //   rootDir       = parentSession.dir
    //   containerDir  = "dreams"
    //   sessionId     = def.name
    // → parentSession.dir/dreams/<def.name>/
    const sizeCaps: SizeCaps = { ...DEFAULT_SIZE_CAPS, ...(def.sizeCaps ?? {}) };
    const session = await SessionStore.open({
      sessionId: def.name,
      rootDir: parentSession.dir,
      containerDir: "dreams",
      sizeCaps,
    });

    // The dreamer's Agent runs in async-wakeup mode so the worker can
    // accumulate context across fires (each fire = one user_message
    // injected into the long-lived AgentSession). The parent dir is
    // mounted readonly via extraReadOnlyPaths; the dreamer's own session
    // dir is already covered by PermissionCompiler's auto-include.
    const agent = new Agent({
      model: def.model,
      task: def.task,
      tools: def.tools,
      permissions: def.permissions,
      sessionId: def.name,
      sessionsRoot: parentSession.dir, // root for the dreamer's own SessionStore
      // The Agent will re-open SessionStore with the same id + root we
      // already used above. SessionStore.open is idempotent w.r.t. the
      // directory but NOT the lock — we have to release our scout lock
      // before the Agent opens its own. See close() for the inverse.
      maxSteps: def.maxStepsPerFire ?? 4,
      sizeCaps,
      experimental: { asyncWakeups: true },
      extraReadOnlyPaths: [parentSession.dir],
    });

    return new DreamWorker({
      definition: def,
      parentDir: parentSession.dir,
      session,
      agent,
      emit: input.emit,
    });
  }

  /** Apply this worker's backpressure policy and (when appropriate) push
   *  the payload onto the queue. Idempotent w.r.t. closed state. */
  enqueue(payload: DreamPayload): void {
    if (this.#closed) return;
    const id = `${this.definition.name}#${this.#nextPayloadId++}`;
    this.#payloadIds.set(payload, id);
    applyBackpressure({
      payload,
      payloadId: id,
      queue: this.#queue,
      payloadIds: this.#payloadIds,
      running: this.#running,
      def: this.definition,
      emit: this.#emit,
    });

    if (!this.#running) this.#drainLoop();
  }

  /** Spawn the consumption loop. Resolves the head, runs it, repeats
   *  until the queue is empty. Re-entrant guard via `#running`. */
  #drainLoop(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = (async () => {
      try {
        while (this.#queue.length > 0 && !this.#closed) {
          const next = this.#queue.shift()!;
          this.#activeFire = this.#runOne(next);
          try {
            await this.#activeFire;
          } finally {
            this.#activeFire = null;
          }
        }
      } finally {
        this.#running = false;
      }
    })();
    // Don't keep a hard reference — failures inside loop are surfaced via
    // lifecycle events. Caller close() awaits activeFire separately.
    loop.catch(() => {});
  }

  async #runOne(payload: DreamPayload): Promise<void> {
    const id = this.#payloadIds.get(payload) ?? "?";
    const startedAt = performance.now();
    this.#emit({ kind: "started", dreamer: this.definition.name, payloadId: id });

    const message = renderPayloadAsUserMessage(payload);
    const fireTimeoutMs = this.definition.fireTimeoutMs ?? 5 * 60_000;

    let session: AgentSession;
    try {
      session = await this.#ensureAgentSession();
    } catch (e) {
      this.#emit({
        kind: "finished",
        dreamer: this.definition.name,
        payloadId: id,
        ok: false,
        error: `dreamer session open failed: ${(e as Error).message}`,
        durationMs: Math.round(performance.now() - startedAt),
        steps: 0,
      });
      return;
    }

    session.send({ kind: "user_message", content: message });

    // Consume events until we see a terminal for this turn. The
    // dreamer's AgentSession emits step / reply / abort / exhausted /
    // session_closed; we want the first reply | abort | exhausted that
    // arrives AFTER our user_message. Step counter is incremented per
    // observed `step` event.
    //
    // A timeout race ensures a runaway dreamer can't wedge the worker.
    const turnDone = consumeTurn(session, fireTimeoutMs);
    const result = await turnDone;
    const durationMs = Math.round(performance.now() - startedAt);
    this.#emit({
      kind: "finished",
      dreamer: this.definition.name,
      payloadId: id,
      ok: result.ok,
      reply: result.reply,
      error: result.error,
      durationMs,
      steps: result.steps,
    });
    if (result.timedOut) {
      // Also emit a `dropped` so observers can distinguish "ran and
      // produced no reply" from "wall-clock exceeded". The matching
      // `finished` already went out above with ok:false.
      this.#emit({
        kind: "dropped",
        dreamer: this.definition.name,
        payloadId: id,
        reason: "fire_timeout",
      });
    }
  }

  /** Lazily open the dreamer's AgentSession on first fire. We can't open
   *  it in `DreamWorker.open` because openSession returns immediately
   *  before consuming the first user_task — and we want the first turn
   *  to be driven by an actual trigger payload, not the standing task
   *  in isolation.
   *
   *  The dreamer's own Agent will open its own SessionStore on the same
   *  dir we already locked. Release our scout lock first. */
  async #ensureAgentSession(): Promise<AgentSession> {
    if (this.#session_) return this.#session_;
    if (this.#sessionReady) return await this.#sessionReady;
    this.#sessionReady = (async () => {
      // Hand the directory over to the Agent's own SessionStore.
      await this.#session.close();
      this.#session_ = await this.#agent.openSession();
      return this.#session_;
    })();
    return await this.#sessionReady;
  }

  /** Cooperative shutdown. When `awaitDrain` is true, finishes in-flight
   *  + queued fires; otherwise drops the queue (one `dropped` event per)
   *  and waits only for any currently-running fire. */
  async close(opts: { awaitDrain: boolean }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    if (!opts.awaitDrain) {
      // Drop everything that hasn't started yet.
      const dropped = this.#queue.splice(0, this.#queue.length);
      for (const p of dropped) {
        this.#emit({
          kind: "dropped",
          dreamer: this.definition.name,
          payloadId: this.#payloadIds.get(p) ?? "?",
          reason: "cancelled_on_parent_close",
        });
      }
    }
    // Either way, wait for the currently-running fire (if any) so we
    // don't leak the dreamer's sandbox process.
    if (this.#activeFire) {
      try { await this.#activeFire; } catch { /* */ }
    }
    // With awaitDrain, the loop above already pulled everything; the
    // queue is empty here. Without it, we may have dropped queued items.
    if (this.#session_) {
      try { await this.#session_.close(); } catch { /* */ }
    } else {
      // We opened the scout SessionStore but never handed off to the
      // Agent. Release the scout lock so the workspace is reusable.
      try { await this.#session.close(); } catch { /* */ }
    }
  }
}

/** Apply a backpressure policy to a queue. Pure function over (queue,
 *  running flag, definition) — extracted so unit tests can exercise the
 *  decision matrix without spinning up a real Agent / sandbox.
 *
 *  Always emits the `fired` lifecycle event for `payload`. Emits one
 *  `dropped` event when the policy evicts something (queue_full,
 *  drop_newest, drop_oldest, coalesced). Returns nothing — mutates the
 *  queue in place. */
export function applyBackpressure(args: {
  payload: DreamPayload;
  payloadId: string;
  queue: DreamPayload[];
  payloadIds: WeakMap<DreamPayload, string>;
  running: boolean;
  def: DreamerDefinition;
  emit: (event: DreamLifecycleEvent) => void;
}): void {
  const { payload, payloadId, queue, payloadIds, running, def, emit } = args;
  const triggerKind = dreamerTriggerKind(payload);

  emit({
    kind: "fired",
    dreamer: def.name,
    triggerKind,
    stepIndex: payload.stepIndex,
    payloadId,
  });

  const policy = def.backpressure ?? "queue";
  const queueDepth = queue.length + (running ? 1 : 0);

  switch (policy) {
    case "queue": {
      const cap = def.maxQueueDepth ?? 32;
      if (queueDepth >= cap) {
        const dropped = queue.shift();
        if (dropped) {
          emit({
            kind: "dropped",
            dreamer: def.name,
            payloadId: payloadIds.get(dropped) ?? "?",
            reason: "queue_full",
          });
        }
      }
      queue.push(payload);
      return;
    }
    case "drop_newest": {
      if (running || queue.length > 0) {
        emit({
          kind: "dropped",
          dreamer: def.name,
          payloadId,
          reason: "drop_newest",
        });
        return;
      }
      queue.push(payload);
      return;
    }
    case "drop_oldest": {
      if (queue.length > 0) {
        const dropped = queue.shift()!;
        emit({
          kind: "dropped",
          dreamer: def.name,
          payloadId: payloadIds.get(dropped) ?? "?",
          reason: "drop_oldest",
        });
      }
      queue.push(payload);
      return;
    }
    case "coalesce": {
      const lastIdx = queue.length - 1;
      if (lastIdx >= 0 && dreamerTriggerKind(queue[lastIdx]) === triggerKind) {
        const prev = queue[lastIdx];
        emit({
          kind: "dropped",
          dreamer: def.name,
          payloadId: payloadIds.get(prev) ?? "?",
          reason: "coalesced",
        });
        const merged = coalescePayloads(prev, payload);
        queue[lastIdx] = merged;
        payloadIds.set(merged, payloadId);
        return;
      }
      queue.push(payload);
      return;
    }
  }
}

/** Drain `session.events` until a reply / abort / exhausted lands. */
async function consumeTurn(
  session: AgentSession,
  timeoutMs: number,
): Promise<{
  ok: boolean;
  reply?: string;
  error?: string;
  steps: number;
  timedOut: boolean;
}> {
  let steps = 0;
  const iter = session.events[Symbol.asyncIterator]();
  const deadline = performance.now() + timeoutMs;

  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return { ok: false, error: "fire timeout", steps, timedOut: true };
    }
    let next: IteratorResult<AgentEvent>;
    try {
      next = await raceWithTimeout(iter.next(), remaining);
    } catch {
      return { ok: false, error: "fire timeout", steps, timedOut: true };
    }
    if (next.done) {
      return { ok: false, error: "session closed before terminal", steps, timedOut: false };
    }
    const ev = next.value;
    if (ev.kind === "step") {
      steps++;
      continue;
    }
    if (ev.kind === "reply") return { ok: true, reply: ev.message, steps, timedOut: false };
    if (ev.kind === "abort") return { ok: false, error: ev.error, steps, timedOut: false };
    if (ev.kind === "exhausted") {
      return { ok: false, error: `exhausted after ${ev.steps} steps`, steps, timedOut: false };
    }
    // wakeup_scheduled / wakeup_resolved / etc. — not terminal, keep going.
  }
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); res(v); },
      (e) => { clearTimeout(t); rej(e); },
    );
  });
}

/** Render a `DreamPayload` as the user_message body the dreamer sees.
 *  Keep this format STABLE — dreamer prompts grow to depend on it.
 *  Snapshot tests live in `tests/unit/dreamer_test.ts`. */
export function renderPayloadAsUserMessage(payload: DreamPayload): string {
  const triggerKind = dreamerTriggerKind(payload);
  const lines: string[] = [];
  lines.push(`# Parent agent activity — trigger: ${triggerKind}`);
  lines.push("");
  lines.push(`Parent step index: ${payload.stepIndex}`);
  lines.push(`Parent turn: ${payload.turn}`);
  lines.push("");
  if (payload.userInputs.length > 0) {
    lines.push("## User inputs (this turn)");
    for (const u of payload.userInputs) {
      lines.push(`- [${u.kind} · turn ${u.turn}] ${oneLine(u.content)}`);
    }
    lines.push("");
  }
  if (payload.llmCompletion) {
    lines.push("## Parent LLM completion (raw)");
    lines.push("```");
    lines.push(payload.llmCompletion);
    lines.push("```");
    lines.push("");
  }
  if (payload.code) {
    lines.push("## Parent code (extracted)");
    lines.push("```ts");
    lines.push(payload.code);
    lines.push("```");
    lines.push("");
  }
  lines.push("## Sandbox event");
  lines.push(renderEventLine(payload.event));
  if (payload.event.logs.length > 0) {
    lines.push("");
    lines.push("### Logs");
    for (const log of payload.event.logs) {
      lines.push(`- [${log.level}] ${log.args.map(safeStr).join(" ")}`);
    }
  }
  return lines.join("\n");
}

function renderEventLine(ev: SandboxEvent): string {
  switch (ev.kind) {
    case "reply":
      return `reply: ${oneLine(ev.message)}`;
    case "abort":
      return `abort: ${oneLine(ev.error)}`;
    case "reflect":
      return `reflect: ${oneLine(safeStr(ev.state))}`;
    case "permission_denied":
      return `permission_denied: ${ev.permission} → ${oneLine(ev.target)}`;
    case "throw":
      return `throw: ${oneLine(ev.error)}`;
    case "guardrail_blocked":
      return `guardrail_blocked (${ev.guardrail}): ${oneLine(ev.reason)}`;
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Merge two same-kind payloads into one. Used by `"coalesce"`
 *  backpressure. Newest event payload wins; user inputs are merged
 *  (dedup on content+turn so a chatty turn doesn't keep growing). */
function coalescePayloads(prev: DreamPayload, next: DreamPayload): DreamPayload {
  const seen = new Set<string>();
  const merged: DreamUserInput[] = [];
  for (const u of [...prev.userInputs, ...next.userInputs]) {
    const key = `${u.turn}:${u.kind}:${u.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(u);
  }
  return {
    ...next,
    userInputs: merged,
  };
}

/** Throw if `def.permissions.write` contains a path that the dreamer's
 *  --allow-write would resolve under the parent dir — that would let the
 *  dreamer mutate the parent's state and break the readonly invariant. */
function assertParentDirNotWritable(
  def: DreamerDefinition,
  parentDir: string,
): void {
  const writePaths = def.permissions?.write ?? [];
  if (writePaths.length === 0) return;
  const parentResolved = resolve(parentDir);
  for (const w of writePaths) {
    const writeResolved = isAbsolute(w) ? resolve(w) : resolve(w);
    if (isUnderPath(writeResolved, parentResolved)) {
      throw new Error(
        `defineDreamer("${def.name}"): permissions.write entry "${w}" ` +
          `resolves under the parent session dir "${parentDir}" — the ` +
          `dreamer must not mutate parent state. Use a different output ` +
          `path or drop this entry.`,
      );
    }
  }
}

/** True iff `candidate` is `target` or a descendant of `target`. Both
 *  paths must already be resolved. */
function isUnderPath(candidate: string, target: string): boolean {
  const c = normalize(candidate);
  const t = normalize(target);
  if (c === t) return true;
  const rel = relative(t, c);
  return (
    rel !== "" &&
    !rel.startsWith("..") &&
    !isAbsolute(rel)
  );
}

function emitLifecycle(
  cb: ((event: DreamLifecycleEvent) => void) | undefined,
  event: DreamLifecycleEvent,
): void {
  if (!cb) return;
  try { cb(event); } catch { /* observability only; swallow */ }
}
