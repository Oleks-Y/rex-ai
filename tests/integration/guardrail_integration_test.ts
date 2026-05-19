// Integration tests for guardrails — drive the full Agent loop with a
// scripted main model + scripted guardrail model. Exercises:
//   - guardrail blocks a reply → loop continues with a guardrail_blocked
//     step in priorSteps; the model retries and a follow-up clean reply
//     becomes the run's terminal result.
//   - guardrail allows a reply → behavior identical to no guardrail
//   - guardrail doesn't fire on non-matching event kinds
//   - guardrail blocking a reflect → loop continues, model can revise
//   - multiple guardrails, second blocks → first allow recorded, second
//     block applied, third (if any) skipped

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent } from "../../src/agent.ts";
import { defineGuardrail, type GuardrailEvaluation } from "../../src/guardrail.ts";
import type { StepRecord } from "../../src/types.ts";

/** Main model: returns scripted fenced TS blocks. */
function mockMainModel(scripts: string[]): { model: LanguageModelV2 } {
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-main",
    supportedUrls: {},
    doGenerate: () => {
      const next = scripts[i] ?? scripts[scripts.length - 1];
      i++;
      const text = "```ts\n" + next + "\n```";
      return Promise.resolve({
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        content: [{ type: "text", text }],
        warnings: [],
      });
    },
    doStream: () => {
      throw new Error("not implemented");
    },
  };
  return { model };
}

/** Guardrail model: returns scripted plain-JSON verdicts. Captures prompts
 *  so tests can assert the guardrail saw the audit doc. */
function mockGuardrailModel(outputs: string[]): {
  model: LanguageModelV2;
  prompts: string[];
} {
  const prompts: string[] = [];
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-guard",
    supportedUrls: {},
    doGenerate: (opts) => {
      prompts.push(JSON.stringify(opts.prompt));
      const text = outputs[i] ?? outputs[outputs.length - 1] ?? '{"ok": true}';
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

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "rex-guardrail-test-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

Deno.test("guardrail allows reply: run finishes as if no guardrail", async () => {
  await withTempRoot(async (root) => {
    const { model: main } = mockMainModel(['await reply("hello");']);
    const { model: guard, prompts } = mockGuardrailModel(['{"ok": true}']);
    const gEvals: GuardrailEvaluation[] = [];
    const steps: StepRecord[] = [];
    const r = await new Agent({
      model: main,
      task: "say hello",
      sessionsRoot: root,
      onStep: (s) => { steps.push(s); },
      onGuardrail: (e) => { gEvals.push(e); },
      guardrails: [defineGuardrail({
        name: "no-profanity",
        triggers: ["reply"],
        model: guard,
        instructions: "Block replies containing profanity.",
      })],
    }).run();

    assertEquals(r, { kind: "reply", message: "hello" });
    assertEquals(prompts.length, 1, "guardrail must run exactly once");
    assertEquals(gEvals.length, 1);
    assertEquals(gEvals[0].guardrail, "no-profanity");
    assertEquals(gEvals[0].verdict, { ok: true });
    assertEquals(steps.length, 1);
    assertEquals(steps[0].event.kind, "reply");
  });
});

Deno.test("guardrail blocks reply: loop continues, model can revise on next step", async () => {
  await withTempRoot(async (root) => {
    // Step 1: model produces a banned reply. Step 2: it produces a clean
    // reply. Guardrail blocks the first; second passes (the scripted
    // guard model's second output).
    const { model: main } = mockMainModel([
      'await reply("ugly word");',
      'await reply("clean reply");',
    ]);
    const { model: guard } = mockGuardrailModel([
      '{"ok": false, "reason": "policy violation: profanity"}',
      '{"ok": true}',
    ]);
    const gEvals: GuardrailEvaluation[] = [];
    const steps: StepRecord[] = [];
    const r = await new Agent({
      model: main,
      task: "say something",
      sessionsRoot: root,
      onStep: (s) => { steps.push(s); },
      onGuardrail: (e) => { gEvals.push(e); },
      guardrails: [defineGuardrail({
        name: "no-profanity",
        triggers: ["reply"],
        model: guard,
        instructions: "Block profanity.",
      })],
    }).run();

    // The run did NOT terminate on the blocked reply — it completed
    // with the second (clean) reply.
    assertEquals(r, { kind: "reply", message: "clean reply" });
    // Two guardrail evaluations: one block, one pass.
    assertEquals(gEvals.length, 2);
    assertEquals(gEvals[0].verdict.ok, false);
    assertEquals(gEvals[1].verdict, { ok: true });
    // Two steps were recorded: the blocked one and the successful one.
    assertEquals(steps.length, 2);
    assertEquals(steps[0].event.kind, "guardrail_blocked");
    assert(steps[0].event.kind === "guardrail_blocked");
    assertEquals(steps[0].event.guardrail, "no-profanity");
    assertEquals(steps[0].event.originalKind, "reply");
    assertStringIncludes(steps[0].event.reason, "profanity");
    assertEquals(steps[1].event.kind, "reply");
  });
});

Deno.test("guardrail doesn't fire on non-matching event kinds", async () => {
  await withTempRoot(async (root) => {
    // Reflect then reply. Guardrail only triggers on "reply".
    const { model: main } = mockMainModel([
      'return reflect({ check: "ok" });',
      'await reply("done");',
    ]);
    const { model: guard, prompts } = mockGuardrailModel(['{"ok": true}']);
    const r = await new Agent({
      model: main,
      task: "two-step",
      sessionsRoot: root,
      guardrails: [defineGuardrail({
        name: "reply-only",
        triggers: ["reply"],
        model: guard,
        instructions: "noop",
      })],
    }).run();
    assertEquals(r, { kind: "reply", message: "done" });
    // Only the reply step triggers the guardrail; the reflect step doesn't
    assertEquals(prompts.length, 1);
  });
});

Deno.test("guardrail blocking reflect: loop continues, model revises", async () => {
  await withTempRoot(async (root) => {
    // Step 1: model emits a reflect that leaks; guardrail blocks it.
    // Step 2: model revises and replies cleanly. Reply has no
    // matching guardrail so it passes.
    const { model: main } = mockMainModel([
      'return reflect({ secret: "abcd" });',
      'await reply("done");',
    ]);
    const { model: guard } = mockGuardrailModel([
      '{"ok": false, "reason": "reflect state leaks a secret"}',
    ]);
    const steps: StepRecord[] = [];
    const r = await new Agent({
      model: main,
      task: "do something",
      sessionsRoot: root,
      onStep: (s) => { steps.push(s); },
      guardrails: [defineGuardrail({
        name: "no-leaks",
        triggers: ["reflect"],
        model: guard,
        instructions: "Block reflect states that contain secrets.",
      })],
    }).run();
    assertEquals(r, { kind: "reply", message: "done" });
    assertEquals(steps.length, 2);
    assertEquals(steps[0].event.kind, "guardrail_blocked");
    assert(steps[0].event.kind === "guardrail_blocked");
    assertEquals(steps[0].event.originalKind, "reflect");
    assertEquals(steps[1].event.kind, "reply");
  });
});

Deno.test("guardrail trigger 'any' fires on every step", async () => {
  await withTempRoot(async (root) => {
    const { model: main } = mockMainModel([
      'return reflect({ done: false });',
      'await reply("done");',
    ]);
    const { model: guard, prompts } = mockGuardrailModel(['{"ok": true}']);
    const r = await new Agent({
      model: main,
      task: "two-step",
      sessionsRoot: root,
      guardrails: [defineGuardrail({
        name: "watcher",
        triggers: ["any"],
        model: guard,
        instructions: "noop",
      })],
    }).run();
    assertEquals(r, { kind: "reply", message: "done" });
    assertEquals(prompts.length, 2, "guardrail must fire on both steps");
  });
});

Deno.test("multiple guardrails: first allows, second blocks → block records, third skipped, loop continues", async () => {
  await withTempRoot(async (root) => {
    // Step 1's reply is blocked by g2 after g1 allowed it. Step 2's
    // reply makes it through all three.
    const { model: main } = mockMainModel([
      'await reply("hi");',
      'await reply("retry");',
    ]);
    // g1 / g3 always allow; g2 blocks the first reply, allows the
    // second.
    const { model: g1 } = mockGuardrailModel(['{"ok": true}']);
    const { model: g2 } = mockGuardrailModel([
      '{"ok": false, "reason": "second guardrail blocked"}',
      '{"ok": true}',
    ]);
    const { model: g3, prompts: g3prompts } = mockGuardrailModel(['{"ok": true}']);

    const gEvals: GuardrailEvaluation[] = [];
    const steps: StepRecord[] = [];
    const r = await new Agent({
      model: main,
      task: "say hi",
      sessionsRoot: root,
      onStep: (s) => { steps.push(s); },
      onGuardrail: (e) => { gEvals.push(e); },
      guardrails: [
        defineGuardrail({ name: "g1", triggers: ["reply"], model: g1, instructions: "x" }),
        defineGuardrail({ name: "g2", triggers: ["reply"], model: g2, instructions: "x" }),
        defineGuardrail({ name: "g3", triggers: ["reply"], model: g3, instructions: "x" }),
      ],
    }).run();

    assertEquals(r, { kind: "reply", message: "retry" });
    // Step 1: g1 ok → g2 block → g3 skipped. Step 2: g1 ok → g2 ok → g3 ok.
    assertEquals(gEvals.length, 5);
    assertEquals(gEvals[0].guardrail, "g1");
    assertEquals(gEvals[1].guardrail, "g2");
    assertEquals(gEvals[1].verdict.ok, false);
    assertEquals(gEvals[2].guardrail, "g1");
    assertEquals(gEvals[3].guardrail, "g2");
    assertEquals(gEvals[3].verdict, { ok: true });
    assertEquals(gEvals[4].guardrail, "g3");
    // g3 was called only on step 2 (skipped on step 1 because g2 blocked).
    assertEquals(g3prompts.length, 1);
    assertEquals(steps.length, 2);
    assertEquals(steps[0].event.kind, "guardrail_blocked");
    assertEquals(steps[1].event.kind, "reply");
  });
});

Deno.test("guardrail receives prior steps in its audit doc", async () => {
  await withTempRoot(async (root) => {
    // Two steps: reflect, then reply. Guardrail fires only on reply but
    // should see the reflect step in its audit log.
    const { model: main } = mockMainModel([
      'console.log("scanning"); return reflect({ found: 3 });',
      'await reply("found 3 items");',
    ]);
    const { model: guard, prompts } = mockGuardrailModel(['{"ok": true}']);
    await new Agent({
      model: main,
      task: "count items",
      sessionsRoot: root,
      guardrails: [defineGuardrail({
        name: "reply-guard",
        triggers: ["reply"],
        model: guard,
        instructions: "Audit replies.",
      })],
    }).run();

    assertEquals(prompts.length, 1);
    // The audit doc is the prompt to the guardrail model. Check key
    // markers are present.
    const audit = prompts[0];
    assertStringIncludes(audit, "Guardrail audit");
    assertStringIncludes(audit, "Prior steps");
    assertStringIncludes(audit, "scanning");
    assertStringIncludes(audit, "found 3 items");
    assertStringIncludes(audit, "CURRENT STEP");
  });
});

Deno.test("guardrail failure with passOnError=true: run proceeds", async () => {
  await withTempRoot(async (root) => {
    const { model: main } = mockMainModel(['await reply("hi");']);
    const failingGuard: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "rex-mock",
      modelId: "rex-mock-fail",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("upstream 500")),
      doStream: () => { throw new Error("nope"); },
    };
    const gEvals: GuardrailEvaluation[] = [];
    const r = await new Agent({
      model: main,
      task: "say hi",
      sessionsRoot: root,
      onGuardrail: (e) => { gEvals.push(e); },
      guardrails: [defineGuardrail({
        name: "flaky",
        triggers: ["reply"],
        model: failingGuard,
        instructions: "x",
        passOnError: true,
      })],
    }).run();
    assertEquals(r, { kind: "reply", message: "hi" });
    assertEquals(gEvals.length, 1);
    assertEquals(gEvals[0].verdict, { ok: true });
    assertEquals(gEvals[0].evaluationError, "upstream 500");
  });
});

Deno.test("guardrail failure with passOnError=false: block recorded, loop continues, exhausts on retry", async () => {
  await withTempRoot(async (root) => {
    // Even with passOnError=false, a failing guardrail produces a
    // guardrail_blocked step rather than terminating the run. The
    // model re-runs and (since the upstream is still down) is blocked
    // again — eventually maxSteps caps it and the run is exhausted.
    const { model: main } = mockMainModel(['await reply("hi");']);
    const failingGuard: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "rex-mock",
      modelId: "rex-mock-fail",
      supportedUrls: {},
      doGenerate: () => Promise.reject(new Error("upstream 500")),
      doStream: () => { throw new Error("nope"); },
    };
    const steps: StepRecord[] = [];
    const r = await new Agent({
      model: main,
      task: "say hi",
      sessionsRoot: root,
      maxSteps: 3,
      onStep: (s) => { steps.push(s); },
      guardrails: [defineGuardrail({
        name: "strict",
        triggers: ["reply"],
        model: failingGuard,
        instructions: "x",
        passOnError: false,
      })],
    }).run();
    // The run ends in exhaustion because every reply gets blocked.
    assertEquals(r.kind, "exhausted");
    // Each step was a guardrail_blocked with the upstream-500 reason.
    for (const s of steps) {
      assertEquals(s.event.kind, "guardrail_blocked");
      assert(s.event.kind === "guardrail_blocked");
      assertEquals(s.event.guardrail, "strict");
      assertStringIncludes(s.event.reason, "upstream 500");
    }
    assertEquals(steps.length, 3);
  });
});

Deno.test("synthetic missing-fence throw is routed through guardrails", async () => {
  await withTempRoot(async (root) => {
    // First main-model output has NO fence — the extractor synthesizes a
    // `throw` event. A `throw`-triggered guardrail (or any "any" trigger)
    // MUST see that event; previously it bypassed guardrails entirely.
    // Step 2: a clean reply that the guardrail allows.
    const noFenceText = "I forgot the code fence — here is the plan instead.";
    const noFenceModel: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "rex-mock",
      modelId: "rex-mock-no-fence",
      supportedUrls: {},
      doGenerate: (() => {
        let i = 0;
        return () => {
          i++;
          const text = i === 1 ? noFenceText : "```ts\nawait reply(\"recovered\");\n```";
          return Promise.resolve({
            finishReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            content: [{ type: "text" as const, text }],
            warnings: [],
          });
        };
      })(),
      doStream: () => { throw new Error("nope"); },
    };
    let throwSeen = false;
    const checkGuard = defineGuardrail({
      name: "no-extractor-throws",
      triggers: ["throw"],
      check: (ctx) => {
        if (ctx.event.kind === "throw") {
          throwSeen = true;
          return { ok: false, reason: "fix your code fence" };
        }
        return { ok: true };
      },
    });
    const steps: StepRecord[] = [];
    const r = await new Agent({
      model: noFenceModel,
      task: "say hi",
      sessionsRoot: root,
      onStep: (s) => { steps.push(s); },
      guardrails: [checkGuard],
    }).run();

    assertEquals(r, { kind: "reply", message: "recovered" });
    assertEquals(throwSeen, true, "guardrail must see the synthetic throw");
    // Step 1 was the synthetic throw, blocked by the guardrail.
    assertEquals(steps[0].event.kind, "guardrail_blocked");
    assert(steps[0].event.kind === "guardrail_blocked");
    assertEquals(steps[0].event.originalKind, "throw");
    assertEquals(steps[0].event.guardrail, "no-extractor-throws");
    assertStringIncludes(steps[0].event.reason, "code fence");
    assertEquals(steps[1].event.kind, "reply");
  });
});
