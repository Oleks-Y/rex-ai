# Timer-based wakeups + reflect(promise)

Status: design draft, not implemented. Replaces (or supersedes — TBD) the
`scheduleWakeup` / `tasks` surface from `docs/plans/async-wakeup-mode.md`.

## Goal

Reshape the async-wakeup primitive so it lives behind ambient JavaScript
APIs the model already knows:

1. **Intercept `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval`.**
   Inside the persistent sandbox, these become the wakeup-creation surface.
   A timer firing in callback form is the new "wakeup."
2. **Allow `reflect(promise)`.** When the LLM returns a `reflect(...)` whose
   value is a `Promise`/thenable, the runtime awaits it before settling the
   step's terminal frame; the resolved value (or rejection) becomes the
   reflect state. This replaces the `tasks.get(id).done` await dance.
3. **Demote `reply` / `abort` inside scheduled callbacks.** Top-level step
   bodies keep their full control surface (`reply` / `abort` / `reflect`);
   timer callbacks may only effectively `reflect`. Calls to `reply` / `abort`
   inside a callback are not banned but **translated to `reflect` with a
   structured payload** so the LLM can still write idiomatic code without
   accidentally talking to the user from a background tick.

The motivation: `scheduleWakeup` works but adds a non-standard API the model
must learn, and the documented patterns (synthetic `__wakeup` reflect state,
`tasks.get(id).done` await across steps, self-rescheduling thunk for
recurring jobs) are awkward. Native timer semantics are friendlier and
naturally express both one-shot delays and recurring jobs.

---

## How this changes the LLM interaction model

Side-by-side, comparing the typical patterns:

### One-shot async result

**Today:**

```ts
// step N
const h = scheduleWakeup(() => fetchDataset(42), { reason: "fetch 42" });
return reply("Working on it.");
// step N+K (wakeup-driven, synthetic __wakeup in prior steps)
const t = tasks.get("w_3");
const v = await t.done;
return reply("Got " + JSON.stringify(v));
```

**Proposed:**

```ts
// one step, no wakeup turn at all
const data = await fetchDataset(42);
return reflect(verify(data)); // or reply directly if we trust the result
```

…or, when the work is genuinely long enough that we want to release the
turn so the user isn't blocked:

```ts
// step N — fire the work, return immediately; the runtime awaits the promise
//           BEFORE settling the terminal frame, so step N+1 sees the value.
return reflect(fetchDataset(42));
// step N+1 — prior reflect.state is already the resolved value.
return reply("Got " + ...);
```

The "kick it off and reply, look it up later" path collapses into a single
`reflect(promise)` when there's nothing user-visible to say in the interim.

### Background polling / recurring job

**Today:** self-rescheduling thunk.

```ts
const tick = async () => {
  /* work */
  scheduleWakeup.delay(30_000, { reason: "next tick" });
};
scheduleWakeup(tick, { reason: "first tick" });
return reply("Started.");
```

**Proposed:** native `setInterval` with a callback that explicitly opts in to
waking the agent.

```ts
setInterval(async () => {
  const data = await fetchSomething();
  if (data.alarming) {
    // reply("…") inside a timer is translated to reflect — the agent gets
    // a wakeup turn and decides whether to actually relay this to the user.
    reply("Alert: " + data.kind);
  }
  // No reply / reflect call ⇒ tick is silent, no wakeup turn.
}, 30_000);
return reply("Watching.");
```

The crucial new rule the model must learn: **a timer callback only triggers
a wakeup turn if it explicitly `reflect`s** (or `reply`s / `abort`s, both of
which translate to reflect). A pure side-effect tick (storage write, log) is
silent.

### What dies / survives from `scheduleWakeup`

- `scheduleWakeup<T>(thunk, ...)` — **redundant**: `reflect(thunk())` covers
  the one-shot case; `setInterval` covers the recurring case. Recommend
  removing or hard-deprecating.
- `scheduleWakeup.delay(ms, ...)` — **redundant** with `setTimeout`.
- `scheduleWakeup.signal(...)` — **deferred (was reserved anyway).** Could be
  reintroduced later as a separate surface (`session.signal()` host hook
  still makes sense for webhook-style wakeups). Out of scope for this plan.
- `tasks.list()` / `tasks.cancel()` — **kept, repurposed.** The registry now
  tracks live timers (and in-flight `reflect(promise)` waits). `tasks.cancel`
  is still the LLM-facing primitive; under the hood it calls
  `clearTimeout` / `clearInterval` for timer-backed entries.
- The synthetic `__wakeup` reflect injected before a wakeup-driven turn is
  **kept conceptually** but its shape changes (see below).

### Synthetic prior-step shape

Today, the wakeup-driven turn sees:

```ts
{ kind: "reflect", state: { __wakeup: { id, status, detail } } }
```

…and the agent has to know to look up `tasks.get(id).done` to actually fetch
the value. With `reflect(promise)` the resolved value is the state directly:

```ts
{ kind: "reflect", state: <resolved value> }   // for reflect(promise)
```

For timer-callback-driven wakeups, the synthetic prior step is:

```ts
{
  kind: "reflect",
  state: {
    __from_timer: { id: "t_3", kind: "interval", delayMs: 30_000 },
    // present only if the callback called reply/abort and we translated:
    translated_intent: { kind: "reply" | "abort", message?: string, error?: string },
    // present only if the callback returned reflect(x):
    callback_state: <whatever the callback reflected>,
  },
}
```

This is the only "new shape" the model has to learn, and the prompt block
explains it inline next to the timer documentation.

---

## Parent ↔ child wire format changes

Current `wakeup_*` frames stay; their semantics shift slightly.

| Frame                  | Today                                  | Proposed                                                         |
| ---------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `wakeup_scheduled`     | one per `scheduleWakeup(...)` call     | one per `setTimeout` / `setInterval` / `reflect(promise)` start  |
| `wakeup_resolved`      | thunk resolved                         | timer fired (one per fire — interval emits N times) **or** `reflect(promise)` resolved |
| `wakeup_rejected`      | thunk threw                            | timer callback threw uncaught **or** `reflect(promise)` rejected |
| `wakeup_cancelled`     | `tasks.cancel`                         | `clearTimeout` / `clearInterval`                                 |

`wakeupKind` enum gains: `"timeout" | "interval" | "promise"`. Older
`"delay" | "thunk" | "signal"` get retired (or kept as aliases — TBD).

A new frame is needed for the **translated reply/abort from inside a
callback**, since today the only terminal-shaped frames are step-level:

- Option (i): repurpose existing `wakeup_resolved` to carry an optional
  `translated` payload (less proliferation, slightly muddier semantics).
- Option (ii): new `wakeup_intent` frame `{ id, kind, message? | error? }`,
  emitted alongside `wakeup_resolved`. Cleaner, more verbose.

I lean (ii). See open question #3.

---

## Sandbox-side changes (prelude_v2)

### Timer interception

Replace `globalThis.setTimeout` / `setInterval` / `clearTimeout` /
`clearInterval` with wrapped versions:

```ts
const __timers = new Map<number, TimerEntry>(); // id → entry

interface TimerEntry {
  id: number;            // numeric id we return to the caller (matches DOM contract)
  wakeupId: string;      // "t_<N>" for parent-side mirror routing
  kind: "timeout" | "interval";
  delayMs: number;
  cb: (...a: unknown[]) => unknown;
  nativeId: number;      // the underlying Deno timer id, kept private
}

globalThis.setTimeout = (cb, ms, ...args) => {
  const id = __nextTimerId++;
  const wakeupId = "t_" + (__nextWakeupId++);
  const nativeId = __nativeSetTimeout(() => __runTimerCallback(id, args), ms ?? 0);
  __timers.set(id, { id, wakeupId, kind: "timeout", delayMs: ms ?? 0, cb, nativeId });
  __rpcWrite({ type: "wakeup_scheduled", id: wakeupId, reason: "", wakeupKind: "timeout" });
  return id;
};
// setInterval analogous, with `kind: "interval"` and the callback wrapper
// re-firing rather than removing.
```

`__runTimerCallback` is the heart of the change:

```ts
async function __runTimerCallback(timerId: number, args: unknown[]) {
  const entry = __timers.get(timerId);
  if (!entry) return; // cleared mid-fire
  __callbackContext.push(entry); // marks reply/abort as translated
  let intent: TranslatedIntent | null = null;
  let reflectedState: unknown = __SENTINEL_NONE;
  try {
    const r = await entry.cb(...args);
    if (__isControl(r)) {
      // Control value returned (rare but valid).
      intent = __translateOrPassthrough(r);
    } else if (__recordedControl) {
      intent = __translateOrPassthrough(__recordedControl);
    }
    if (intent && intent.kind === "reflect") {
      reflectedState = intent.state;
    }
  } catch (e) {
    __rpcWrite({ type: "wakeup_rejected", id: entry.wakeupId, error: String(e) });
    __callbackContext.pop();
    if (entry.kind === "timeout") __timers.delete(timerId);
    return;
  }
  __callbackContext.pop();
  // Only emit a wakeup turn if the callback explicitly reflected/translated.
  if (intent || reflectedState !== __SENTINEL_NONE) {
    __rpcWrite({ type: "wakeup_resolved", id: entry.wakeupId,
                 callbackState: reflectedState, intent });
  }
  // Interval: leave the timer in place; setTimeout: drop entry.
  if (entry.kind === "timeout") __timers.delete(timerId);
}
```

`reply` / `abort` inside the prelude check `__callbackContext.length > 0`:
when set, they record into the per-callback `__recordedControl` slot but
flag the recorded value as a translated intent instead of a step-level
control value.

### `reflect(promise)`

In the dispatcher path:

```ts
const __returned = await fn();
let ctrl = __isControl(__returned) ? __returned : __recordedControl;
// New: if ctrl is reflect(promise-ish), unwrap.
if (ctrl && ctrl.kind === "reflect" && __isThenable(ctrl.state)) {
  const wakeupId = "p_" + (__nextWakeupId++);
  await __rpcWrite({ type: "wakeup_scheduled", id: wakeupId, reason: "", wakeupKind: "promise" });
  try {
    const v = await ctrl.state;
    await __rpcWrite({ type: "wakeup_resolved", id: wakeupId });
    ctrl = { ...ctrl, state: v };
  } catch (e) {
    await __rpcWrite({ type: "wakeup_rejected", id: wakeupId, error: String(e) });
    // Promise rejection inside reflect maps to a `throw` terminal frame;
    // alternative is `abort`. See open question #4.
    await __rpcWrite({ type: "throw", error: String(e) });
    return;
  }
}
await __dispatchTerminal(ctrl, ...);
```

Important: this expands the step's wall-clock window. The step timeout cap
(`SizeCaps.stepTimeoutMs`, default 60s) still bounds how long we wait. If
the promise hasn't settled by then, the parent SIGKILLs (today's behavior;
post-tier-3 work would replace this with cooperative cancel).

---

## Parent-side changes

Mostly mechanical:

- `PersistentSandbox` learns `callbackState` / `intent` fields on
  `wakeup_resolved`. The wakeup mirror records the last fired
  `callbackState` (interval ticks overwrite).
- `AgentSessionImpl` builds the synthetic prior-step from
  `callbackState` + `intent` instead of just `id` + `status` + `detail`.
- The parent-side wakeup mirror keeps the `WakeupDescriptor` shape but
  `wakeupKind` becomes `"timeout" | "interval" | "promise"` (plus legacy
  during transition).

No changes to module guard, permissions, session store, or RPC framing.

---

## Prompt updates

Replace the entirety of `wakeupsBlock()` in `src/prompt.ts`. New copy
(rough sketch — exact wording on implementation) covers:

1. "`setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` are
   available; semantics match the standard JS API with one twist."
2. The twist: **a callback that calls `reflect(...)` (or `reply` / `abort`,
   which are translated to `reflect`) wakes you up for another turn. A
   callback that doesn't call any control fn is silent.**
3. `reflect(promise)` — the runtime awaits the promise; the next step sees
   the resolved value as the reflect state. Use this for "do work in the
   background and continue when ready" — replaces the schedule-then-look-up
   pattern.
4. From a timer callback, `reply("X")` does NOT show "X" to the user. It
   becomes a wakeup-driven turn whose synthetic prior-step records
   `translated_intent: { kind: "reply", message: "X" }`. The agent then
   decides on the next turn whether to actually call `reply("X")` (or
   something else) at step level. Same for `abort`.
5. `tasks.list()` / `tasks.cancel(id)` are still available for inspecting
   and cancelling live timers. Cancelling under the hood is just
   `clearTimeout` / `clearInterval`; the LLM may use either.

Drop all the `scheduleWakeup` / `tasks.get(id).done` examples. Re-orient
the recurring-job example to `setInterval`.

---

## Decisions made (2026-05-08)

- **Issue 1 → A. Hard cut.** Delete `scheduleWakeup`, `tasks.get`,
  `tasks.pending`. Single mental model.
- **Issue 2 → A + opt-in.** Default: a callback only wakes the agent if it
  calls `reflect` (or `reply` / `abort`, translated). Opt-in mechanism
  (TBD — see Issue 5 below) lets a caller declare "every tick auto-wakes
  with the callback's return value as reflect state."
- **Issue 3 → A. New `SizeCaps.reflectPromiseTimeoutMs` (default 5 min).**
  Separate from the sync step cap.
- **Issue 4 → A. Slim `tasks` to `tasks.list()` + `tasks.cancel(id)`.**
  Drop `get` and `pending`.
- **Issue 5 → Agent config flag.** `AgentOptions.experimental.autoWakeOnTimer:
  boolean` (default false). When false (default), a callback only wakes the
  agent if it explicitly calls `reflect` / `reply` / `abort`. When true,
  every timer fire wakes the agent with the callback's return value as
  reflect state. No per-call API surface — the LLM writes native
  `setTimeout` / `setInterval` either way.
- **Issue 6 → A. Extend `wakeup_resolved` with optional `payload`.**
  `payload?: { state?: unknown; intent?: { kind: "reply" | "abort"; text: string } }`.
- **Issue 7 → A. `throw` terminal for `reflect(promise)` rejection.**
  Same shape as any unhandled-rejection-in-step today.
- **Issue 8 → A. Always intercept timers; rely on the explicit-reflect
  rule for waking.** Helper / lib timers register descriptors but stay
  silent.
- **Issue 9 → A. Buffer wakeup events in the inbox; current step settles
  first; FIFO within kind.** A `setInterval` firing three times during a
  long step body produces three queued wakeup turns, processed in order.
- **Issue 10 → A. Mock-LLM integration tests for translated reply/abort,
  plus a small unit test on the prelude translator.** Catches both prelude
  and parent-side wiring through the synthetic prior step.
- **Issue 11 → A. Cover resolve / reject / timeout for `reflect(promise)`,
  plus a transcript-resume passthrough test.** Mark the timeout test
  flaky-permitted if the SIGKILL race is unstable.
- **Issue 12 → A. Parametric test runs the same script under both
  `autoWakeOnTimer` flag values and asserts diverging behavior.**
- **Issue 13 → A. Accept the per-tick RPC cost; document a 100ms floor in
  the prompt; add a perf-budget test (50ms interval for 5s, assert step
  latency stays under a budget).**
- **Issue 14 → A. GC the wakeup mirror.** Drop entries 60s after they
  reach a terminal status; cap mirror size at 1000 with FIFO eviction of
  oldest terminal entries as a backstop.
- **Issue 15 → A. User messages cancel an in-flight `reflect(promise)`
  wait.** New `cancel_step` frame; prelude resolves the wait with an
  `__interrupted` sentinel; resulting reflect state carries
  `{ __interrupted_by: "user_message" }` so the next step knows the wait
  was cut short. The in-sandbox promise keeps running; its eventual
  settlement is dropped.
- **Issue 16 → A. Defer to the tier-2 memory ceiling work in the existing
  async-wakeup-mode plan.** Document the risk; rely on V8
  `--max-old-space-size=512` backstop until tier-2 lands. Add a single
  test verifying OOM triggers the unexpected-exit path cleanly.

## Open questions

These are the decisions I'd like input on before writing code.

### Issue 1 — Migration: hard cut, soft cut, or coexistence?

**A. Hard cut (recommended).** Remove `scheduleWakeup` and `tasks.get(id).done`
entirely. Update the wakeup integration tests to use the new API. Single
release, single mental model. Risk: anything outside this repo calling
`scheduleWakeup` breaks; the project is pre-1.0 with no external users
that I'm aware of, so this should be cheap.

**B. Coexist for one release.** Keep `scheduleWakeup` working, document it
as deprecated, ship timer interception alongside. Both prompt blocks
rendered. Mid-term churn risk: model sees two ways to do the same thing
and picks inconsistently — bad for reproducibility.

**C. Soft cut.** Implement timer interception INTERNALLY using
`scheduleWakeup`; rewrite the prelude so timer wrappers translate to the
existing primitive. Smallest blast radius for parent-side code; same model
behavior. Doesn't actually let us simplify the wire format though.

> Recommendation: A. The project is small, evals will catch model
> regressions, and the simplification only really lands if we delete the
> old surface. Pre-1.0 + no external consumers of the experimental flag
> means migration cost is concentrated in tests + prompt.

### Issue 2 — Should a timer callback's wakeup require an explicit `reflect`, or fire a turn on every tick?

**A. Explicit only (recommended).** Callback runs; if it calls `reflect`
(or `reply` / `abort` — translated), the parent gets `wakeup_resolved`
with the state and starts a wakeup-driven turn. Otherwise silent.

- Pro: matches the intuition "the callback can do work without bothering
  the model."
- Pro: caps LLM cost — a `setInterval` for monitoring with a cheap predicate
  only wakes the agent when the predicate fires.
- Con: subtle. The LLM has to learn that `setInterval(() => log(x), 1000)`
  does NOT wake it.

**B. Always (every tick = wakeup turn).** Simpler rule, simpler prompt.

- Pro: no surprise — every callback is a turn.
- Con: catastrophic for monitoring patterns. A 1-second interval with a
  cheap check would burn an LLM call every second.

**C. Opt-in flag at schedule time.** `setInterval(cb, ms, { wake: true })`.

- Pro: explicit, but adds a non-standard timer-options surface that defeats
  half the goal of using native APIs.

> Recommendation: A. The mental model is "control fns are how you talk to
> the agent loop"; this rule generalizes consistently from step body to
> callback body.

### Issue 3 — How to wire the translated intent on the parent?

**A. New `wakeup_intent` frame (recommended).** Emitted alongside
`wakeup_resolved` when a callback called `reply` / `abort`. Parent-side:
the synthetic prior step pulls from both. Two frames per intent-bearing
tick, but each frame's role is clear.

**B. Extend `wakeup_resolved` with optional `intent`.** One frame, but the
field is now polymorphic.

**C. Inline as `callbackState`.** Don't separate intent from reflect-state;
e.g. always emit `{ __translated_from: "reply", message: ... }` as the
state when reply was called.

> Recommendation: B. After staring at this longer, I think A is over-
> engineered. `wakeup_resolved` is already conceptually "the wakeup is
> done; here's the payload." Adding a structured `payload` field that is
> either a state, an intent, or both is the smallest reasonable step. C is
> tempting but fuses two distinct things (the LLM's intent vs. the
> reflected state) into one bag — the next-turn prompt should distinguish
> them.

### Issue 4 — `reflect(promise)` rejection: `throw` or `abort`?

**A. Map to `throw` terminal (recommended).** Today, an unhandled rejection
during a step surfaces as `kind: "throw"` with the error message; the next
step's transcript can see it and decide whether to retry. Keeping that
shape means rejection-from-`reflect(promise)` is just like any other
unhandled rejection — predictable.

**B. Map to `abort` terminal.** Stronger signal that the agent loop should
stop; but `abort` is documented as "refuse / fail" — a transient promise
rejection is too aggressive for that.

**C. Map to a synthetic `reflect` with `{ __rejected: error }`.** Awkward
overload of reflect.

> Recommendation: A.

### Issue 5 — Should `tasks` (the registry) survive in the LLM-facing API at all?

**A. Slim it down (recommended).** Keep `tasks.list()` and `tasks.cancel(id)`
only. Drop `tasks.get(id)` and `tasks.pending()`. The LLM can filter the
list itself; `get` was mostly used for the `await done` pattern, which is
gone.

**B. Drop entirely.** `clearTimeout` / `clearInterval` cover cancellation
by id. Listing is rarely used.

- Con: the parent-side wakeup mirror is the only place that knows about
  in-flight `reflect(promise)` waits; without `tasks.list()` the LLM can't
  see them at all.

**C. Keep current API, just repointed.** Lowest churn. Largest "ambient
JS API" surface area.

> Recommendation: A. `setTimeout` returns numeric ids that aren't easy to
> remember across steps; a thin `tasks.list()` (returns `{ id, kind, ... }`
> entries) lets the model recover state without rebuilding it from prior
> reflect logs.

### Issue 6 — Step wall-clock cap and `reflect(promise)`

**A. Same cap as today (60s default).** A step that returns
`reflect(longPromise)` is bounded by `SizeCaps.stepTimeoutMs`. If the
promise hasn't settled, SIGKILL fires and the sandbox dies (today's
behavior).

**B. Separate cap for promise-await.** Configurable larger ceiling
(`reflectPromiseTimeoutMs`, e.g. 5 min). Lets the model express genuinely
long jobs without bumping the global step cap.

**C. No cap on promise-await; rely on tier-3 memory pressure.** Risky.

> Recommendation: B. The whole point of `reflect(promise)` is "I don't
> know how long this takes" — sharing the same 60s ceiling as a normal
> sync step defeats it. Default 5 min is reasonable; configurable.

### Issue 7 — Test coverage

The existing `tests/integration/wakeup_test.ts` covers:
- delay schedule → fire → wakeup-driven reply
- thunk form, `tasks.get(id).done`
- rejection, cancel, race, synthetic reflect shape
- reserved-name collision

Proposed equivalent coverage:
- `setTimeout` schedule → fire → wakeup-driven reply
- `setInterval` ticks → multiple wakeup turns
- `clearTimeout` cancels before fire (no wakeup turn)
- `clearInterval` stops further ticks
- `reflect(promise)` resolve → next step sees value
- `reflect(promise)` reject → throw terminal
- timer callback calling `reply` → translated to reflect, wakeup turn
  payload includes the intent
- timer callback that does NOT call any control fn → silent (no wakeup
  turn enqueued)
- `tasks.list()` reflects in-flight timers + `reflect(promise)` waits
- timer interception still respects the step wall-clock cap (hot-loop
  inside callback ≠ uncapped)

---

## Implementation steps (final order, all decisions resolved)

Each step is a single coherent commit; tests land with the code that
introduces the feature, not after.

1. **Types + config plumbing.**
   - Add `SizeCaps.reflectPromiseTimeoutMs` (default 5 min, configurable).
   - Add `ExperimentalOptions.autoWakeOnTimer: boolean` (default false).
   - Update `wakeupKind` enum to `"timeout" | "interval" | "promise"`.
     Drop legacy `"delay" | "thunk" | "signal"`.
   - Extend `FrameWakeupResolved` with optional `payload?: { state?: unknown;
     intent?: { kind: "reply" | "abort"; text: string } }`.
   - New parent → child frame: `FrameCancelStep { type: "cancel_step" }`.
   - Drop `scheduleWakeup` / `tasks` from `RESERVED_NAMES` exports that
     are about to disappear; add `setIntervalWaking` etc. only if they
     materialize (we said no — `autoWakeOnTimer` is a config flag).

2. **Prelude_v2 timer interception.**
   - Wrap `globalThis.setTimeout` / `setInterval` / `clearTimeout` /
     `clearInterval`. Maintain `__timers: Map<number, TimerEntry>` with
     `wakeupId` for parent-side routing.
   - `__callbackContext` stack: any control fn called while non-empty
     records to a per-callback intent slot instead of the step-level
     `__recordedControl`.
   - Each fire runs the callback; if the callback returns a control value
     OR records one (reply/abort translated → reflect with
     `intent: { kind, text }`; reflect carries the state directly), emit
     `wakeup_resolved` with the `payload`. Otherwise — silent (default
     mode) OR auto-wake with the callback's return value as state
     (`autoWakeOnTimer = true`).
   - Errors thrown in callbacks emit `wakeup_rejected`.
   - `clearTimeout` / `clearInterval` on a known wakeup id emit
     `wakeup_cancelled`.
   - Replace the `scheduleWakeup` / `tasks.get` / `tasks.pending` block
     with the slim `tasks = { list, cancel }` API. `tasks.cancel` routes
     through `clearTimeout` / `clearInterval` for timer-backed entries.

3. **`reflect(promise)` unwrap in dispatcher.**
   - Detect thenable in `ctrl.state`. Emit `wakeup_scheduled` with
     `wakeupKind: "promise"`. Await up to `reflectPromiseTimeoutMs`.
   - On resolve: `wakeup_resolved`, then dispatch the original reflect
     terminal with the resolved value as state.
   - On reject: `wakeup_rejected`, then dispatch `throw` terminal.
   - On `cancel_step` from parent (Issue 15): resolve internally with
     `{ __interrupted_by: "user_message" }`, dispatch reflect with that
     payload as state. The actual promise keeps running but its
     settlement is ignored.

4. **Parent-side plumbing.**
   - `PersistentSandbox` learns `payload` field on `wakeup_resolved`.
   - `WakeupDescriptor` records last fired payload (intervals overwrite).
   - `WakeupHandlers.onResolved(id, payload?)` signature update.
   - GC loop: every 30s, drop terminal-status descriptors older than 60s;
     enforce 1000-entry cap with FIFO eviction (Issue 14).
   - `AgentSessionImpl`:
     - Synthetic prior step shape changes per the "Synthetic prior-step
       shape" section above.
     - On `user_message` while `#runOneStep` is awaiting a reflect-wait
       sandbox event (detectable from in-flight `wakeupKind: "promise"`),
       send `cancel_step` to the sandbox before enqueueing the user
       message normally (Issue 15).

5. **Prompt rewrite.**
   - Drop the entire `wakeupsBlock()` text.
   - New timers block: setTimeout / setInterval / clear*; the
     "explicit reflect or translated reply/abort wakes you" rule;
     `tasks.list` / `tasks.cancel`; the 100ms interval floor warning.
   - New `reflect(promise)` block: short, pattern-focused.
   - Add an `autoWakeOnTimer` sentence rendered conditionally on the
     config flag.

6. **Cut over `tests/integration/wakeup_test.ts` and friends.**
   - Drop scheduleWakeup tests entirely.
   - New: setTimeout fire path, setInterval N-tick path, clearTimeout
     pre-fire, clearInterval mid-stream.
   - New: `reflect(promise)` resolve / reject / timeout (mark flaky-OK).
   - New: translated reply / abort intent surfacing.
   - New: parametric test for `autoWakeOnTimer` (Issue 12).
   - New: `tests/integration/timer_concurrency_test.ts` for ordering
     (Issue 9) and the 50ms-interval perf budget (Issue 13).
   - New: `cancel_step` flow for user-message-during-reflect-wait
     (Issue 15).
   - Unit test on prelude translator helper (Issue 10).

7. **Delete `scheduleWakeup` / `tasks.get` / `tasks.pending` / legacy
   wakeupKind values from prelude_v2, types.ts, prompt.ts.** This is the
   "hard cut" landing.

8. **Optional follow-ups (out of this PR):**
   - Tier-2 memory ceiling (already in async-wakeup-mode plan, step 6).
   - `session.signal()` host hook for webhook-style wakeups (was the old
     `scheduleWakeup.signal`, now homeless).

---

## Risks and tradeoffs

- **Spec divergence on timers.** Wrapping `setTimeout` to emit RPC frames
  is fine, but if a tool or `lib.ts` helper uses timers internally it
  inherits the wakeup semantics. Most innocuous (e.g. `await new
  Promise(r => setTimeout(r, 100))`) — that's still a timer, but the
  callback resolves a Promise rather than calling reflect, so it's silent.
  Worth verifying with a test. Helpers that DO call reply inside a timer
  would surprise users; that's also true today with setInterval-based
  helpers.
- **Tier-3 restart recovery.** Closures in timers are even less recoverable
  than thunk forms (today's plan acknowledges thunks lose on restart).
  This isn't a regression — both surfaces have the same fate.
- **Confusion: "I called reply but the user didn't see it."** The prompt
  must be very clear that callback-context reply is translated. Risk of
  the model not absorbing the rule and writing buggy code that "should
  have replied." Mitigations: (a) make the synthetic prior step show the
  translated intent verbatim; (b) lint-style detection in module guard for
  `reply(` calls inside timer callback bodies (best-effort, AST-light).
- **Performance.** Per-fire `wakeup_scheduled` + `wakeup_resolved` for
  `setInterval` adds RPC overhead. Today this is one round trip per
  scheduleWakeup; under setInterval it's one per tick. For 1-second
  intervals with cheap callbacks this is fine; for 10ms timers it
  matters. Worth a microbenchmark; cap is `SizeCaps.toolResultBytes` /
  RPC throughput which is already comfortable for this use case.
