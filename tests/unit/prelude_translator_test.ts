// Unit tests for the pure helpers used by the prelude_v2 timer
// pipeline. These same functions are inlined verbatim into the
// generated subprocess script (see TRANSLATOR_INLINE in
// src/prelude_v2.ts), so testing them here in the host realm is also
// testing the runtime behavior — there's a single source of truth.

import { assertEquals } from "@std/assert";
import {
  __decideTimerPayload,
  __isControl,
  __payloadFromControl,
  __REX_TAG,
  type __ControlValue,
} from "../../src/prelude_translator.ts";

function reply(message: string): __ControlValue {
  return { [__REX_TAG]: true, kind: "reply", message } as unknown as __ControlValue;
}
function abort(error: string): __ControlValue {
  return { [__REX_TAG]: true, kind: "abort", error } as unknown as __ControlValue;
}
function reflect(state: unknown): __ControlValue {
  return { [__REX_TAG]: true, kind: "reflect", state } as unknown as __ControlValue;
}

Deno.test("__isControl recognises tagged values and rejects everything else", () => {
  assertEquals(__isControl(reply("hi")), true);
  assertEquals(__isControl(abort("err")), true);
  assertEquals(__isControl(reflect({ x: 1 })), true);
  assertEquals(__isControl(null), false);
  assertEquals(__isControl(undefined), false);
  assertEquals(__isControl({}), false);
  assertEquals(__isControl({ kind: "reply", message: "hi" }), false); // missing tag
  assertEquals(__isControl("reply"), false);
});

Deno.test("__payloadFromControl: reflect → state", () => {
  assertEquals(__payloadFromControl(reflect({ x: 1 })), { state: { x: 1 } });
  assertEquals(__payloadFromControl(reflect("abc")), { state: "abc" });
  // Reflect with undefined state still surfaces as a state-bearing payload.
  assertEquals(__payloadFromControl(reflect(undefined)), { state: undefined });
});

Deno.test("__payloadFromControl: reply → translated intent", () => {
  assertEquals(
    __payloadFromControl(reply("hello")),
    { intent: { kind: "reply", text: "hello" } },
  );
});

Deno.test("__payloadFromControl: abort → translated intent", () => {
  assertEquals(
    __payloadFromControl(abort("nope")),
    { intent: { kind: "abort", text: "nope" } },
  );
});

Deno.test("__decideTimerPayload: intent wins over the cb's return value", () => {
  // The cb both returned a control value AND set an intent inside.
  // The intent (recorded into the per-cb ALS frame) is authoritative —
  // whatever the cb returns is ignored when an intent was set.
  const intent = reply("captured-via-call");
  const result = reflect({ returned: true });
  const d = __decideTimerPayload(intent, result, /*autoWake*/ false);
  assertEquals(d.effectiveCtrl, intent);
  assertEquals(d.autoWakePayload, null);
});

Deno.test("__decideTimerPayload: returned control value used when no intent", () => {
  const result = reflect({ returned: true });
  const d = __decideTimerPayload(null, result, false);
  assertEquals(d.effectiveCtrl, result);
  assertEquals(d.autoWakePayload, null);
});

Deno.test("__decideTimerPayload: silent fall-through when no intent and no return ctrl", () => {
  const d = __decideTimerPayload(null, "some plain value", /*autoWake*/ false);
  assertEquals(d.effectiveCtrl, null);
  assertEquals(d.autoWakePayload, null);
});

Deno.test("__decideTimerPayload: autoWakeOnTimer surfaces the raw return as state", () => {
  const d = __decideTimerPayload(null, { return: "value" }, /*autoWake*/ true);
  assertEquals(d.effectiveCtrl, null);
  assertEquals(d.autoWakePayload, { state: { return: "value" } });
});

Deno.test("__decideTimerPayload: autoWake with control return still routes through effectiveCtrl", () => {
  // Even with autoWake on, an explicit reflect/reply/abort return wins
  // (so the LLM's intent isn't double-counted as both intent and state).
  const result = reflect("explicit");
  const d = __decideTimerPayload(null, result, /*autoWake*/ true);
  assertEquals(d.effectiveCtrl, result);
  assertEquals(d.autoWakePayload, null);
});
