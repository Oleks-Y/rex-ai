// Unit tests for the dreamer module — types, validation, and trigger
// matching. The runtime (DreamPool / DreamWorker) is exercised in
// integration tests once it lands.

import { assertEquals, assertThrows } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import {
  defineDreamer,
  dreamerMatches,
  dreamerTriggerKind,
  type DreamerDefinition,
  type DreamPayload,
} from "../../src/dreamer.ts";
import type { SandboxEvent } from "../../src/types.ts";

/** Minimal model stub — defineDreamer only checks truthiness; no calls. */
const STUB_MODEL = {
  specificationVersion: "v2",
  provider: "rex-mock",
  modelId: "rex-mock",
  supportedUrls: {},
  // deno-lint-ignore no-explicit-any
} as unknown as LanguageModelV2;

const VALID: DreamerDefinition = {
  name: "ticket-writer",
  triggers: ["reply"],
  model: STUB_MODEL,
  task: "Watch the agent's replies for unresolved issues.",
};

function withName(name: string): DreamerDefinition {
  return { ...VALID, name };
}

Deno.test("defineDreamer accepts a minimal valid definition", () => {
  const d = defineDreamer(VALID);
  assertEquals(d.name, "ticket-writer");
  assertEquals(d.triggers, ["reply"]);
});

Deno.test("defineDreamer rejects empty name", () => {
  assertThrows(
    () => defineDreamer(withName("")),
    Error,
    "non-empty string",
  );
});

Deno.test("defineDreamer rejects unsafe names", () => {
  // path-traversal style + slashes + leading dot + whitespace
  for (const n of ["..", "../x", "foo/bar", ".hidden", "foo bar", "/abs"]) {
    assertThrows(() => defineDreamer(withName(n)), Error, "filesystem-safe");
  }
});

Deno.test("defineDreamer accepts dashes, underscores, dots after first char", () => {
  for (const n of ["foo", "foo-bar", "foo_bar", "foo.bar", "f1", "F1-x_y.z"]) {
    defineDreamer(withName(n));
  }
});

Deno.test("defineDreamer rejects empty triggers array", () => {
  assertThrows(
    () => defineDreamer({ ...VALID, triggers: [] }),
    Error,
    "non-empty array",
  );
});

Deno.test("defineDreamer rejects unknown trigger", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => defineDreamer({ ...VALID, triggers: ["nope" as any] }),
    Error,
    `unknown trigger "nope"`,
  );
});

Deno.test("defineDreamer accepts dreamer-only triggers", () => {
  defineDreamer({ ...VALID, triggers: ["user_message"] });
  defineDreamer({ ...VALID, triggers: ["turn_end"] });
  defineDreamer({ ...VALID, triggers: ["reply", "user_message", "turn_end"] });
});

Deno.test("defineDreamer rejects missing model", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => defineDreamer({ ...VALID, model: undefined as any }),
    Error,
    "model",
  );
});

Deno.test("defineDreamer rejects empty task", () => {
  assertThrows(
    () => defineDreamer({ ...VALID, task: "" }),
    Error,
    "task",
  );
});

Deno.test("defineDreamer rejects non-positive maxStepsPerFire", () => {
  assertThrows(
    () => defineDreamer({ ...VALID, maxStepsPerFire: 0 }),
    Error,
    "positive integer",
  );
  assertThrows(
    () => defineDreamer({ ...VALID, maxStepsPerFire: -1 }),
    Error,
    "positive integer",
  );
  assertThrows(
    () => defineDreamer({ ...VALID, maxStepsPerFire: 1.5 }),
    Error,
    "positive integer",
  );
});

Deno.test("defineDreamer rejects unknown backpressure", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => defineDreamer({ ...VALID, backpressure: "burn" as any }),
    Error,
    "unknown backpressure",
  );
});

Deno.test("defineDreamer accepts all valid backpressure policies", () => {
  for (const bp of ["queue", "drop_newest", "drop_oldest", "coalesce"] as const) {
    defineDreamer({ ...VALID, backpressure: bp });
  }
});

Deno.test("defineDreamer rejects non-positive fireTimeoutMs / maxQueueDepth", () => {
  assertThrows(() => defineDreamer({ ...VALID, fireTimeoutMs: 0 }), Error, "positive integer");
  assertThrows(() => defineDreamer({ ...VALID, maxQueueDepth: 0 }), Error, "positive integer");
});

// ── dreamerMatches ─────────────────────────────────────────────────────

function payloadForEvent(ev: SandboxEvent): DreamPayload {
  return {
    event: ev,
    llmCompletion: "",
    code: "",
    stepIndex: 1,
    task: "t",
    userInputs: [{ kind: "task", content: "t", turn: 1 }],
    turn: 1,
  };
}

const REPLY_PAYLOAD = payloadForEvent({
  kind: "reply",
  message: "ok",
  logs: [],
});

const REFLECT_PAYLOAD = payloadForEvent({
  kind: "reflect",
  state: { x: 1 },
  logs: [],
});

Deno.test("dreamerMatches: explicit trigger matches event.kind", () => {
  assertEquals(dreamerMatches({ ...VALID, triggers: ["reply"] }, REPLY_PAYLOAD), true);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["reflect"] }, REPLY_PAYLOAD), false);
});

Deno.test('dreamerMatches: "any" matches every sandbox event', () => {
  assertEquals(dreamerMatches({ ...VALID, triggers: ["any"] }, REPLY_PAYLOAD), true);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["any"] }, REFLECT_PAYLOAD), true);
});

Deno.test('dreamerMatches: "any" does NOT match synthetic triggers', () => {
  // Critical invariant: a dreamer subscribed to "any" should not be
  // surprised by conversation-level triggers it didn't ask for.
  const p: DreamPayload = {
    ...REPLY_PAYLOAD,
    syntheticTrigger: "user_message",
  };
  assertEquals(dreamerMatches({ ...VALID, triggers: ["any"] }, p), false);
});

Deno.test("dreamerMatches: synthetic triggers require explicit subscription", () => {
  const userMsg: DreamPayload = { ...REPLY_PAYLOAD, syntheticTrigger: "user_message" };
  const turnEnd: DreamPayload = { ...REPLY_PAYLOAD, syntheticTrigger: "turn_end" };
  assertEquals(dreamerMatches({ ...VALID, triggers: ["user_message"] }, userMsg), true);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["user_message"] }, turnEnd), false);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["turn_end"] }, turnEnd), true);
});

// ── dreamerTriggerKind ─────────────────────────────────────────────────

Deno.test("dreamerTriggerKind: sandbox event returns event.kind", () => {
  assertEquals(dreamerTriggerKind(REPLY_PAYLOAD), "reply");
  assertEquals(dreamerTriggerKind(REFLECT_PAYLOAD), "reflect");
});

Deno.test("dreamerTriggerKind: synthetic trigger takes precedence", () => {
  const p: DreamPayload = { ...REPLY_PAYLOAD, syntheticTrigger: "user_message" };
  assertEquals(dreamerTriggerKind(p), "user_message");
});
