// PersistentSandbox parity tests — run a representative subset of the
// agent integration scenarios with `experimental.asyncWakeups: true`,
// asserting the same RunResult shapes as the per-step path.
//
// This is the step 2 acceptance test: behavioral parity for everything
// the existing per-step sandbox supports. Later steps add features that
// only the persistent path provides (scheduleWakeup, tasks API, etc.) —
// those will get their own dedicated tests.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { z } from "zod";
import { Agent } from "../../src/agent.ts";
import { defineTool } from "../../src/tools.ts";

function mockModel(scripts: string[]): { model: LanguageModelV2; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: (opts) => {
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
  const root = await Deno.makeTempDir({ prefix: "rex-persistent-test-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

const exp = { asyncWakeups: true } as const;

Deno.test("persistent: reply on first step", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("hello");']);
    const r = await new Agent({
      model,
      task: "say hello",
      sessionsRoot: root,
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "reply", message: "hello" });
  });
});

Deno.test("persistent: abort terminates immediately", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'await abort("missing key");',
      'await reply("should not run");',
    ]);
    const r = await new Agent({
      model,
      task: "fetch a thing",
      sessionsRoot: root,
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "abort", error: "missing key" });
    assertEquals(prompts.length, 1);
  });
});

Deno.test("persistent: reflect → second step in same subprocess → reply", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'await reflect({ note: "halfway" });',
      'await reply("done");',
    ]);
    const r = await new Agent({
      model,
      task: "two-step task",
      sessionsRoot: root,
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "reply", message: "done" });
    assertEquals(prompts.length, 2);
    assertStringIncludes(prompts[1], "Prior steps");
    assertStringIncludes(prompts[1], "halfway");
  });
});

Deno.test("persistent: permission_denied feedback reaches next prompt", async () => {
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
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "reply", message: "recovered" });
    assertStringIncludes(prompts[1], "permission_denied");
    assertStringIncludes(prompts[1].toLowerCase(), "example.com");
  });
});

Deno.test("persistent: throw feedback reaches next prompt; agent recovers", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'throw new Error("first try failed");',
      'await reply("ok now");',
    ]);
    const r = await new Agent({
      model,
      task: "try and recover",
      sessionsRoot: root,
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "reply", message: "ok now" });
    assertStringIncludes(prompts[1], "first try failed");
  });
});

Deno.test("persistent: tool round-trip", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `const r: any = await add({ a: 2, b: 3 });
       await reply("sum=" + r.sum);`,
    ]);
    const r = await new Agent({
      model,
      task: "use the add tool",
      sessionsRoot: root,
      experimental: exp,
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

Deno.test("persistent: writeLib persists across steps within a single run", async () => {
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
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "reply", message: "hi, world" });
    assertStringIncludes(prompts[1], "lib.ts exports: greet");
  });
});

Deno.test("persistent: cross-step state on globalThis.__rex survives between steps", async () => {
  // Direct test of the persistence claim — set state in step 1 via the
  // __rex registry, read it back in step 2. This is what later phases
  // (scheduleWakeup, tasks API) rely on.
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `(globalThis as any).__rex.state.set("k", 99);
       await reflect({ stored: true });`,
      `const v = (globalThis as any).__rex.state.get("k");
       await reply("v=" + v);`,
    ]);
    const r = await new Agent({
      model,
      task: "cross-step state",
      sessionsRoot: root,
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "reply", message: "v=99" });
  });
});

Deno.test("persistent: exhausted: maxSteps reached", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reflect({ i: 0 });']);
    const r = await new Agent({
      model,
      task: "loop forever",
      sessionsRoot: root,
      maxSteps: 3,
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "exhausted", steps: 3 });
  });
});

Deno.test("persistent: timeout kills stuck step; sandbox does not corrupt next call", async () => {
  // A hot loop ignores AbortSignal — the only way out in step-2 scope is
  // SIGKILL. After the timeout, the sandbox must be marked dead so a
  // late terminal frame from the killed step can't poison a fresh
  // collector. Here we drive that via an Agent run with a tight cap.
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      'while (true) { /* hang */ }',
      'await reply("never reached");',
    ]);
    const r = await new Agent({
      model,
      task: "hang on purpose",
      sessionsRoot: root,
      maxSteps: 3,
      sizeCaps: { stepTimeoutMs: 500 },
      experimental: exp,
    }).run();
    // The first step times out → throw; sandbox is then closed.
    // Subsequent runStep calls return throw "sandbox closed" until the
    // outer loop exhausts. We accept either kind: the contract here is
    // "no crash, no hang, no corruption."
    if (r.kind === "reply") {
      throw new Error("a hung step must not produce a reply");
    }
    // exhausted or abort, both acceptable end-states for this scenario.
  });
});

Deno.test("persistent: concurrent runStep calls are serialized", async () => {
  // Drive PersistentSandbox directly to assert the serialization
  // guarantee — Agent.run is sequential today, but the duplex
  // AgentSession surface in step 3 will have multiple producers.
  const { PersistentSandbox } = await import("../../src/persistent_sandbox.ts");
  const { SessionStore } = await import("../../src/session.ts");
  const { ToolRegistry } = await import("../../src/tools.ts");
  const { DEFAULT_SIZE_CAPS } = await import("../../src/types.ts");

  await withTempRoot(async (root) => {
    const session = await SessionStore.open({
      sessionId: "concurrent",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    const sandbox = await PersistentSandbox.open({
      tools: new ToolRegistry([]),
      session,
      permissions: undefined,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      // Two runs kicked off without await between them. They must both
      // complete with their own results, in order — no clobbered
      // collector, no missing terminal frame.
      const a = sandbox.runStep({ llmCode: 'await reflect({ which: "first" });' });
      const b = sandbox.runStep({ llmCode: 'await reply("second-done");' });
      const [ra, rb] = await Promise.all([a, b]);
      assertEquals(ra.kind, "reflect");
      assertEquals(rb.kind, "reply");
      if (rb.kind === "reply") assertEquals(rb.message, "second-done");
    } finally {
      await sandbox.close();
      await session.close();
    }
  });
});

Deno.test("persistent: transcript.jsonl one line per step", async () => {
  await withTempRoot(async (root) => {
    const sid = "transcript-persistent";
    const { model } = mockModel([
      'await reflect({ s: 1 });',
      'await reply("done");',
    ]);
    await new Agent({
      model,
      task: "two steps",
      sessionId: sid,
      sessionsRoot: root,
      experimental: exp,
    }).run();
    const text = await Deno.readTextFile(`${root}/sessions/${sid}/transcript.jsonl`);
    const lines = text.trim().split("\n").map((l) => JSON.parse(l));
    assertEquals(lines.length, 2);
    assertEquals(lines[0].event.kind, "reflect");
    assertEquals(lines[1].event.kind, "reply");
  });
});
