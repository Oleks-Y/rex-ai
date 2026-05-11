# Timer-based wakeups — Codex review fix plan

Source review: codex pass over the timer-based wakeups + `reflect(promise)`
implementation (commits on top of `master`). Four issues plus four
plan-compliance test gaps. This plan resolves them.

> Use this plan to align on direction before any code changes. Each
> issue lists 2–3 options, an opinionated recommendation, and an
> explicit decision request. Do not start work until you've signed off
> on each section.

## Summary of issues

| # | Severity   | File                                  | One-liner                                                  |
| - | ---------- | ------------------------------------- | ---------------------------------------------------------- |
| 1 | critical   | `src/persistent_sandbox.ts:478`       | `reflectPromiseTimeoutMs` cap unreachable — `stepTimeoutMs` SIGKILLs first |
| 2 | critical   | `src/prelude_v2.ts:354`               | `__callbackContext` stack pops out of order under overlapping async cbs |
| 3 | important  | `src/prelude_v2.ts:347` (intent path) | `reflect(Promise.reject(...))` inside a timer cb leaks a rejection |
| 4 | important  | `src/agent_session.ts:567`            | `__from_timer.delayMs` reports elapsed, not configured; null for intervals |
| T | tests      | (multiple)                            | Decisions 10, 11, 13, 16 don't have backing tests              |

---

## Issue 1 — `reflect(promise)` cap is shadowed by `stepTimeoutMs`

### Problem

`PersistentSandbox.runStep` arms a single wall-clock timer at
`sizeCaps.stepTimeoutMs` (default 60s) for every step
(`src/persistent_sandbox.ts:478`). When the prelude awaits a thenable
passed to `reflect(...)`, it can wait up to
`sizeCaps.reflectPromiseTimeoutMs` (default 5min) — but the parent
SIGKILLs the sandbox at 60s regardless. So:

- The new 5-minute cap is unreachable in practice.
- The whole sandbox dies, not just the step. All in-flight intervals,
  cross-step `__rex.state`, and the persistent process all go.
- Decision 3 of the plan ("reflect promise has its own cap, separate
  from step timeout") effectively didn't land.

### Options

**Option 1A — Reflect-aware deadline (recommended).** When a
`wakeup_scheduled` with `wakeupKind: "promise"` arrives during a step,
extend the per-step deadline to `now + reflectPromiseTimeoutMs`. When
the matching `wakeup_resolved` / `wakeup_rejected` / `wakeup_cancelled`
arrives, drop back to the original `stepStart + stepTimeoutMs`
deadline (or whichever is later, so we never accidentally shorten).
Implement by holding a single `currentDeadline` value plus a
re-armable timer rather than a one-shot `setTimeout(...stepTimeoutMs)`.

- Effort: ~30 LoC in `runStep`, plus a small helper.
- Risk: small. Failure mode is "deadline drifts wrong way"; covered by
  test 11 (below).
- Impact: contained to `PersistentSandbox`; no cross-cutting changes.
- Maintenance: one new helper to keep in mind; matches what the plan
  already promised.

**Option 1B — Pause the deadline while a promise wait is active.** Same
idea but framed as elapsed-time clock that pauses on `wakeup_scheduled
(promise)` and resumes on resolve. Slightly more "correct" semantically
(non-promise time isn't refunded by the promise wait) but harder to
explain and to unit-test deterministically.

- Effort: ~50 LoC; tricky around overlapping promises.
- Risk: medium — pause/resume bookkeeping has off-by-one risk.
- Impact: contained.
- Maintenance: weirder mental model.

**Option 1C — Do nothing; document that `reflectPromiseTimeoutMs` is
silently capped at `stepTimeoutMs`.** Cheap, but it makes the new size
cap a lie and contradicts the plan/prompt language we ship to the LLM.

- Effort: 0.
- Risk: high to user trust and to the implicit contract in the prompt
  (which advertises long-running `reflect(promise)`).

### Recommendation: **1A**.

Maps to your preferences (explicit > clever, edge cases > speed). 1B's
pause/resume model is over-engineered for the failure modes we have;
1C breaks documented behavior.

**Open question for you:** when both deadlines are armable (e.g. a
short step that calls `reflect(longPromise)` 59s in), should the
extended deadline be `max(stepDeadline, now + reflectPromiseTimeoutMs)`
or simply `now + reflectPromiseTimeoutMs`? I'd default to `max(...)`
so promise-waits never *shorten* the budget; flag it if you'd rather
have the simpler "always the promise cap" semantics.

> **Decision required:** approve 1A (with `max(...)`) before I touch
> `runStep`?

---

## Issue 2 — `__callbackContext` stack is not concurrency-safe

### Problem

`__runTimerFire` (`src/prelude_v2.ts:354`) does:

```ts
__callbackContext.push(frame);
const r = entry.cb(...entry.args);
if (isThenable(r)) await r;
__callbackContext.pop();
```

A second timer can fire while the first is awaiting. If callback **A**
takes 200ms async and callback **B** is sync and fires at 50ms, B's
push/pop sandwiches A's pop — meaning when A finishes, it pops B's
frame (which is already gone), or worse, in a 3-deep race the popped
frame doesn't match the cb that just settled. The intent slot then
attaches to the wrong timer, so `reply()` inside A surfaces as B's
translated intent.

The bug is silent until you have two async callbacks racing. The
overlapping-async-timers test gap (test 10/T below) exists precisely
because this case isn't currently exercised.

### Options

**Option 2A — `AsyncLocalStorage` for the per-callback frame
(recommended).** Use `node:async_hooks`'s `AsyncLocalStorage` (Deno
ships it). Wrap each callback fire in `als.run(frame, () => cb(...))`.
The `__recordControl` helper (and the reflect/reply/abort wrappers)
read `als.getStore()` to find their frame. This naturally tracks the
async context across `await`s within a callback and isolates concurrent
callbacks from each other. No stack required.

- Effort: ~40 LoC; small refactor of `__recordControl` and the timer
  fire path.
- Risk: low. ALS is mature in Deno; semantics match the bug we have.
- Impact: contained to the prelude.
- Maintenance: one new dependency on `node:async_hooks`. We already
  emit `--unstable*` flags? — need to verify Deno permission model
  doesn't require an extra import permission. (Answer up front: no,
  `node:async_hooks` is built-in and freely importable.)

**Option 2B — Refuse async timer callbacks; require sync.** Detect the
returned thenable and reject (`wakeup_rejected: "timer callback must be
synchronous"`). Stack-pop ordering is then trivially safe.

- Effort: ~10 LoC.
- Risk: low for safety, high for ergonomics — the LLM patterns the
  prompt advertises (e.g. async checks inside an interval) become
  illegal. We'd need to update the prompt and likely contradict the
  reflect(promise) story.
- Impact: degrades user-facing behavior; some current tests will need
  rewriting.

**Option 2C — Per-microtask "current frame" using
`queueMicrotask`-tied identifier.** Tag each fire with a counter,
maintain a `Map<counter, frame>`, and resolve the active counter from
a getter. Equivalent to ALS but hand-rolled.

- Effort: ~30 LoC.
- Risk: medium — re-implementing what ALS already does.
- Impact: contained.
- Maintenance: more code than ALS, no upside.

### Recommendation: **2A**.

Explicit primitive built for this exact use case; matches your
explicit-over-clever preference. 2B sacrifices the sharpest async
patterns we just shipped; 2C is wheel-reinvention.

> **Decision required:** approve `AsyncLocalStorage` (option 2A)?

---

## Issue 3 — Rejected thenables in timer-callback `reflect(...)`

### Problem

The intent path (`__payloadFromControl` at `src/prelude_v2.ts:347`)
serializes whatever `reflect(...)` was called with. If the LLM does
`reflect(somePromise)` *inside a timer callback*, we currently store
`{ kind: "reflect", state: <Promise> }` and JSON-serialize it
downstream — yielding `{}` or, worse, tripping Deno's
unhandled-rejection killer when the promise rejects. The defensive
`.catch(() => {})` we added at `__dispatchTerminal` only protects the
top-level (per-step) reflect path.

### Options

**Option 3A — Reuse `__resolveReflectPromise` inside callback intents
(recommended).** When the timer fire detects `intent.kind === "reflect"
&& __isThenable(intent.state)`, route through the same
race-with-cancel-and-timeout helper used at the top level, using a
`p_<n>` wakeup id so the parent sees a `wakeup_scheduled (promise)`
followed by the resolved `wakeup_resolved` carrying the unwrapped
state. Behavior matches "as if the LLM had returned the promise from
the callback and we awaited it." Keeps a single code path for promise
unwrap.

- Effort: ~25 LoC; the helper is already there.
- Risk: low.
- Impact: contained.
- Maintenance: the unwrap path is now a single helper used in two
  places — DRY win.

**Option 3B — Refuse thenables passed to callback `reflect(...)`.**
Throw `"reflect(promise) inside a timer callback is not supported;
return the promise instead"`. Simpler, more explicit; loses some
flexibility. The pattern "schedule something inside a tick and reflect
on completion" forces the LLM to use the `return promise` path
instead, which we already support.

- Effort: ~5 LoC.
- Risk: low.
- Impact: prompt update needed.
- Maintenance: one less code path; one more rule for the LLM to
  remember.

**Option 3C — Do nothing; just attach a defensive `.catch(() => {})`
when the intent stores a thenable.** Stops the killer but the
serialized payload is still `{}` — the LLM sees nothing useful.

- Effort: ~3 LoC.
- Risk: high (silent data loss on rejection; payload `{}` on
  success).

### Recommendation: **3A**.

DRY (single unwrap path), matches the contract advertised in the
prompt, edge cases (rejection, cancel, timeout) are all already
covered by `__resolveReflectPromise`. 3B is defensible if you want
the smaller surface; mild preference for 3A.

> **Decision required:** approve 3A (reuse the unwrap helper) or
> prefer 3B (refuse thenables in callback intents)?

---

## Issue 4 — `__from_timer.delayMs` is wrong

### Problem

`buildWakeupReflectState` (`src/agent_session.ts:567`) emits
`delayMs: desc.resolvedAt - desc.scheduledAt` — that's *elapsed* wall
time, not the configured delay. For intervals, both fields exist only
on the resolution that emits a payload, so the value is "ms since the
interval was registered" rather than "interval period." The plan and
prompt advertise the configured delay.

### Options

**Option 4A — Thread configured `delayMs` through the wakeup pipeline
(recommended).** Add `delayMs?: number` to `FrameWakeupScheduled`
(set at register time in the prelude), persist it on
`WakeupDescriptor`, render it in the synthetic state. Cosmetic but
matches the documented contract.

- Effort: ~15 LoC across `types.ts`, `prelude_v2.ts`,
  `persistent_sandbox.ts`, `agent_session.ts`.
- Risk: trivial.
- Impact: a new optional field on the `wakeup_scheduled` frame —
  parent treats absent as "unknown", so backward-compatible.
- Maintenance: one extra field to keep in sync.

**Option 4B — Drop `delayMs` from the synthetic state entirely.**
Acknowledge that the value is rarely useful and the LLM can recover
the period from its own `setInterval(..., 30)` call. Keep `id` and
`kind` only.

- Effort: ~5 LoC.
- Risk: prompt update needed; LLM may have learned to read it.
- Impact: minor.

**Option 4C — Keep computing elapsed and rename to
`elapsedSinceScheduledMs`.** Honest about what we measure; doesn't
match the plan.

- Effort: ~5 LoC.
- Risk: contradicts plan/prompt language.

### Recommendation: **4A**.

The contract is already shipped (in the prompt) and this is the
straightforward way to honor it.

> **Decision required:** approve 4A?

---

## Test gaps (Decisions 10, 11, 13, 16)

These should land *with* the fixes — each fix needs a regression
test, and the existing suite has gaps that were called out in the
plan but not closed.

| Test                                           | Validates  | New file / location                                           |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------- |
| Overlapping async timer callbacks              | Issue 2    | `tests/integration/timer_concurrency_test.ts` — new test       |
| `reflect(promise)` > `stepTimeoutMs`           | Issue 1    | `tests/integration/wakeup_test.ts` — new test                  |
| `reflect(Promise.reject(...))` inside callback | Issue 3    | `tests/integration/wakeup_test.ts` — new test                  |
| Configured `delayMs` preserved in synthetic    | Issue 4    | `tests/integration/wakeup_test.ts` — extend existing assertion |
| Unit test for the prelude translator helper    | Decision 10 | `tests/unit/prelude_v2_translator_test.ts` — new file         |
| OOM / unexpected-exit recovery                 | Decision 16 | `tests/integration/persistent_sandbox_oom_test.ts` — new file |
| Loaded perf budget (5s, ~50ms cadence, with payloads) | Decision 13 | replace existing `perf budget` test with planned shape   |

For the translator unit test, the cleanest approach is to extract
`__payloadFromControl` (and a small "decide payload from intent +
return + autoWake" helper) to a non-prelude TS file we can import
directly. This avoids needing to spin up a sandbox just to verify a
pure function — and it's the kind of seam the plan asked for. **This
is itself a small refactor (~30 LoC) — flag it now: are you OK with
me lifting these helpers out of the prelude string into a sibling
module that the prelude imports as text?** If you'd rather keep the
prelude self-contained, I'll fall back to integration coverage and
drop the unit test.

> **Decision required:** approve the test list above? And: extract
> `__payloadFromControl` into `src/prelude_translator.ts` for unit
> testing, or keep it inline and skip the unit test?

---

## Suggested execution order

1. Issue 4 (smallest, lowest risk; gets the synthetic state honest
   before we add tests that read it).
2. Issue 2 (correctness foundation — the overlapping-timers test
   should fail without it, then pass).
3. Issue 1 (deadline rework + the `reflect(promise) > stepTimeoutMs`
   test).
4. Issue 3 (small, isolated; reuse the helper from #1's testing path).
5. Test gap closures last, since several depend on the fix code.
6. Re-run full integration suite.

Total estimate: ~3 hours including tests. If you want to defer any
issue, easiest deferral is #4 (cosmetic) followed by #3 (rare LLM
pattern).

---

## What I need from you to proceed

- Sign-off on each of issues 1–4 (option A unless you prefer
  otherwise).
- Sign-off on the test list and on the
  `src/prelude_translator.ts` extraction question.
- Confirm execution order — or tell me which subset to tackle first
  if you don't want everything in one pass.
