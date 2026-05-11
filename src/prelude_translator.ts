// Pure helpers shared between the runtime prelude and unit tests.
//
// These functions decide, given a fired timer callback's outcome, what
// (if any) payload the prelude should emit on `wakeup_resolved`. They
// are pure (no I/O, no awaits), so they can be tested directly without
// spinning up a sandbox.
//
// At PreludeV2.build time the host reads this file's source verbatim
// and inlines it into the generated subprocess script (with `export `
// stripped). That keeps the runtime and the unit-tested code as the
// same bytes — no risk of silent drift between two parallel
// implementations.
//
// `Symbol.for("rex.control")` is realm-bound, so a control value
// constructed in the host realm (a test) is recognized by the runtime
// check below the same way a value constructed in the subprocess is.

export const __REX_TAG: symbol = Symbol.for("rex.control");

export type __ControlValue =
  | { kind: "reply"; message: string }
  | { kind: "abort"; error: string }
  | { kind: "reflect"; state: unknown };

export function __isControl(v: unknown): v is __ControlValue {
  return !!v && typeof v === "object" &&
    (v as Record<symbol, unknown>)[__REX_TAG] === true;
}

export interface __TimerPayload {
  state?: unknown;
  intent?: { kind: "reply" | "abort"; text: string };
}

export function __payloadFromControl(c: __ControlValue): __TimerPayload {
  if (c.kind === "reflect") return { state: c.state };
  if (c.kind === "reply") return { intent: { kind: "reply", text: c.message } };
  return { intent: { kind: "abort", text: c.error } };
}

// Pre-async decision for what a fired timer callback should produce.
//
//   - `intent` — control value captured via reply/abort/reflect inside
//     the cb (recorded into the per-callback ALS frame). Wins over the
//     cb's return value.
//   - `result` — the cb's returned value. If it's itself a control
//     value, it becomes the effective control. Otherwise (and the cb
//     made no intent call), it falls through.
//   - `autoWakeOnTimer` — host policy. When true, a fall-through cb
//     still wakes the agent with the raw return value as state.
//
// Returns:
//   - `effectiveCtrl`: the control value (if any) that downstream
//     async logic should `__payloadFromControl` / unwrap if it carries
//     a thenable.
//   - `autoWakePayload`: a ready-to-emit payload, set only when the
//     auto-wake fall-through fires.
//
// Both null → the cb had no intent and no auto-wake → silent tick.
export function __decideTimerPayload(
  intent: __ControlValue | null,
  result: unknown,
  autoWakeOnTimer: boolean,
): { effectiveCtrl: __ControlValue | null; autoWakePayload: __TimerPayload | null } {
  if (intent) return { effectiveCtrl: intent, autoWakePayload: null };
  if (__isControl(result)) return { effectiveCtrl: result, autoWakePayload: null };
  if (autoWakeOnTimer) return { effectiveCtrl: null, autoWakePayload: { state: result } };
  return { effectiveCtrl: null, autoWakePayload: null };
}
