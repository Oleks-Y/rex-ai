// Unit tests for the guardrail module — pure logic, no real model calls.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import {
  buildAuditLog,
  defineGuardrail,
  type GuardrailContext,
  type GuardrailDefinition,
  type GuardrailEvaluation,
  GuardrailRunner,
  matchesTrigger,
  MISSING_CONTROL_FN_PATTERN,
  parseVerdict,
  reflectBeforeReplyGuardrail,
  reflectInCallbackGuardrail,
  retryOnMissingControlFnGuardrail,
} from "../../src/guardrail.ts";
import type { SandboxEvent } from "../../src/types.ts";

/** Scripted model: returns each entry in order. Captures prompts for inspection. */
function scriptModel(outputs: string[]): { model: LanguageModelV2; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: (opts) => {
      prompts.push(JSON.stringify(opts.prompt));
      const text = outputs[i] ?? outputs[outputs.length - 1] ?? "";
      i++;
      return Promise.resolve({
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text", text }],
        warnings: [],
      });
    },
    doStream: () => {
      throw new Error("not implemented");
    },
  };
  return { model, prompts };
}

function throwingModel(message: string): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-throw",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error(message)),
    doStream: () => {
      throw new Error("not implemented");
    },
  };
}

function mkGuardrail(over: Partial<GuardrailDefinition> = {}): GuardrailDefinition {
  return defineGuardrail({
    name: "test-guard",
    triggers: ["reply"],
    model: scriptModel(['{"ok": true}']).model,
    instructions: "Never allow profanity in replies.",
    ...over,
  });
}

function mkReplyEvent(message = "hello"): SandboxEvent {
  return { kind: "reply", message, logs: [] };
}

function mkContext(over: Partial<GuardrailContext> = {}): GuardrailContext {
  return {
    event: mkReplyEvent(),
    code: 'await reply("hello");',
    stepIndex: 1,
    task: "say hello",
    priorSteps: [],
    ...over,
  };
}

// ── defineGuardrail validation ───────────────────────────────────────────

Deno.test("defineGuardrail: empty name rejected", () => {
  assertThrows(
    () =>
      defineGuardrail({
        name: "",
        triggers: ["reply"],
        model: scriptModel(['{"ok": true}']).model,
        instructions: "x",
      }),
    Error,
    "name",
  );
});

Deno.test("defineGuardrail: empty triggers rejected", () => {
  assertThrows(
    () =>
      defineGuardrail({
        name: "g",
        triggers: [],
        model: scriptModel(['{"ok": true}']).model,
        instructions: "x",
      }),
    Error,
    "triggers",
  );
});

Deno.test("defineGuardrail: unknown trigger rejected", () => {
  assertThrows(
    () =>
      defineGuardrail({
        name: "g",
        // deno-lint-ignore no-explicit-any
        triggers: ["banana" as any],
        model: scriptModel(['{"ok": true}']).model,
        instructions: "x",
      }),
    Error,
    "banana",
  );
});

Deno.test("defineGuardrail: missing instructions rejected", () => {
  assertThrows(
    () =>
      defineGuardrail({
        name: "g",
        triggers: ["reply"],
        model: scriptModel(['{"ok": true}']).model,
        instructions: "",
      }),
    Error,
    "instructions",
  );
});

// ── matchesTrigger ───────────────────────────────────────────────────────

Deno.test("matchesTrigger: kind-specific trigger", () => {
  const g = mkGuardrail({ triggers: ["reply"] });
  assert(matchesTrigger(g, mkReplyEvent()));
  assert(!matchesTrigger(g, { kind: "abort", error: "no", logs: [] }));
  assert(!matchesTrigger(g, { kind: "reflect", state: 1, logs: [] }));
});

Deno.test("matchesTrigger: multiple triggers", () => {
  const g = mkGuardrail({ triggers: ["reply", "reflect"] });
  assert(matchesTrigger(g, mkReplyEvent()));
  assert(matchesTrigger(g, { kind: "reflect", state: 1, logs: [] }));
  assert(!matchesTrigger(g, { kind: "abort", error: "x", logs: [] }));
});

Deno.test('matchesTrigger: "any" matches every kind', () => {
  const g = mkGuardrail({ triggers: ["any"] });
  const events: SandboxEvent[] = [
    mkReplyEvent(),
    { kind: "abort", error: "x", logs: [] },
    { kind: "reflect", state: 1, logs: [] },
    { kind: "permission_denied", permission: "net", target: "x", logs: [] },
    { kind: "throw", error: "x", logs: [] },
  ];
  for (const ev of events) {
    assert(matchesTrigger(g, ev), `expected ${ev.kind} to match`);
  }
});

// ── parseVerdict ─────────────────────────────────────────────────────────

Deno.test("parseVerdict: bare ok=true object", () => {
  assertEquals(parseVerdict('{"ok": true}'), { ok: true });
});

Deno.test("parseVerdict: ok=false with reason", () => {
  assertEquals(parseVerdict('{"ok": false, "reason": "contains profanity"}'), {
    ok: false,
    reason: "contains profanity",
  });
});

Deno.test("parseVerdict: ok=false without reason → default", () => {
  const v = parseVerdict('{"ok": false}');
  assertEquals(v, { ok: false, reason: "blocked (no reason provided)" });
});

Deno.test("parseVerdict: JSON embedded in prose", () => {
  const text = 'Looks fine to me. Verdict: {"ok": true} — proceed.';
  assertEquals(parseVerdict(text), { ok: true });
});

Deno.test("parseVerdict: JSON inside code fence-ish prose", () => {
  const text = '```json\n{"ok": false, "reason": "policy violation"}\n```';
  assertEquals(parseVerdict(text), { ok: false, reason: "policy violation" });
});

Deno.test("parseVerdict: braces inside string literals are not counted", () => {
  const text = '{"ok": true, "note": "ignore { and } in this string"}';
  assertEquals(parseVerdict(text), { ok: true });
});

Deno.test("parseVerdict: no JSON → throws", () => {
  assertThrows(() => parseVerdict("no json here"), Error, "no JSON object");
});

Deno.test("parseVerdict: malformed JSON → throws", () => {
  assertThrows(() => parseVerdict("{not: json}"), Error, "JSON parse failed");
});

Deno.test("parseVerdict: missing ok field → throws", () => {
  assertThrows(() => parseVerdict('{"reason": "x"}'), Error, '"ok"');
});

Deno.test("parseVerdict: ok must be boolean", () => {
  assertThrows(() => parseVerdict('{"ok": "yes"}'), Error, '"ok"');
});

// ── buildAuditLog ────────────────────────────────────────────────────────

Deno.test("buildAuditLog: contains task, instructions, and current step heading", () => {
  const g = mkGuardrail({ instructions: "Block any reply containing 'badword'." });
  const audit = buildAuditLog(g, mkContext({ task: "answer the user" }));
  assertStringIncludes(audit, "# Guardrail audit — test-guard");
  assertStringIncludes(audit, "Block any reply containing 'badword'.");
  assertStringIncludes(audit, "## Task\nanswer the user");
  assertStringIncludes(audit, "## CURRENT STEP (under review)");
  assertStringIncludes(audit, "Event: reply — hello");
  assertStringIncludes(audit, '{"ok": true}');
});

Deno.test("buildAuditLog: renders priorSteps before current step", () => {
  const g = mkGuardrail();
  const ctx = mkContext({
    priorSteps: [
      {
        code: 'console.log("hi"); return reflect({ done: false });',
        event: { kind: "reflect", state: { done: false }, logs: [
          { level: "log", args: ["debug:", 42] },
        ] },
      },
    ],
  });
  const audit = buildAuditLog(g, ctx);
  // Prior step section
  assertStringIncludes(audit, "## Prior steps");
  assertStringIncludes(audit, "### step 1");
  assertStringIncludes(audit, 'console.log("hi")');
  assertStringIncludes(audit, '[log] debug: 42');
  // Current section follows
  const priorIdx = audit.indexOf("## Prior steps");
  const currentIdx = audit.indexOf("## CURRENT STEP (under review)");
  assert(priorIdx < currentIdx, "prior steps should come before current step");
});

Deno.test("buildAuditLog: log truncation by byte budget", () => {
  const g = mkGuardrail({ maxLogsBytesPerStep: 50 });
  // Build many log lines, each ~30 bytes; budget 50 should drop most of them.
  const logs = Array.from({ length: 20 }, (_, i) => ({
    level: "log" as const,
    args: [`line ${i} with some padding text`],
  }));
  const ctx = mkContext({
    priorSteps: [{
      code: "step",
      event: { kind: "reflect", state: 1, logs },
    }],
  });
  const audit = buildAuditLog(g, ctx);
  assertStringIncludes(audit, "[log truncated —");
  // First couple of lines should still appear
  assertStringIncludes(audit, "[log] line 0");
});

Deno.test("buildAuditLog: zero log budget keeps no logs but still shows kind", () => {
  const g = mkGuardrail({ maxLogsBytesPerStep: 0 });
  const ctx = mkContext({
    priorSteps: [{
      code: "step",
      event: {
        kind: "reflect",
        state: 1,
        logs: [{ level: "log", args: ["whatever"] }],
      },
    }],
  });
  const audit = buildAuditLog(g, ctx);
  // budget 0 -> entire first iteration fails the budget check, truncation marker
  assertStringIncludes(audit, "[log truncated —");
});

Deno.test("buildAuditLog: event payload clipped by maxEventBytes", () => {
  const g = mkGuardrail({ maxEventBytes: 20 });
  const ctx = mkContext({
    event: {
      kind: "reply",
      message: "a".repeat(200),
      logs: [],
    },
  });
  const audit = buildAuditLog(g, ctx);
  assertStringIncludes(audit, "[clipped");
});

Deno.test("buildAuditLog: priorSteps section omitted when empty", () => {
  const g = mkGuardrail();
  const audit = buildAuditLog(g, mkContext({ priorSteps: [] }));
  assertEquals(audit.includes("## Prior steps"), false);
});

// ── GuardrailRunner.evaluate ─────────────────────────────────────────────

Deno.test("evaluate: empty guardrails returns []", async () => {
  const evals = await GuardrailRunner.evaluate([], mkContext());
  assertEquals(evals, []);
});

Deno.test("evaluate: non-matching guardrail is skipped", async () => {
  const g = mkGuardrail({ triggers: ["abort"] });
  const evals = await GuardrailRunner.evaluate([g], mkContext({ event: mkReplyEvent() }));
  assertEquals(evals, []);
});

Deno.test("evaluate: allow path produces { ok: true }", async () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = mkGuardrail({ model });
  const evals = await GuardrailRunner.evaluate([g], mkContext());
  assertEquals(evals.length, 1);
  assertEquals(evals[0].guardrail, "test-guard");
  assertEquals(evals[0].verdict, { ok: true });
});

Deno.test("evaluate: block path produces { ok: false, reason }", async () => {
  const { model } = scriptModel(['{"ok": false, "reason": "policy violation"}']);
  const g = mkGuardrail({ model });
  const evals = await GuardrailRunner.evaluate([g], mkContext());
  assertEquals(evals[0].verdict, { ok: false, reason: "policy violation" });
});

Deno.test("evaluate: first block stops the chain", async () => {
  const { model: m1 } = scriptModel(['{"ok": true}']);
  const { model: m2 } = scriptModel(['{"ok": false, "reason": "no"}']);
  const m3called = { v: false };
  const m3: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "third",
    supportedUrls: {},
    doGenerate: () => {
      m3called.v = true;
      return Promise.resolve({
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text", text: '{"ok": true}' }],
        warnings: [],
      });
    },
    doStream: () => {
      throw new Error("nope");
    },
  };
  const g1 = mkGuardrail({ name: "g1", model: m1 });
  const g2 = mkGuardrail({ name: "g2", model: m2 });
  const g3 = mkGuardrail({ name: "g3", model: m3 });
  const evals = await GuardrailRunner.evaluate([g1, g2, g3], mkContext());
  assertEquals(evals.length, 2);
  assertEquals(evals[0].verdict, { ok: true });
  assertEquals(evals[1].verdict.ok, false);
  assertEquals(m3called.v, false, "third guardrail must not be called");
});

Deno.test("evaluate: model throws → passOnError=true returns ok:true with error", async () => {
  const g = mkGuardrail({ model: throwingModel("boom"), passOnError: true });
  const evals = await GuardrailRunner.evaluate([g], mkContext());
  assertEquals(evals[0].verdict, { ok: true });
  assertEquals(evals[0].evaluationError, "boom");
});

Deno.test("evaluate: model throws → passOnError=false produces a block", async () => {
  const g = mkGuardrail({ model: throwingModel("boom"), passOnError: false });
  const evals = await GuardrailRunner.evaluate([g], mkContext());
  assertEquals(evals[0].verdict.ok, false);
  assert(!evals[0].verdict.ok && evals[0].verdict.reason.includes("boom"));
  assertEquals(evals[0].evaluationError, "boom");
});

Deno.test("evaluate: malformed model output → passOnError default (true) passes", async () => {
  const { model } = scriptModel(["not json at all"]);
  const g = mkGuardrail({ model });
  const evals = await GuardrailRunner.evaluate([g], mkContext());
  assertEquals(evals[0].verdict, { ok: true });
  assert(evals[0].evaluationError !== undefined);
});

Deno.test("blockedEvent: produces guardrail_blocked, preserves logs + originalKind + original payload", () => {
  const original: SandboxEvent = {
    kind: "reply",
    message: "hi",
    logs: [{ level: "log", args: ["trace"] }],
  };
  const blocking: GuardrailEvaluation = {
    guardrail: "no-profanity",
    verdict: { ok: false, reason: "contains profanity" },
  };
  const blocked = GuardrailRunner.blockedEvent(original, blocking);
  assertEquals(blocked.kind, "guardrail_blocked");
  assert(blocked.kind === "guardrail_blocked");
  assertEquals(blocked.guardrail, "no-profanity");
  assertEquals(blocked.reason, "contains profanity");
  assertEquals(blocked.originalKind, "reply");
  assertEquals(blocked.original, { kind: "reply", message: "hi" });
  assertEquals(blocked.logs.length, 1);
});

Deno.test("blockedEvent: preserves the full original payload (not just originalKind) for each kind", () => {
  const blocking: GuardrailEvaluation = {
    guardrail: "g",
    verdict: { ok: false, reason: "r" },
  };
  const cases: { ev: SandboxEvent; expected: unknown }[] = [
    {
      ev: { kind: "reply", message: "m", logs: [] },
      expected: { kind: "reply", message: "m" },
    },
    {
      ev: { kind: "abort", error: "e", logs: [] },
      expected: { kind: "abort", error: "e" },
    },
    {
      ev: { kind: "reflect", state: { n: 1 }, logs: [] },
      expected: { kind: "reflect", state: { n: 1 } },
    },
    {
      ev: { kind: "permission_denied", permission: "net", target: "t", logs: [] },
      expected: { kind: "permission_denied", permission: "net", target: "t" },
    },
    {
      ev: { kind: "throw", error: "x", logs: [] },
      expected: { kind: "throw", error: "x" },
    },
  ];
  for (const { ev, expected } of cases) {
    const blocked = GuardrailRunner.blockedEvent(ev, blocking);
    assert(blocked.kind === "guardrail_blocked");
    assertEquals(blocked.originalKind, ev.kind);
    assertEquals(blocked.original, expected);
  }
});

Deno.test("blockedEvent: evaluation-error verdict surfaces 'evaluation error' reason", () => {
  const blocking: GuardrailEvaluation = {
    guardrail: "g",
    verdict: { ok: true },
    evaluationError: "boom",
  };
  const blocked = GuardrailRunner.blockedEvent(
    { kind: "reply", message: "x", logs: [] },
    blocking,
  );
  assert(blocked.kind === "guardrail_blocked");
  assertEquals(blocked.reason, "evaluation error");
});

Deno.test("firstBlock: returns null on all-allow", () => {
  const evals: GuardrailEvaluation[] = [
    { guardrail: "a", verdict: { ok: true } },
    { guardrail: "b", verdict: { ok: true } },
  ];
  assertEquals(GuardrailRunner.firstBlock(evals), null);
});

Deno.test("firstBlock: returns first blocking evaluation", () => {
  const evals: GuardrailEvaluation[] = [
    { guardrail: "a", verdict: { ok: true } },
    { guardrail: "b", verdict: { ok: false, reason: "x" } },
    { guardrail: "c", verdict: { ok: false, reason: "y" } },
  ];
  assertEquals(GuardrailRunner.firstBlock(evals)?.guardrail, "b");
});

// ── reflectBeforeReplyGuardrail ──────────────────────────────────────────

Deno.test("reflectBeforeReplyGuardrail: shape — name, trigger, fail-closed default", () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = reflectBeforeReplyGuardrail({ model });
  assertEquals(g.name, "reflect-before-reply");
  assertEquals(g.triggers, ["reply"]);
  assertEquals(g.passOnError, false);
  // Factory always sets `instructions`; assert narrows the union for the
  // assertStringIncludes calls below.
  assert(typeof g.instructions === "string");
  assertStringIncludes(g.instructions, "reflect");
  assertStringIncludes(g.instructions, "reply");
});

Deno.test("reflectBeforeReplyGuardrail: name override", () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = reflectBeforeReplyGuardrail({ model, name: "strict-reply" });
  assertEquals(g.name, "strict-reply");
});

Deno.test("reflectBeforeReplyGuardrail: passOnError override", () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = reflectBeforeReplyGuardrail({ model, passOnError: true });
  assertEquals(g.passOnError, true);
});

Deno.test("reflectBeforeReplyGuardrail: does not match non-reply events", () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = reflectBeforeReplyGuardrail({ model });
  assert(!matchesTrigger(g, { kind: "reflect", state: 1, logs: [] }));
  assert(!matchesTrigger(g, { kind: "abort", error: "x", logs: [] }));
  assert(matchesTrigger(g, mkReplyEvent()));
});

Deno.test("reflectBeforeReplyGuardrail: matching reply is fed to model", async () => {
  const { model, prompts } = scriptModel([
    '{"ok": false, "reason": "no prior reflect step inspected the data"}',
  ]);
  const g = reflectBeforeReplyGuardrail({ model });
  const evals = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "reply", message: "You have 7 unread issues.", logs: [] },
    priorSteps: [], // no prior reflect
  }));
  assertEquals(evals.length, 1);
  assertEquals(evals[0].verdict.ok, false);
  assertEquals(prompts.length, 1);
  // The audit must include the policy instructions.
  assertStringIncludes(prompts[0], "preceded by at least one prior step");
});

// ── reflectInCallbackGuardrail ───────────────────────────────────────────

Deno.test("reflectInCallbackGuardrail: shape — name, any-trigger, fail-closed default", () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = reflectInCallbackGuardrail({ model });
  assertEquals(g.name, "reflect-in-callback");
  assertEquals(g.triggers, ["any"]);
  assertEquals(g.passOnError, false);
  assert(typeof g.instructions === "string");
  assertStringIncludes(g.instructions, "setTimeout");
  assertStringIncludes(g.instructions, "setInterval");
  assertStringIncludes(g.instructions, "reflect");
});

Deno.test("reflectInCallbackGuardrail: matches every event kind", () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = reflectInCallbackGuardrail({ model });
  const events: SandboxEvent[] = [
    mkReplyEvent(),
    { kind: "abort", error: "x", logs: [] },
    { kind: "reflect", state: 1, logs: [] },
    { kind: "permission_denied", permission: "net", target: "x", logs: [] },
    { kind: "throw", error: "x", logs: [] },
  ];
  for (const ev of events) {
    assert(matchesTrigger(g, ev), `expected ${ev.kind} to match`);
  }
});

Deno.test("reflectInCallbackGuardrail: model sees the step's code", async () => {
  const { model, prompts } = scriptModel([
    '{"ok": false, "reason": "setInterval callback calls reply()"}',
  ]);
  const g = reflectInCallbackGuardrail({ model });
  const offendingCode = [
    "setInterval(async () => {",
    "  const data = await fetchSomething();",
    "  if (data.alarming) reply('Alert: ' + data.kind);",
    "}, 30_000);",
    "return reply('Watching.');",
  ].join("\n");
  const evals = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "reply", message: "Watching.", logs: [] },
    code: offendingCode,
  }));
  assertEquals(evals.length, 1);
  assertEquals(evals[0].verdict.ok, false);
  // Audit must surface the code so the model can spot the violation.
  assertStringIncludes(prompts[0], "setInterval(async");
  assertStringIncludes(prompts[0], "reply('Alert");
});

Deno.test("reflectInCallbackGuardrail: clean code passes when model says ok", async () => {
  const { model } = scriptModel(['{"ok": true}']);
  const g = reflectInCallbackGuardrail({ model });
  const cleanCode = [
    "setInterval(async () => {",
    "  const data = await fetchSomething();",
    "  if (data.alarming) reflect({ alert: data.kind });",
    "}, 30_000);",
    "return reply('Watching.');",
  ].join("\n");
  const evals = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "reply", message: "Watching.", logs: [] },
    code: cleanCode,
  }));
  assertEquals(evals[0].verdict.ok, true);
});

Deno.test("reflectInCallbackGuardrail: model failure under fail-closed produces block", async () => {
  const g = reflectInCallbackGuardrail({ model: throwingModel("upstream 500") });
  const evals = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "reflect", state: 1, logs: [] },
  }));
  assertEquals(evals[0].verdict.ok, false);
  assert(!evals[0].verdict.ok && evals[0].verdict.reason.includes("upstream 500"));
});

// ── deterministic-check path ─────────────────────────────────────────────

Deno.test("defineGuardrail: check callback can replace model+instructions", () => {
  const g = defineGuardrail({
    name: "static",
    triggers: ["any"],
    check: () => ({ ok: true }),
  });
  assertEquals(g.name, "static");
  assertEquals(g.check !== undefined, true);
});

Deno.test("defineGuardrail: missing both check AND model rejects", () => {
  assertThrows(
    () =>
      defineGuardrail({
        name: "g",
        triggers: ["reply"],
        instructions: "x",
      }),
    Error,
    "model",
  );
});

Deno.test("defineGuardrail: check must be a function when provided", () => {
  assertThrows(
    () =>
      defineGuardrail({
        name: "g",
        triggers: ["reply"],
        // deno-lint-ignore no-explicit-any
        check: "not a function" as any,
      }),
    Error,
    "check",
  );
});

Deno.test("evaluate: check path does not call any model", async () => {
  let modelCalls = 0;
  const sentinelModel: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "should-not-be-called",
    supportedUrls: {},
    doGenerate: () => {
      modelCalls++;
      return Promise.reject(new Error("nope"));
    },
    doStream: () => {
      throw new Error("nope");
    },
  };
  const g = defineGuardrail({
    name: "static-block",
    triggers: ["reply"],
    model: sentinelModel, // tolerated but unused
    check: () => ({ ok: false, reason: "blocked by rule" }),
  });
  const evals = await GuardrailRunner.evaluate([g], mkContext());
  assertEquals(modelCalls, 0);
  assertEquals(evals.length, 1);
  assertEquals(evals[0].verdict, { ok: false, reason: "blocked by rule" });
});

Deno.test("evaluate: check can be async and returns its verdict", async () => {
  const g = defineGuardrail({
    name: "async-check",
    triggers: ["any"],
    check: async (ctx) => {
      await Promise.resolve();
      return ctx.event.kind === "abort"
        ? { ok: false, reason: "no aborts" }
        : { ok: true };
    },
  });
  const ok = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "reflect", state: 1, logs: [] },
  }));
  assertEquals(ok[0].verdict, { ok: true });
  const blocked = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "abort", error: "boom", logs: [] },
  }));
  assertEquals(blocked[0].verdict.ok, false);
});

Deno.test("evaluate: check that throws → passOnError respected", async () => {
  // Default fail-closed: throwing check produces a block.
  const failClosed = defineGuardrail({
    name: "throws-closed",
    triggers: ["any"],
    check: () => { throw new Error("regex broke"); },
    // passOnError default = undefined; passOnError !== false → fail-open
    // by convention. We want explicit fail-closed here.
    passOnError: false,
  });
  const e1 = await GuardrailRunner.evaluate([failClosed], mkContext());
  assertEquals(e1[0].verdict.ok, false);
  assertEquals(e1[0].evaluationError, "regex broke");

  // Fail-open: throwing check produces an allow + evaluationError.
  const failOpen = defineGuardrail({
    name: "throws-open",
    triggers: ["any"],
    check: () => { throw new Error("regex broke"); },
    passOnError: true,
  });
  const e2 = await GuardrailRunner.evaluate([failOpen], mkContext());
  assertEquals(e2[0].verdict, { ok: true });
  assertEquals(e2[0].evaluationError, "regex broke");
});

// ── retryOnMissingControlFnGuardrail ─────────────────────────────────────

Deno.test("MISSING_CONTROL_FN_PATTERN: matches the exact prelude wording", () => {
  const real = "agent code finished without calling or returning reply(), abort(), or reflect()";
  assert(MISSING_CONTROL_FN_PATTERN.test(real));
});

Deno.test("MISSING_CONTROL_FN_PATTERN: does not match unrelated aborts", () => {
  assert(!MISSING_CONTROL_FN_PATTERN.test("missing API key"));
  assert(!MISSING_CONTROL_FN_PATTERN.test("permission denied"));
  assert(!MISSING_CONTROL_FN_PATTERN.test(""));
});

Deno.test("retryOnMissingControlFnGuardrail: shape — name + abort trigger + check", () => {
  const g = retryOnMissingControlFnGuardrail();
  assertEquals(g.name, "retry-on-missing-control-fn");
  assertEquals(g.triggers, ["abort"]);
  assertEquals(g.passOnError, false);
  assertEquals(g.check !== undefined, true);
  assertEquals(g.model, undefined);
});

Deno.test("retryOnMissingControlFnGuardrail: name override", () => {
  const g = retryOnMissingControlFnGuardrail({ name: "missing-ctl" });
  assertEquals(g.name, "missing-ctl");
});

Deno.test("retryOnMissingControlFnGuardrail: blocks the prelude-emitted abort", async () => {
  const g = retryOnMissingControlFnGuardrail();
  const evals = await GuardrailRunner.evaluate([g], mkContext({
    event: {
      kind: "abort",
      error:
        "agent code finished without calling or returning reply(), abort(), or reflect()",
      logs: [],
    },
  }));
  assertEquals(evals[0].verdict.ok, false);
  assert(!evals[0].verdict.ok);
  assertStringIncludes(evals[0].verdict.reason, "reply()");
  assertStringIncludes(evals[0].verdict.reason, "Revise");
});

Deno.test("retryOnMissingControlFnGuardrail: passes through user-emitted aborts", async () => {
  const g = retryOnMissingControlFnGuardrail();
  const evals = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "abort", error: "missing API key", logs: [] },
  }));
  // Other aborts are real refusals — they MUST remain terminal.
  assertEquals(evals[0].verdict, { ok: true });
});

Deno.test("retryOnMissingControlFnGuardrail: doesn't fire on non-abort kinds", async () => {
  const g = retryOnMissingControlFnGuardrail();
  // reflect / reply / etc. don't match the trigger — evaluate returns [].
  const r = await GuardrailRunner.evaluate([g], mkContext({
    event: { kind: "reflect", state: 1, logs: [] },
  }));
  assertEquals(r, []);
});
