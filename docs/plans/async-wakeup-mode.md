# Async wakeup mode (persistent-sandbox design)

Status: design draft, not implemented. Gated behind `experimental.asyncWakeups` flag.

## Goal

Let the agent kick off long-running work, return control to the user, and re-enter when the work resolves. Concurrent user messages must still get processed normally while wakeups are pending. The agent itself should be able to inspect, cancel, and compose its own scheduled tasks.

## Headline change vs. today: persistent sandbox

Today: one Deno subprocess per step. The subprocess exits between steps; all state round-trips through `lib.ts` and `storage.json`.

After (under the flag): **one Deno subprocess per session.** The sandbox lives as long as `AgentSession` is open. Each "step" is a dynamic `import()` into the running process. Promises, handles, and `globalThis` state survive across steps. The session ends when the host calls `session.close()` or when an unrecoverable error occurs.

Why this matters: it makes `scheduleWakeup` take a real promise, not a declarative descriptor. The agent code can literally hold a handle, cancel it, race it, await it in a later step.

## Public API — `AgentSession`

```ts
interface AgentSession {
  events: AsyncIterable<AgentEvent>;   // outbound
  send(msg: UserMessage): void;        // inbound
  signal(name: string, payload?: unknown): void;  // wake `kind: "signal"` tasks
  close(): Promise<void>;
}

type AgentEvent =
  | { kind: "reply"; message: string; turn: number; cause: "user" | "wakeup" }
  | { kind: "abort"; error: string; turn: number }
  | { kind: "step"; ... }              // existing onStep payload
  | { kind: "wakeup_scheduled"; id: string; reason: string }
  | { kind: "wakeup_resolved"; id: string }
  | { kind: "wakeup_rejected"; id: string; error: string }
  | { kind: "exhausted"; steps: number };
```

Existing `Agent.run(): Promise<RunResult>` stays as a thin wrapper that opens a session, sends one user message, and resolves on the first terminal `reply`/`abort`. Old callers don't break.

## Sandbox lifecycle

```
session.open()
  ↓
spawn deno subprocess with prelude_v2 (no LLM body yet)
  ↓
loop:
  parent receives event (user_msg | wakeup | signal)
  parent writes step code to __step_N.ts
  parent sends { type: "exec", path: "__step_N.ts" } over RPC
  sandbox: await import(stepPath); await module.default;
  module returns reply | abort | reflect | scheduleWakeup-and-return-reply
  parent observes terminal frame, but subprocess stays alive
  ↓
session.close() → parent sends { type: "shutdown" } → child Deno.exit(0)
                  on timeout → SIGKILL
```

Top-level scope inside each `__step_N.ts` is still per-step. Cross-step state lives in:
- `globalThis.__rex.tasks` — task registry
- `globalThis.__rex.signals` — registered signal listeners
- whatever the agent itself stashes on `globalThis` (we don't police that)

## scheduleWakeup primitive

Inside the prelude, exposed to the LLM:

```ts
type TaskStatus = "pending" | "resolved" | "rejected" | "cancelled";

interface TaskHandle<T = unknown> {
  id: string;
  status: TaskStatus;
  done: Promise<T>;
  cancel(reason?: string): void;
}

// Three forms; the agent picks whichever fits.

// 1. Thunk → real promise. The natural form.
scheduleWakeup<string>(
  () => fetchDataset(42),
  { reason: "waiting for dataset 42" },
): TaskHandle<string>;

// 2. Pure delay — sugar for the above.
scheduleWakeup.delay(5000, { reason: "5s tick" }): TaskHandle<void>;

// 3. External signal — fires when host calls session.signal(name).
scheduleWakeup.signal("webhook:order_42", { reason: "..." }): TaskHandle<unknown>;
```

Behaviorally:
- Calling `scheduleWakeup` registers the handle on `globalThis.__rex.tasks` and **also** notifies the parent via `wakeup_scheduled` so the host can render UI / log.
- The agent typically calls `return reply("Working on it...")` after scheduling. The step ends; the parent leaves the subprocess running.
- When the underlying promise resolves (or rejects, or is cancelled), the runtime fires a `wakeup_resolved` (or `_rejected`) event to the parent and queues a new step.
- The next step gets a fresh prelude execution where `tasks` reflects the updated status. The model can `await tasks.get("w_3").done` to actually consume the value, since the promise is still live.

## Tasks API exposed inside the sandbox

The agent code can manipulate tasks itself, not just schedule them:

```ts
const tasks = {
  list(): TaskHandle[];                 // all tasks, any status
  pending(): TaskHandle[];              // status === "pending"
  get(id: string): TaskHandle | null;
  cancel(id: string, reason?: string): boolean;
};
```

Pipe / compose example the LLM might write:

```ts
const fetchH = scheduleWakeup(() => fetchDataset(42));
const analyzeH = scheduleWakeup(
  () => fetchH.done.then(d => analyze(d)),
  { reason: "depends on dataset 42" },
);
return reply("Two-stage pipeline kicked off.");
```

Race example:

```ts
const fast = scheduleWakeup(() => fastSearch(q));
const slow = scheduleWakeup(() => slowSearch(q));
const winner = await Promise.race([fast.done, slow.done]);
tasks.pending().forEach(t => t.cancel("race lost"));
return reply(winner);
```

The "tasks API exposed to the agent" you asked for is exactly this: a regular JS object on the sandbox side, talking to the same registry that drives the parent's wakeup queue.

## Concurrency model

One queue, one worker — same as before, but now "running a step" means "dispatch import into the persistent sandbox" rather than "spawn subprocess".

```
queue: [user_msg | wakeup_resolved | wakeup_rejected | signal | step_completed]
worker (single-threaded):
  while open:
    ev = queue.next()
    case user_msg | wakeup_resolved | wakeup_rejected | signal:
      build step code (prompt → LLM → extract)
      exec in sandbox
      await terminal frame
    case step_completed:
      handle reply/abort/reflect, push to priorSteps, loop
```

Ordering rules (unchanged from previous draft):
1. FIFO within a kind.
2. User messages preempt queued wakeups.
3. Wakeups firing during a step are coalesced — model sees them in one batch.
4. `interruptible: true` (separate flag) allows a user message or high-priority wakeup to AbortController-cancel an in-flight `generateText` and re-queue. The sandbox is *not* killed in this case — only the model call is aborted, since the sandbox is now session-scoped. (See "Interrupt semantics" below.)

## Interrupt semantics — what gets demoted to reflect

You said: when a wakeup fires, current execution transfers to the wakeup, and `reply`/`abort` from the original branch become "delayed reflect calls."

Two interrupt points:

1. **During `generateText`** (model is composing its step code). AbortController cancels the request. Nothing was sent to the sandbox; nothing to demote. The next step prompt includes the wakeup payload.

2. **During sandbox execution** (the imported step module is running). Persistent sandbox means we can't SIGKILL — that would lose all session state. Instead the prelude exposes an `AbortSignal` keyed to the current step. On interrupt, the parent sends `{ type: "interrupt_step" }`; the prelude calls `currentStepAbort.abort()`. The agent's code is expected to be cancellation-aware (any `await` on a network/tool call should observe the signal). If the step module then returns `reply(...)`, the prelude **rewrites it** as a reflect-state record `{ __interrupted_reply: "..." }` before sending, so the next step's prior-steps list shows it but the user does not see a stale reply. Same for `abort`.

This is the "demoted reply" path. It's gated behind `experimental.interruptible: true` — most callers won't want it.

## Crash isolation — layered defense

Deno's in-process cancellation surface is limited. `AbortSignal` is cooperative-only — a hot CPU loop, sync OOM, or `JSON.parse` on huge input ignores it. There is no `vm.run`-with-timeout. Real preemption requires a Worker boundary.

Three tiers:

**Tier 1 — soft cancel (default for all interrupts).**
- Each step is given a fresh `AbortSignal` exposed as `currentStep.signal`.
- Step wall-clock cap fires the signal. Tool stubs, `fetch`, scheduled wakeup awaits — all cancellation-aware.
- Most steps yield within a tick or two of the abort.

**Tier 2 — memory ceiling.**
- Parent polls `Deno.memoryUsage()` (RPC, e.g. every 500 ms) for `heapUsed` against a configured ceiling (default: 256 MiB).
- On overrun: parent fires soft cancel, gives a short grace window (1 s).
- If the step yields → step ends as a synthetic `throw` event ("memory ceiling exceeded, step cancelled"); session continues.

**Tier 3 — hard restart.**
- If wall-clock cap OR memory grace window lapses without the step yielding (the hot-loop case):
  1. Parent SIGKILLs the subprocess.
  2. Parent respawns sandbox, replays `lib.ts` and `storage.json`.
  3. Live in-process JS promises (tasks scheduled with thunk form) are gone.
  4. Parent re-creates wakeups that were registered with a parent-side mirror — see below.
  5. Emit `AgentEvent({ kind: "session_restarted", reason: "..." })`.
- Last-resort backstop: V8 `--max-old-space-size=` flag at spawn (e.g. 2× the soft ceiling). If V8 itself OOMs the process, parent observes EOF and triggers tier-3 recovery the same way.

**Wakeup mirror for tier-3 survival.**
Every `scheduleWakeup` registers a *descriptor* on the parent side at the moment it's scheduled, regardless of form:
- `kind: "delay"` → mirror as `{ ms, scheduledAt }`. Trivially recreatable.
- `kind: "signal"` → mirror as `{ name }`. Recreatable.
- `kind: "thunk"` → mirror as a *best-effort source string* (the thunk's `.toString()` text plus any captured tool-call descriptors the prelude can extract). On restart, recreatable only if pure-functional. Otherwise we drop them and surface `wakeup_lost` events; the agent's next prompt sees them as "lost during restart, please reconsider."

Most thunks in practice are simple `() => fetchTool(...)` shapes, so this works. Pathological closures lose the wakeup but not the conversation.

**Worker isolation deferred.** The proper answer is "run each step in a `new Worker(file, { type: "module" })`; kill it with `worker.terminate()`." This makes preemption real and cheap, but moves cross-step state and the task registry to the main thread, complicates the thunk's home, and adds a postMessage hop on every RPC. Documented as future work.

## Other open questions

1. **Persistence of pending tasks across host restarts.** In-memory only for MVP. (Note: tier-3 *sandbox* restart is different — the parent process keeps the wakeup mirror in memory.)

2. **`maxSteps` accounting.** Persistent sandbox runs steps from multiple sources. Proposal: separate counters per source, default `maxStepsPerTurn = 8`, `maxWakeupSteps = 8`.

3. **Memory ceiling default.** Proposal: 256 MiB heap with hard backstop at `--max-old-space-size=512`. Configurable via `sizeCaps.sandboxHeapBytes`.

## Implementation steps

1. **Refactor `Agent.run` to a session-loop shape internally.** No behavior change; subprocess still per-step. De-risks step 2.
2. **Persistent-sandbox plumbing behind the flag.** New `prelude_v2` with the dynamic-import dispatcher and `globalThis.__rex` registry. Old `Sandbox.run` path stays for the default code path. Spawn with `--v8-flags=--max-old-space-size=512`.
3. **`AgentSession` event-stream surface.** Old `Agent.run` becomes a wrapper.
4. **`scheduleWakeup` thunk form + tasks API in prelude.** End-to-end with `kind: "delay"` first. Parent-side wakeup mirror starts here.
5. **Signal kind + `session.signal()` host hook.**
6. **Soft cancel + memory poll (tiers 1 & 2).** AbortSignal plumbing, `Deno.memoryUsage` poll loop, `wakeup_lost` event.
7. **Tier-3 recovery.** SIGKILL + respawn + replay + wakeup-mirror reinstatement, `session_restarted` event.
8. **Interruptible mode (separate flag).** Demoted-reply rewrite when a wakeup or user-msg cancels an in-flight step.
9. **Tests:** schedule/fire ordering, user-msg-during-pending-wakeup, task cancellation, race/pipe patterns, soft-cancel-cooperative, soft-cancel-non-cooperative→tier3, memory-ceiling, sandbox-crash recovery, wakeup-mirror replay, multi-wakeup coalescing.

## Tradeoffs and risks (revised)

- **Bigger architectural shift than the previous draft.** Persistent sandbox changes assumptions in `sandbox.ts`, `prelude.ts`, `session.ts`, and the test harness. Most existing tests don't need to change because the default path is preserved.
- **Crash blast radius.** Need a credible recovery story before flipping the flag on by default. Step 7 is non-optional.
- **Cross-step memory.** New footgun: the model writes a step that allocates a 100 MB array and stashes it on `globalThis`. We can detect via a per-session memory ceiling enforced from the parent (poll `Deno.memoryUsage` over RPC) and trigger a recovery restart.
- **Module guard timing.** Today it runs once at spawn. Now it must run on every `__step_N.ts` before the parent tells the sandbox to import it. Same logic, different invocation site.
- **Reply ordering.** Same caveat as before: a wakeup-driven `reply` is unsolicited from the user's perspective. UIs need to handle.
