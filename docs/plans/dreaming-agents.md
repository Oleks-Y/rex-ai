# Dreaming agents

A side-channel observer agent attached to a parent `Agent` run. Fires on the same
trigger set guardrails use, but does NOT veto the parent — it reads, reasons,
and writes to its own output workspace. Use cases: post-hoc validation,
support-ticket synthesis from a conversation, system-tool usage auditing.

Mental model: a **dreamer** is to an agent what a **dream** is to wakefulness —
it watches the agent's lived steps and produces a parallel, asynchronous
narrative without changing the original timeline. The dreamer has its own
sandbox, its own LLM, its own task instructions, its own workspace; the only
thing it borrows from the parent is _read-only visibility_ into the parent's
session directory and a stream of trigger payloads (the hook + the LLM
completion that produced this step + the user inputs that drove the turn).

The user explicitly does NOT want the dreamer to inherit the parent's
`priorSteps`. The dreamer must build its own context from what it's fed,
turn-by-turn, like a separate conversation that happens to be _about_ the
parent's conversation.

> Read this whole document before any code lands. Every issue is a decision
> point — pick options, then implement.

## TL;DR

| # | Sev | Title                                                                  | Schema change                                | Code surface |
|---|-----|------------------------------------------------------------------------|----------------------------------------------|--------------|
| 1 | P1  | `DreamerDefinition` type + `defineDreamer` factory                     | none                                         | new `src/dreamer.ts` |
| 2 | P1  | Lifecycle: parent owns the dreamer pool; open/close mirror parent run  | `.rex/sessions/<parent>/dreams/<name>/` dir  | `src/agent.ts`, `src/agent_session.ts`, `src/dreamer.ts` |
| 3 | P1  | Trigger payload + non-blocking fanout at the guardrail wire-point      | none                                         | `src/agent.ts`, `src/agent_session.ts` |
| 4 | P1  | Dreamer's own sandboxed run: readonly view of parent dir + own outputs | none (uses existing PermissionsConfig)       | `src/dreamer.ts`, `src/permissions.ts` (one helper) |
| 5 | P2  | Dreamer context model: per-trigger synthetic user message              | none                                         | `src/dreamer.ts` |
| 6 | P2  | Queue + concurrency: serialized per-dreamer FIFO, backpressure policy  | none                                         | `src/dreamer.ts` |
| 7 | P2  | Public surface + CLI plumbing + observability                          | new `dream.jsonl` index inside dream dir     | `src/mod.ts`, `src/cli.ts`, `src/trace.ts` (new event kinds) |
| 8 | P2  | Tests (unit + integration) + example                                   | none                                         | `tests/`, `examples/` |

## Data-model change matrix

ASCII map of every directory / file touched, indexed by issue:

```
.rex/                                                       (root, unchanged)
└── sessions/
    └── <parent-id>/                                        (existing — parent workspace)
        ├── lib.ts                                          (parent — unchanged)
        ├── storage.json                                    (parent — unchanged)
        ├── transcript.jsonl                                (parent — unchanged)
        ├── .lock                                           (parent — unchanged)
        └── dreams/                                  [NEW · issue 2]
            └── <dream-name>/                        [NEW · issue 2]
                ├── lib.ts                           [NEW · own helpers]
                ├── storage.json                     [NEW · own KV]
                ├── transcript.jsonl                 [NEW · own conversation]
                ├── .lock                            [NEW · single-writer guard]
                ├── dream.jsonl                      [NEW · issue 7 — index of fired triggers]
                └── (user-declared write paths)      [optional · per-dreamer config]
```

Pure-code (no on-disk schema) issues: **1, 3, 4, 5, 6**.
On-disk changes touch only **new** files — no migration of existing
`transcript.jsonl` / `storage.json` formats.

Cross-cutting type additions: new `Dreamer*` interfaces in `src/types.ts`
or a sibling `src/dreamer.ts`. Two new `TraceEvent` variants (`dream_fired`,
`dream_finished`) gated on issue 7.

---

# 1. P1 · `DreamerDefinition` type + `defineDreamer` factory

Define the public shape. Mirror `GuardrailDefinition` so the type surface
is recognizable, but the semantics differ in two ways: (a) the dreamer is
_always_ non-blocking (no veto), and (b) it owns a stateful Agent rather
than a single LLM call.

### Current data flow (today — guardrails only)

```
Sandbox emits event
       │
       ▼
GuardrailRunner.evaluate(guardrails, ctx)
       │
       ├─ matchesTrigger? → run one LLM call → verdict {ok|block}
       └─ first block wins → REPLACE event with `guardrail_blocked`
                                                                ✅ blocking
Net effect today: no observation path that is non-blocking + stateful.
```

### Proposed data flow

```
Sandbox emits event
       │
       ├──────────────────────────────────► GuardrailRunner.evaluate   ← unchanged, blocking
       │                                              │
       │                                              ▼
       │                                  event (possibly replaced)
       │                                              │
       ├──────────────────────────────────► DreamPool.fanout(triggerPayload)
       │                                              │
       │                                              └─ enqueue per-dreamer · fire-and-forget · ✅ NON-blocking
       ▼
agent-loop continues with the (post-guardrail) event
```

### Schema change

None. Pure types.

### Code shape

```ts
// src/dreamer.ts
import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { GuardrailTrigger } from "./guardrail.ts";
import type { ToolDefinition, PermissionsConfig, SizeCaps } from "./types.ts";

export interface DreamerDefinition {
  /** Stable identifier — appears in dream.jsonl, trace, and the
   *  on-disk path `dreams/<name>/`. Must be filesystem-safe (no `/`). */
  name: string;
  /** Event kinds that wake the dreamer. Same trigger contract as
   *  guardrails. `"any"` fires on every step. */
  triggers: GuardrailTrigger[];
  /** The dreamer is itself a code-action agent. Its model. */
  model: LanguageModelV2;
  /** The dreamer's standing task — what it's _watching for_. This is the
   *  first-turn prompt; each trigger fire becomes a synthetic
   *  user_message. */
  task: string;
  /** Tools available to the dreamer's sandbox. Independent of the
   *  parent's tool registry — different audiences, different toolkits.
   *  E.g. a ticket-creation dreamer gets a `createTicket` tool the
   *  parent agent doesn't need. */
  // deno-lint-ignore no-explicit-any
  tools?: ToolDefinition<any, any>[];
  /** Dreamer sandbox permissions. The parent session dir is auto-added
   *  to `read` (see issue 4); this config covers _additional_ access. */
  permissions?: PermissionsConfig;
  /** Hard cap on dreamer loop iterations PER trigger fire. Default 4. */
  maxStepsPerFire?: number;
  /** Size caps for the dreamer's sandbox. Defaults inherited from
   *  `DEFAULT_SIZE_CAPS`. */
  sizeCaps?: Partial<SizeCaps>;
  /** Queue policy when a fire arrives while the dreamer is already
   *  running another. See issue 6 for the options. Default `"queue"`. */
  backpressure?: "queue" | "drop_newest" | "drop_oldest" | "coalesce";
  /** Hard cap on queued fires (only meaningful when `backpressure: "queue"`).
   *  Default 32 — beyond that, new fires fall through to `drop_oldest`. */
  maxQueueDepth?: number;
  /** If true, the parent run waits for in-flight dreams to drain before
   *  resolving its terminal RunResult. Default false (parent returns
   *  immediately; dreams continue in a detached background task that the
   *  CLI awaits before exit, see issue 2). */
  awaitOnClose?: boolean;
  /** Per-fire wall-clock cap. Default 5 min. The dreamer's sandbox is
   *  hard-cancelled on overrun and a `dream_finished{ok:false}` is
   *  emitted. */
  fireTimeoutMs?: number;
}

export function defineDreamer(d: DreamerDefinition): DreamerDefinition {
  /* validates name (non-empty, filesystem-safe), triggers (non-empty +
   * subset of GuardrailTrigger), model present, task non-empty, no
   * collisions with reserved names, etc. */
  return d;
}
```

### Options

```
1A  Mirror GuardrailDefinition exactly — same `triggers` enum         ← recommended
    + non-blocking semantics + own Agent. Familiar API; reuses
    `matchesTrigger` predicate.
1B  Invent a new trigger model with richer matching (e.g. predicate    (rejected — premature
    callback, regex over reply messages).                              complexity; user only
                                                                       asked for "same hooks")
1C  Don't define a Dreamer type — let users register an arbitrary       (rejected — no way to
    callback at the trigger site.                                       enforce the readonly
                                                                        sandbox or own output
                                                                        dir guarantees)
```

**Open QN 1:** Should `triggers` support a new kind for the dreamer that
guardrails can't observe — e.g. `"user_message"` so a dreamer can react
to an incoming user turn in async-wakeup mode without waiting for the
sandbox to emit? My recommendation: **yes, add `"user_message"` and
`"turn_end"` as dreamer-only triggers.** Guardrails fire per sandbox
event; dreamers want conversation-level visibility too.

---

# 2. P1 · Lifecycle: parent owns the dreamer pool

The dreamer is "attached to a specific agent run." That means the parent
agent (or session) opens the pool when it opens, the pool persists for the
duration of the run, and the parent closes the pool when it closes. No
freestanding dreamer; no cross-run sharing.

### Current data flow (today — no dreams)

```
Agent.run                  Agent.openSession (async-wakeup)
    │                                │
    ▼                                ▼
SessionStore.open(<parent-id>)       SessionStore.open(<parent-id>)
    │                                │
    │                                ▼
    │                          PersistentSandbox.open
    │                                │
    │                                ▼
    │                          worker loop ──► emit events
    │
    ▼
loop: sandbox per step ─► emit onStep
    │
    ▼
SessionStore.close (releases lock; deletes if ephemeral)
```

### Proposed data flow

```
Agent.run (or openSession)
    │
    ▼
SessionStore.open(<parent-id>)
    │
    ▼
DreamPool.open({ parentSession, dreamers })             [NEW · issue 2]
    │
    ├── for each dreamer:
    │       SessionStore.open(<parent-id>/dreams/<name>)  ✅ own workspace
    │       DreamWorker — owns its Agent + queue
    │
    ▼
agent step loop ────► fanout(payload) ──► DreamPool.dispatch(payload)
                                                        │
                                                        ▼ enqueue per-dreamer
                                                  ── workers run async ──
                                                        │
                                                        ▼ each dream writes
                                                          to dreams/<name>/transcript.jsonl

(on parent terminal event)
DreamPool.close({ awaitDrain })            [issue 2 — depends on awaitOnClose]
    │
    ▼ for each worker:
       finish current fire (if any) → close session + sandbox
```

### Schema change

Adds the `dreams/<name>/` subtree under the parent's session dir. Same
files as a normal session (`lib.ts` / `storage.json` / `transcript.jsonl` /
`.lock`) so existing `SessionStore` machinery is reused as-is.

```
.rex/sessions/<parent-id>/dreams/<name>/
  ├── lib.ts            ← dreamer's helpers (own writeLib)
  ├── storage.json      ← dreamer's KV (own get/set/del/keys)
  ├── transcript.jsonl  ← dreamer's step log
  ├── .lock             ← single-writer guard
  └── dream.jsonl       ← (issue 7) index: one line per trigger fire
```

`dream.jsonl` is new (not part of SessionStore today). It's the
"fire-and-completion" record — one line per trigger fire with
`{ts, triggerKind, payloadHash, status, dreamerStepCount}` — so an
operator can scan it without parsing the full transcript.

### Code shape

```ts
// src/dreamer.ts (continued)
export class DreamPool {
  static async open(args: {
    parentSession: SessionStore;
    parentTracer?: Tracer;
    dreamers: DreamerDefinition[];
  }): Promise<DreamPool> { /* opens one DreamWorker per dreamer */ }

  /** Called at the parent's guardrail wire-point (issue 3). Non-blocking. */
  dispatch(payload: DreamPayload): void { /* fanout → per-worker enqueue */ }

  /** Drains in-flight + queued fires per worker policy, then closes. */
  async close(opts: { awaitDrain: boolean }): Promise<void> { /* … */ }
}

class DreamWorker {
  // owns: SessionStore, Agent, queue, in-flight Promise
  // surface: enqueue(payload), close()
}
```

The dreamer's `SessionStore` is opened **non-ephemeral** with id
`<parent-id>__<dreamer-name>` rooted at `.rex/sessions/<parent-id>/dreams/`
(via a new `sessionsRoot` override). This reuses every invariant the parent
session enforces (lock, atomic writes, size caps, transcript replay).

### Options

```
2A  Nested under parent: .rex/sessions/<p>/dreams/<name>/         ← recommended
    + co-located, easy to reason about lifetime, single tree
    to copy when archiving a run.
2B  Separate root: .rex/dreams/<name>/<parent-id>/                (rejected — splits a run
    Easier to index "all dreams of kind X across runs"             across two trees, makes
    but pays for it with cleanup/garbage complexity.               --session resume more
                                                                   complex; we can add a
                                                                   `dreams-index.jsonl` at
                                                                   the root later if needed)
2C  Fully independent SessionStore.open() with its own id         (rejected — dream is not
    Decouple completely, link only via metadata.                   useful without a parent;
                                                                   independent SessionStore
                                                                   makes orphan dreams a real
                                                                   class of bug)
```

**Open QN 2:** When the parent is **ephemeral** (no `--session` flag), is
the dreamer's workspace also ephemeral? My recommendation: **yes, the
dreamer is ephemeral iff the parent is.** If the parent is being thrown
away, the dreamer's transcript referencing the parent's events is
useless too. Counter-argument: a "ticket-creation" dreamer might write
out an artifact the user actually wants. Mitigation: dreamers can
declare a `permissions.write` path OUTSIDE the session dir, and writes
to those persist regardless. So the rule is: dream workspace = parent
ephemerality; dreamer-emitted side-effects to user-declared paths are
durable on their own.

**Open QN 3:** When `awaitOnClose: false` and the parent's terminal event
arrives, do queued-but-not-started fires get cancelled, dropped, or
run to completion? My recommendation: **dropped, with one `dream_finished
{status: "cancelled_on_parent_close"}` row each.** The dreamer's whole
purpose is to track _the live run_; finishing dreams after the user's
already moved on is just confusing.

---

# 3. P1 · Trigger payload + non-blocking fanout at the guardrail site

This is the wire-point. Both `agent.ts:#applyGuardrails` and
`agent_session.ts:#applyGuardrails` get a sibling call to
`DreamPool.dispatch(payload)`. The dispatch is synchronous (just an
enqueue), so the parent's hot path isn't slowed.

### Current data flow

```
sandbox event ──► applyGuardrails ──► (maybe replace) ──► recordStep ──► onStep
                       │
                       └─ blocking; one LLM call per matching guardrail
```

### Proposed data flow

```
sandbox event ──► applyGuardrails ──► (maybe replace) ──► dreamPool.dispatch ──► recordStep ──► onStep
                       │                                          │
                       └─ blocking, unchanged                    └─ ✅ non-blocking; enqueue only
```

Crucial sequencing: dreams fire on the **post-guardrail** event. If a
guardrail blocks, dreams see `kind: "guardrail_blocked"` (which is one of
their valid triggers). This matches the user's stated reason — "evaluation
of system tools usage" benefits from seeing _what actually happened_, not
the raw pre-guardrail event.

### Schema change

None.

### Code shape

```ts
// src/dreamer.ts
export interface DreamPayload {
  /** Sandbox event the parent saw (post-guardrail). The dreamer's trigger
   *  predicate uses `event.kind` exactly like a guardrail. */
  event: SandboxEvent;
  /** Raw LLM completion that produced this step. The user wants this
   *  separately from `code` so dreamers can reason about the prose around
   *  the code block (e.g. policy violations the model articulated
   *  before "fixing" them in code). */
  llmCompletion: string;
  /** Code block extracted from the completion (same as what the sandbox
   *  ran). Empty string for no-code-block recovery. */
  code: string;
  /** 1-based step index in the parent run. */
  stepIndex: number;
  /** Parent's user-supplied task on the turn that produced this step. */
  task: string;
  /** Per-turn user inputs accumulated so far this turn (initial task + any
   *  user messages in async mode). One entry per inbound user turn — NOT
   *  per sandbox step. */
  userInputs: Array<{ kind: "task" | "message"; content: string; turn: number }>;
  /** Logical turn this step belongs to (1 in per-step Agent.run; growing
   *  in AgentSession). */
  turn: number;
  /** Synthetic trigger kind for dreamer-only fires (issue 1, open QN 1):
   *   - undefined → fired on a sandbox event (use `event.kind`)
   *   - "user_message" → fired because a user message arrived (no event yet)
   *   - "turn_end" → fired at terminal reply/abort of a turn */
  syntheticTrigger?: "user_message" | "turn_end";
}
```

Three points worth nailing:

1. **No `priorSteps`** on the payload. The user explicitly said "doesn't
   share context, only what's coming from the hook and main LLM responses
   and user input." We pass `userInputs` (cumulative across the turn)
   and `llmCompletion` (just this step). The dreamer builds its own
   memory in its own `priorSteps`.

2. **`userInputs` is cumulative within a turn**, not a global running
   log. The dreamer's _own_ transcript carries history across turns; we
   don't need to redundantly pipe it on every fire.

3. **`syntheticTrigger`** is the escape hatch for the two non-sandbox
   triggers (`user_message`, `turn_end`). Sandbox-event fires leave it
   undefined.

### Options

```
3A  Pass an explicit DreamPayload struct; dispatch is sync-enqueue     ← recommended
    + worker drains the queue. No back-pressure on the parent.
3B  Pass the same GuardrailContext shape (priorSteps included).         (rejected — explicitly
                                                                         violates user's
                                                                         "no shared context"
                                                                         constraint)
3C  Pass nothing — dreamer reads `transcript.jsonl` from disk after     (rejected — racy with
    each fire.                                                           still-in-flight parent
                                                                         writes; loses the raw
                                                                         llmCompletion which
                                                                         the transcript doesn't
                                                                         persist)
```

**Open QN 4:** Should `DreamPayload.userInputs` include the wakeup-driven
synthetic prior steps from async-wakeup mode (the `__from_timer` /
`__wakeup` shapes)? My recommendation: **no.** Those are sandbox-event
artifacts, not user inputs. If a dreamer needs them, it can subscribe to
trigger `"reflect"` and read the state.

---

# 4. P1 · Dreamer's own sandboxed run: readonly view + own outputs

This is the security model and the centerpiece the user called out:
"access to the same directory as original agent's sandbox but readonly."

### Current data flow

```
Parent sandbox permissions:
  --allow-read=<parent-session-dir>,<user-declared-read-paths>
  --allow-write=<user-declared-write-paths>      ← parent can write its own decl'd paths
  (Parent's own session dir is read-only at the OS level — writes go via
   RPC frames to SessionStore in the parent process.)
```

### Proposed data flow

```
Dreamer sandbox permissions (compiled by extended PermissionCompiler):
  --allow-read=<DREAMER-session-dir>,                ✅ its own workspace
              <PARENT-session-dir>,                  ✅ readonly visibility (NEW)
              <dreamer-declared-read-paths>
  --allow-write=<dreamer-declared-write-paths>       ← NEVER includes parent dir
  (Dreamer cannot mutate parent's transcript / storage / lib.)
```

Two invariants:

1. The **parent session dir** is added to `--allow-read` but cannot
   appear in `--allow-write`. If a user lists the parent dir under
   `dreamer.permissions.write`, **`defineDreamer` throws.**
2. The dreamer's own session dir is added to `--allow-read` (so
   `session:lib` resolves for the dreamer's own helpers) and is NEVER
   writable from inside the sandbox (writes go via the RPC path,
   unchanged).

### Schema change

None at the data layer. The `PermissionCompiler` gets one new helper:

```ts
// src/permissions.ts (extended)
export interface CompileInput {
  permissions: PermissionsConfig | undefined;
  sessionDir: string;
  sessionLibPath: string;
  /** New: extra read-only paths to splice into --allow-read. Used by
   *  the dreamer to mount its parent's session dir read-only. The
   *  caller is responsible for never putting these in `write`. */
  extraReadOnlyPaths?: string[];
}
```

`PermissionCompiler.compile` already dedupes `read`. Adding the parent
dir is a one-line splice. The "never write" invariant is enforced one
layer up in `defineDreamer`, where the dreamer's `permissions.write` is
checked against the parent path.

### Code shape

```ts
// src/dreamer.ts (DreamWorker.start)
const parentDir = parentSession.dir;
if (def.permissions?.write?.some((p) => isUnderPath(p, parentDir))) {
  throw new Error(
    `dreamer "${def.name}": permissions.write may not include the parent session dir`,
  );
}

const dreamerSession = await SessionStore.open({
  sessionId: `${parentSession.sessionId}__${def.name}`,
  rootDir: parentSession.dir + "/dreams",   // → dreams/<name>/
  sizeCaps: { ...DEFAULT_SIZE_CAPS, ...def.sizeCaps },
});

this.#agent = new Agent({
  model: def.model,
  task: def.task,
  tools: def.tools,
  permissions: {
    ...def.permissions,
    // Caller's `read` is preserved; we splice the parent dir in via the
    // PermissionCompiler hook so we don't accidentally clobber it here.
  },
  sessionId: dreamerSession.sessionId,
  sessionsRoot: <dreams-root>,
  maxSteps: def.maxStepsPerFire ?? 4,
  // PermissionCompiler will receive extraReadOnlyPaths: [parentDir]
  // via a new agent option (see issue 4 implementation note below).
});
```

Implementation note: `Agent` doesn't currently surface
`extraReadOnlyPaths`. We add it as an `internal` option on
`AgentOptions` (not documented in the public types — agents that aren't
dreamers don't need it). Alternative: bake the splice directly into the
dreamer's `permissions.read`. The internal option is cleaner because it
preserves the user's mental model (the parent dir is a property of being
a dreamer, not a regular read path).

### Options

```
4A  New internal `AgentOptions.extraReadOnlyPaths`, splice in           ← recommended
    `PermissionCompiler.compile`. Single source of truth, validated
    in defineDreamer.
4B  Inject directly into `def.permissions.read` inside DreamWorker.      (rejected — invisible
    No type changes.                                                      to the user; if the user
                                                                          inspects the compiled
                                                                          permissions they're
                                                                          confused why the parent
                                                                          dir is there)
4C  Skip readonly mount; require the dreamer to receive everything       (rejected — strictly less
    via DreamPayload only.                                                power; the user explicitly
                                                                          asked for access to the
                                                                          parent directory)
```

**Open QN 5:** Should the dreamer be able to read the **parent's `lib.ts`
exports** (i.e. have `session:lib` resolve to the parent's lib for read
purposes)? My recommendation: **no, the dreamer's `session:lib` is its
own** — otherwise we recreate the cross-context coupling the user
explicitly forbade. If a dreamer needs to inspect the parent's `lib.ts`
source it can `Deno.readTextFile(<parent-dir>/lib.ts)` because the
readonly mount gives it that path.

**Open QN 6:** Should the dreamer's `--allow-net` default include any
parent-inherited net allowlist, or be entirely independent? My
recommendation: **entirely independent.** A `createTicket` dreamer
needs `api.zendesk.com`; the parent doesn't, and we shouldn't widen
either side's blast radius for the other.

---

# 5. P2 · Dreamer context model: per-trigger synthetic user message

When a `DreamPayload` arrives at a `DreamWorker`, we translate it into a
`user_message` injected into the dreamer's `AgentSession`. This means:

1. The dreamer runs in **async-wakeup mode** (it owns a long-lived
   `AgentSession`). Each fire is a turn; the dreamer's own `priorSteps`
   accumulate across fires. This is exactly the behavior the user asked
   for ("follow initial agent's workflow").
2. The dreamer's standing `task` (set once at `defineDreamer` time) is
   the first-turn instruction. Subsequent turns are driven by the
   synthetic `user_message`s we generate from `DreamPayload`s.

### Translation: DreamPayload → user_message

```
DreamPayload                                  Synthetic user_message
─────────────                                 ──────────────────────
{                                             "PARENT STEP 4 (reply)
  event: { kind: "reply", message: "Sent!" },  Code:
  llmCompletion: "I'll call the email tool…",    ```ts
  code: "await sendEmail(...); return reply…",   await sendEmail(...);
  stepIndex: 4,                                  return reply('Sent!');
  task: "Email Alice",                           ```
  userInputs: [{kind:'task', content:'Email     LLM response (excerpted):
    Alice', turn:1}],                            I'll call the email tool…
  turn: 1                                       User input for this turn:
}                                                - [task] Email Alice"
```

The dreamer's prompt then says: "your standing task is `<def.task>`;
here is the latest step the agent took." The dreamer can `reflect()` to
accumulate state, `writeLib()` to grow its own helpers, and `reply()`
when it has something to surface (e.g. "TICKET-123 created"). The reply
goes to the dreamer's own transcript + `dream.jsonl` — not to the
parent.

### Schema change

None at the data layer. The DreamWorker is responsible for the
translation, using a stable rendering format the dreamer's prompt knows
how to read.

### Code shape

```ts
// src/dreamer.ts (DreamWorker.consumeFire)
async #consumeFire(payload: DreamPayload): Promise<void> {
  const message = renderPayloadAsUserMessage(payload);
  this.#session.send({ kind: "user_message", content: message });
  // dreamer agent runs its turn; we record the terminal in dream.jsonl
  // when we see the matching {reply|abort|exhausted} event in events.
}
```

### Options

```
5A  Each fire = one user_message; dreamer is an AgentSession;           ← recommended
    dreamer's priorSteps accumulate. Standing task set once.
5B  Each fire = a fresh Agent.run() with the payload as task. No        (rejected — destroys
    cross-fire memory.                                                   "follow workflow";
                                                                         dreamer can't accumulate
                                                                         understanding)
5C  Stream-of-payloads injected directly as priorSteps (no LLM call     (rejected — defeats the
    per fire). Dreamer only "reflects" on explicit request.              point; the user wants
                                                                         autonomous evaluation,
                                                                         not passive logging)
```

**Open QN 7:** Should the dreamer's `reply()` terminate its session, or
just "publish" the reply and let the session keep running for the next
fire? My recommendation: **publish + keep running.** The dreamer's
session is multi-turn by construction; a reply is "I have something to
say about this fire," not "I'm done." We treat reply as the natural
output channel and re-prompt on the next fire. We can offer a special
`reply.final()` or a `dreamer.close()` tool later if a use case actually
needs hard termination.

---

# 6. P2 · Queue + concurrency: serialized per-dreamer FIFO

Each `DreamWorker` has a FIFO queue. Fires arrive while the dreamer is
mid-turn; the queue absorbs them so we don't either (a) block the parent
or (b) parallelize dreamer LLM calls.

### Current vs proposed (in-flight fire diagram)

```
Today (no dreams):
parent ──► event ──► event ──► event       (no observation)

Proposed:
parent ──► event ──► event ──► event
              │         │         │
              ▼         ▼         ▼
        dispatch    dispatch    dispatch       ← all sync, all enqueue, all O(1)
              │
              ▼
        [DreamWorker queue]                    ← FIFO; one running at a time
              │
              ▼
        worker turn (LLM + sandbox) ──► dream.jsonl row + transcript
```

### Backpressure policies

```
queue           buffer up to maxQueueDepth; beyond that → drop_oldest    (default · safest for
                                                                          short bursts)
drop_newest     fires-while-busy are silently dropped, oldest survives    (use for "best-effort"
                                                                          dreamers that only
                                                                          need a representative
                                                                          sample)
drop_oldest     newest fires preempt old queued ones                       (use for "always
                                                                          latest" dreamers, e.g.
                                                                          "what's the agent
                                                                          doing right now?")
coalesce        collapse contiguous same-kind fires into one synthetic    (use for chatty
                payload that lists each event                              triggers like "any";
                                                                          experimental, gate
                                                                          behind a flag)
```

### Code shape

```ts
// src/dreamer.ts
class DreamWorker {
  #queue: DreamPayload[] = [];
  #running = false;

  enqueue(p: DreamPayload): void {
    switch (this.#def.backpressure ?? "queue") {
      case "queue":
        if (this.#queue.length >= (this.#def.maxQueueDepth ?? 32)) {
          this.#queue.shift(); // drop_oldest fallback
          this.#tracer?.emit({ type: "dream_dropped", dreamer: this.#def.name, reason: "queue_full" });
        }
        this.#queue.push(p);
        break;
      case "drop_newest":
        if (this.#running || this.#queue.length > 0) {
          this.#tracer?.emit({ type: "dream_dropped", dreamer: this.#def.name, reason: "drop_newest" });
          return;
        }
        this.#queue.push(p);
        break;
      // … etc
    }
    if (!this.#running) this.#run();
  }
}
```

### Options

```
6A  FIFO queue, default backpressure = "queue" w/ cap 32 →               ← recommended
    drop_oldest. Per-dreamer configurable.
6B  Spawn a fresh dreamer subprocess per fire (no queue, full            (rejected — defeats
    parallelism).                                                         "follow workflow";
                                                                          unbounded resource use)
6C  Single global queue across all dreamers (one worker total).          (rejected — different
                                                                          dreamers have wildly
                                                                          different cadences; one
                                                                          slow dreamer would
                                                                          starve fast ones)
```

**Open QN 8:** Default backpressure for a dreamer that triggers on
`"any"`? `"any"` fires every step, so even a moderately slow dreamer
falls behind a brisk parent. My recommendation: **document this in the
`triggers: ["any"]` docstring + ship `coalesce` as opt-in.** Don't
auto-switch the default — silent magic is worse than a deliberate config.

---

# 7. P2 · Public surface + CLI plumbing + observability

What ships to users.

### New `AgentOptions` field

```ts
// src/types.ts (extended)
export interface AgentOptions {
  // … existing fields …
  /** Side-channel observer agents. Each is its own Agent instance that
   *  fires on a configurable subset of trigger events; its writes go to
   *  `.rex/sessions/<id>/dreams/<name>/`. Use `defineDreamer()` to build
   *  one. Non-blocking — dreamers cannot veto the parent.
   *  See docs/plans/dreaming-agents.md. */
  dreamers?: DreamerDefinition[];
  /** Observability hook fired once per dream fire (enqueue, start,
   *  finish). Errors are swallowed. */
  onDream?: (event: DreamLifecycleEvent) => void;
}

export type DreamLifecycleEvent =
  | { kind: "fired"; dreamer: string; triggerKind: string; stepIndex: number }
  | { kind: "started"; dreamer: string; payloadId: string }
  | { kind: "finished"; dreamer: string; payloadId: string; ok: boolean; reply?: string; error?: string }
  | { kind: "dropped"; dreamer: string; reason: string };
```

### New `TraceEvent` variants

```ts
// extends src/types.ts TraceEvent union
| { type: "dream_fired"; dreamer: string; triggerKind: string; stepIndex: number; payloadId: string }
| { type: "dream_finished"; dreamer: string; payloadId: string; ok: boolean; durationMs: number; replyBytes?: number }
| { type: "dream_dropped"; dreamer: string; reason: string }
```

### New on-disk file: `dream.jsonl`

```
{"ts":"2026-05-12T10:00:01.123Z","fire":1,"trigger":"reflect","status":"running"}
{"ts":"2026-05-12T10:00:09.880Z","fire":1,"trigger":"reflect","status":"reply","message":"TICKET-123 created","durationMs":8757,"dreamerSteps":3}
{"ts":"2026-05-12T10:00:11.401Z","fire":2,"trigger":"reply","status":"dropped","reason":"queue_full"}
```

One line per state transition. Easier to scan than parsing the dreamer's
full `transcript.jsonl`.

### CLI

Two new flags on `cli.ts`:

```
--dream-trace          # write trace.jsonl for each dreamer (default off)
--await-dreams         # before exit, wait for all dreamers to drain (overrides per-dreamer awaitOnClose)
```

The factory protocol stays unchanged — dreamers are defined inside the
factory's `new Agent({...})` call. CLI doesn't need to know about
specific dreamers; it only needs to know whether to wait for them.

### Options

```
7A  Ship dreamers via the existing `defineDreamer` factory route,        ← recommended
    no CLI awareness beyond `--await-dreams` and `--dream-trace`.
7B  Add CLI-level dreamer registration (`--dream <path>`).               (rejected — duplicates
                                                                          the factory pattern,
                                                                          forces the dreamer's
                                                                          model/tools into JSON;
                                                                          factories already
                                                                          handle this cleanly)
7C  Skip the lifecycle hooks; users hand-roll observability via          (rejected — losing the
    each dreamer's own onStep.                                            "fired / dropped / done"
                                                                          breadcrumb is too
                                                                          painful for a UI that
                                                                          wants live state)
```

**Open QN 9:** Should `Agent.run()`'s `RunResult` carry a
`dreamSummary` so the caller can synchronously see what each dreamer
did? My recommendation: **no, separate concern; expose it via
`onDream`/trace + `dream.jsonl`.** The `RunResult` is about the parent's
outcome.

---

# 8. P2 · Tests + example

### Unit (`tests/unit/dreamer_test.ts`)

- `defineDreamer` validation:
  - empty/whitespace name → throw
  - non-filesystem-safe name (`/`, `..`) → throw
  - empty triggers array → throw
  - unknown trigger kind → throw
  - missing model → throw
  - empty task → throw
  - `permissions.write` containing the parent session dir → throw (issue 4)
  - reserved-name collision in `tools` → throw
- `DreamPayload` shape stability: snapshot test on the rendered
  user_message (so a stylistic tweak doesn't silently break dreamer
  prompts that depend on the format).
- `DreamWorker` queue policies:
  - `queue` with full → drop_oldest, emits `dream_dropped`
  - `drop_newest` while running → second fire is dropped
  - `drop_oldest` swap semantics
  - `coalesce` collapses N same-kind fires
- `extraReadOnlyPaths` flows into `PermissionCompiler` correctly +
  appears in `--allow-read` without duplicating the session dir.

### Integration (`tests/integration/dreamer_integration_test.ts`)

- Spawn a real parent `Agent` + one dreamer, scripted mock model on both
  sides. Assert:
  - Dreamer's transcript has one fire per matching parent step.
  - Dreamer cannot write into parent dir: dreamer code that does
    `Deno.writeTextFile(<parent>/lib.ts, "X")` → `permission_denied`.
  - Dreamer can read from parent dir: dreamer code that does
    `Deno.readTextFile(<parent>/transcript.jsonl)` → succeeds.
  - Parent's `RunResult` is independent of dreamer outcomes (dreamer
    aborts or hangs ≠ parent abort).
  - `--await-dreams` blocks `Agent.run()` resolve until all dreams drain.
- Async-wakeup parent: dreamer sees `wakeup_fired`-derived `reflect`
  events on the trigger path.
- Resume: parent is resumed via `resumeHistory: true`; the dreamer's
  own session is also resumed, and its priorSteps carry across the
  resume. (This is the trickiest test — the dreamer's accumulation is
  what makes "follow workflow" meaningful.)

### Example (`examples/dreaming_ticket_writer.ts`)

A small support-conversation agent + a dreamer that watches every
`reply` for "I couldn't…" / "We don't support…" patterns and creates a
mock ticket via a parent-side `createTicket` tool. Shows:
- `defineDreamer` usage
- Two different toolsets (parent vs dreamer)
- Different model on the dreamer (cheap one)
- Reading the dreamer's `dream.jsonl` at the end of the run

### Options

```
8A  Unit + integration + one example as scoped above                    ← recommended
8B  Unit only at this stage; defer integration                          (rejected — dreams
                                                                         touch sandbox perms +
                                                                         transcript writes; a
                                                                         unit-only suite leaves
                                                                         too many integration
                                                                         hazards untested)
8C  Skip the example                                                    (rejected — examples
                                                                         are the documentation
                                                                         that actually gets
                                                                         read)
```

---

# Execution plan

ASCII pipeline of PRs in landing order. Each PR is independently
mergeable, ships tests, and leaves the codebase in a green state.

```
┌──────────────────────────────────────────────────────┐
│ PR 1 · type surface + permission helper              │
│  - src/dreamer.ts (DreamerDefinition + defineDreamer │
│    + DreamPayload + DreamLifecycleEvent)             │
│  - src/permissions.ts (extraReadOnlyPaths)           │
│  - src/types.ts (AgentOptions.dreamers + onDream)    │
│  - unit tests for defineDreamer + permission compile │
│  - no runtime wiring yet (everything is dead code)   │
└──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────┐
│ PR 2 · DreamWorker + DreamPool runtime               │
│  - src/dreamer.ts (DreamPool, DreamWorker, queue)    │
│  - integration with SessionStore for dream workspace │
│  - unit tests for queue policies + lifecycle close   │
└──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────┐
│ PR 3 · wire-up in Agent + AgentSession               │
│  - src/agent.ts: dispatch in #applyGuardrails site   │
│  - src/agent_session.ts: same                        │
│  - --await-dreams flag bookkeeping                   │
│  - integration test: parent + 1 dreamer end-to-end   │
└──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────┐
│ PR 4 · trace + dream.jsonl + onDream                 │
│  - new TraceEvent variants                           │
│  - dream.jsonl append per state transition           │
│  - cli.ts: --dream-trace + --await-dreams plumbing   │
│  - integration test: trace + dream.jsonl invariants  │
└──────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────┐
│ PR 5 · example + docs                                │
│  - examples/dreaming_ticket_writer.ts                │
│  - README section: "Dreaming agents"                 │
│  - mod.ts re-exports                                 │
└──────────────────────────────────────────────────────┘
```

# Open questions roll-up

| QN | Question                                                       | Recommended answer |
|----|----------------------------------------------------------------|--------------------|
| 1  | Add `"user_message"` + `"turn_end"` as dreamer-only triggers?  | Yes |
| 2  | Dream ephemeral iff parent is ephemeral?                       | Yes; user-declared write paths are durable on their own |
| 3  | Dreams queued at parent-close when `awaitOnClose: false`?      | Dropped, with a `dream_finished{status:cancelled_on_parent_close}` row |
| 4  | Include wakeup synthetic prior steps in `payload.userInputs`?  | No — they're sandbox-event artifacts, not user inputs |
| 5  | Should dreamer's `session:lib` resolve to parent's `lib.ts`?    | No — own lib only; parent path is readable via `Deno.readTextFile` |
| 6  | Inherit parent's `--allow-net` allowlist?                       | No — strictly independent |
| 7  | Should dreamer's `reply()` terminate its session?               | No — publish + keep running for the next fire |
| 8  | Default backpressure for `triggers: ["any"]`?                   | Keep `"queue"`; document the chatty-trigger trap; ship `coalesce` opt-in |
| 9  | Add `dreamSummary` to parent's `RunResult`?                     | No — surface via `onDream`/trace/`dream.jsonl` |
