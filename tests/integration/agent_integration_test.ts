// Agent integration tests — drive the full loop with a hand-rolled
// LanguageModelV2 that returns a scripted sequence of fenced TS blocks.
//
// These exercise the same paths as sandbox_integration_test, but through
// the Agent (which adds: prompt build, code extraction, message-history
// growth, maxSteps cap).

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { z } from "zod";
import { Agent } from "../../src/agent.ts";
import { defineTool } from "../../src/tools.ts";
import { DEFAULT_SIZE_CAPS } from "../../src/types.ts";

/**
 * MockModel — returns each script entry in turn, fenced as ```ts.
 * Exposes `prompts` so tests can assert what the agent sent.
 */
function mockModel(scripts: string[]): { model: LanguageModelV2; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: (opts) => {
      // Capture the prompt for assertions. The AI SDK passes the prompt as
      // a structured `prompt` array; we serialize it for inspection.
      prompts.push(JSON.stringify(opts.prompt));
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
  return { model, prompts };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "rex-agent-test-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

Deno.test("reply on first step", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("hello");']);
    const r = await new Agent({
      model,
      task: "say hello",
      sessionsRoot: root,
    }).run();
    assertEquals(r, { kind: "reply", message: "hello" });
  });
});

Deno.test("abort terminates immediately, no further generations", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'await abort("missing key");',
      'await reply("should not run");',
    ]);
    const r = await new Agent({
      model,
      task: "fetch a thing",
      sessionsRoot: root,
    }).run();
    assertEquals(r, { kind: "abort", error: "missing key" });
    assertEquals(prompts.length, 1);
  });
});

Deno.test("reflect → second step has prior step in prompt → eventual reply", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'await reflect({ note: "halfway" });',
      'await reply("done");',
    ]);
    const r = await new Agent({
      model,
      task: "two-step task",
      sessionsRoot: root,
    }).run();
    assertEquals(r, { kind: "reply", message: "done" });
    assertEquals(prompts.length, 2);
    // The second prompt must include a "Prior steps:" section + the reflect state.
    assertStringIncludes(prompts[1], "Prior steps");
    assertStringIncludes(prompts[1], "halfway");
  });
});

Deno.test("permission_denied feedback reaches the next prompt", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'await fetch("https://example.com/");',
      'await reply("recovered");',
    ]);
    const r = await new Agent({
      model,
      task: "try a fetch",
      sessionsRoot: root,
      permissions: { net: [] },
    }).run();
    assertEquals(r, { kind: "reply", message: "recovered" });
    assertStringIncludes(prompts[1], "permission_denied");
    assertStringIncludes(prompts[1].toLowerCase(), "example.com");
  });
});

Deno.test("throw feedback reaches the next prompt; agent recovers", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'throw new Error("first try failed");',
      'await reply("ok now");',
    ]);
    const r = await new Agent({
      model,
      task: "try and recover",
      sessionsRoot: root,
    }).run();
    assertEquals(r, { kind: "reply", message: "ok now" });
    assertStringIncludes(prompts[1], "first try failed");
  });
});

Deno.test("exhausted: maxSteps reached without terminal", async () => {
  await withTempRoot(async (root) => {
    // Scripted to always reflect → never terminates.
    const { model } = mockModel(['await reflect({ i: 0 });']);
    const r = await new Agent({
      model,
      task: "loop forever",
      sessionsRoot: root,
      maxSteps: 3,
    }).run();
    assertEquals(r, { kind: "exhausted", steps: 3 });
  });
});

Deno.test("forceFinalReply (default): last-step prompt carries the directive", async () => {
  await withTempRoot(async (root) => {
    // 3 reflects in a row → forces all 3 maxSteps slots to fire.
    const { model, prompts } = mockModel(['await reflect({ i: 0 });']);
    await new Agent({
      model,
      task: "loop",
      sessionsRoot: root,
      maxSteps: 3,
    }).run();
    // Three generations happened. Only the final one should carry the
    // "LAST STEP" directive — earlier ones must not, or the model would
    // be pressured to terminate before it had a chance to make progress.
    assertEquals(prompts.length, 3);
    assertEquals(prompts[0].includes("LAST STEP"), false);
    assertEquals(prompts[1].includes("LAST STEP"), false);
    assertEquals(prompts[2].includes("LAST STEP"), true);
  });
});

Deno.test("forceFinalReply: false disables the directive on every step", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel(['await reflect({ i: 0 });']);
    await new Agent({
      model,
      task: "loop",
      sessionsRoot: root,
      maxSteps: 3,
      forceFinalReply: false,
    }).run();
    assertEquals(prompts.length, 3);
    for (const p of prompts) assertEquals(p.includes("LAST STEP"), false);
  });
});

Deno.test("forceFinalReply: skipped if agent terminates before final step", async () => {
  // If reply() comes in early, we never reach the last step at all and
  // the directive is irrelevant. Sanity-check the prompts contain no
  // directive on either step.
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'await reflect({ i: 0 });',
      'await reply("done");',
    ]);
    const r = await new Agent({
      model,
      task: "two-step run",
      sessionsRoot: root,
      maxSteps: 5,
    }).run();
    assertEquals(r, { kind: "reply", message: "done" });
    assertEquals(prompts.length, 2);
    for (const p of prompts) assertEquals(p.includes("LAST STEP"), false);
  });
});

Deno.test("tool round-trip end-to-end through the loop", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `const r: any = await add({ a: 2, b: 3 });
       await reply("sum=" + r.sum);`,
    ]);
    const r = await new Agent({
      model,
      task: "use the add tool",
      sessionsRoot: root,
      tools: [
        defineTool({
          name: "add",
          description: "add two ints",
          schema: z.object({ a: z.number(), b: z.number() }),
          handler: ({ a, b }) => ({ sum: a + b }),
        }),
      ],
    }).run();
    assertEquals(r, { kind: "reply", message: "sum=5" });
  });
});

Deno.test("writeLib persists across steps within a single agent.run()", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      `await writeLib("export const greet = (n: string) => 'hi, ' + n;");
       await reflect({ wrote: true });`,
      `const m: any = await import("session:lib");
       await reply(m.greet("world"));`,
    ]);
    const r = await new Agent({
      model,
      task: "build helper, then use it",
      sessionsRoot: root,
    }).run();
    assertEquals(r, { kind: "reply", message: "hi, world" });
    // The second prompt should list `greet` in the lib exports.
    assertStringIncludes(prompts[1], "lib.ts exports: greet");
  });
});

Deno.test("session resume: state persists across two separate agent.run() calls", async () => {
  await withTempRoot(async (root) => {
    const sid = "resume-test";

    // Run 1: write a helper + a storage value, then reply.
    const a = await new Agent({
      model: mockModel([
        `await writeLib("export const k = 42;");
         await storage.set("seen", true);
         await reply("set");`,
      ]).model,
      task: "store stuff",
      sessionId: sid,
      sessionsRoot: root,
    }).run();
    assertEquals(a.kind, "reply");

    // Run 2 (same sessionId): the agent should see prior lib + storage.
    const { model, prompts } = mockModel([
      `const v = await storage.get("seen");
       const m: any = await import("session:lib");
       await reply("k=" + m.k + " seen=" + v);`,
    ]);
    const b = await new Agent({
      model,
      task: "use stored stuff",
      sessionId: sid,
      sessionsRoot: root,
    }).run();
    assertEquals(b, { kind: "reply", message: "k=42 seen=true" });
    assertStringIncludes(prompts[0], "lib.ts exports: k");
    assertStringIncludes(prompts[0], "Storage keys: seen");
  });
});

Deno.test("reserved tool name rejected at construction", async () => {
  let caught: Error | null = null;
  try {
    new Agent({
      model: mockModel([]).model,
      task: "x",
      tools: [
        defineTool({
          name: "reply",
          description: "shadows reply()",
          schema: z.object({}),
          handler: () => null,
        }),
      ],
    });
  } catch (e) {
    caught = e as Error;
  }
  assertStringIncludes(caught!.message, "reserved");
});

Deno.test("transcript.jsonl gets one line per step", async () => {
  await withTempRoot(async (root) => {
    const sid = "transcript";
    const { model } = mockModel([
      'await reflect({ s: 1 });',
      'await reply("done");',
    ]);
    await new Agent({
      model,
      task: "two steps",
      sessionId: sid,
      sessionsRoot: root,
    }).run();
    const text = await Deno.readTextFile(`${root}/sessions/${sid}/transcript.jsonl`);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.length, 2);
    assertEquals(lines[0].event.kind, "reflect");
    assertEquals(lines[1].event.kind, "reply");
  });
});

Deno.test("missing code fence is recoverable — model retries on next step", async () => {
  // Turn 1: no fence → synthetic `throw` step. Turn 2: fenced reply → success.
  // The result is a `reply` RunResult, not an error from agent.run().
  await withTempRoot(async (root) => {
    let call = 0;
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "rex-mock",
      modelId: "rex-mock-1",
      supportedUrls: {},
      doGenerate: () => {
        call++;
        const text = call === 1
          ? "no fence here, just plain words"
          : '```ts\nawait reply("recovered");\n```';
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
    const stepKinds: string[] = [];
    const result = await new Agent({
      model,
      task: "recover from missing fence",
      sessionsRoot: root,
      onStep: (s) => {
        stepKinds.push(s.event.kind);
      },
    }).run();
    assertEquals(result.kind, "reply");
    if (result.kind === "reply") assertEquals(result.message, "recovered");
    assertEquals(stepKinds, ["throw", "reply"]);
  });
});

Deno.test("resumeHistory: transcript persists logs and rehydrates them on resume", async () => {
  await withTempRoot(async (root) => {
    const sessionId = "log-persist-resume";
    // Step 1 emits a few console.logs then reflects; step 2 replies.
    const { model: model1 } = mockModel([
      'console.log("scan", 42); console.warn("careful"); return reflect({ done: false });',
      'await reply("done");',
    ]);
    const r1 = await new Agent({
      model: model1,
      task: "first run",
      sessionId,
      sessionsRoot: root,
    }).run();
    assertEquals(r1.kind, "reply");

    // Resume: capture the step records the agent sees on replay. The first
    // resumed step must come back with its original logs (the whole point
    // of persisting them — a guardrail on resume needs the same evidence
    // the original prompt had).
    type StepCapture = { source: string; kind: string; logs: unknown[] };
    const captured: StepCapture[] = [];
    const { model: model2 } = mockModel(['await reply("resumed");']);
    const r2 = await new Agent({
      model: model2,
      task: "second run",
      sessionId,
      sessionsRoot: root,
      resumeHistory: true,
      onStep: (s) => {
        captured.push({
          source: s.source,
          kind: s.event.kind,
          logs: s.event.logs.map((l) => ({ level: l.level, args: l.args })),
        });
      },
    }).run();
    assertEquals(r2.kind, "reply");

    const resumed = captured.filter((c) => c.source === "resumed");
    assertEquals(resumed.length, 2, "both prior steps should be replayed");
    // Step 1 had two log entries — `scan 42` (log) and `careful` (warn).
    assertEquals(resumed[0].kind, "reflect");
    assertEquals(resumed[0].logs, [
      { level: "log", args: ["scan", 42] },
      { level: "warn", args: ["careful"] },
    ]);
    // Step 2 had no logs.
    assertEquals(resumed[1].kind, "reply");
    assertEquals(resumed[1].logs, []);
  });
});

// Unused but typecheck-silent.
const _caps = DEFAULT_SIZE_CAPS;
void _caps;
