// Sandbox integration tests — spawn a real Deno subprocess and exercise
// each code path through the prelude + RPC + tool/session bridge.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { Sandbox } from "../../src/sandbox.ts";
import { SessionStore } from "../../src/session.ts";
import { defineTool, ToolRegistry } from "../../src/tools.ts";
import { DEFAULT_SIZE_CAPS, type PermissionsConfig } from "../../src/types.ts";

async function withSession<T>(
  fn: (session: SessionStore) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "rex-sbx-test-" });
  const session = await SessionStore.open({
    rootDir: root,
    sizeCaps: DEFAULT_SIZE_CAPS,
  });
  try {
    return await fn(session);
  } finally {
    await session.close();
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

const noTools = new ToolRegistry();
const noPerms: PermissionsConfig = {};

Deno.test("reply: simple control fn end-to-end", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'await reply("hello world");',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "hello world");
  });
});

Deno.test("abort: refuse path", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'await abort("missing tool");',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "abort");
    if (r.kind === "abort") assertEquals(r.error, "missing tool");
  });
});

Deno.test("reflect: state passes through to parent", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'await reflect({ progress: 0.5, note: "halfway" });',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reflect");
    if (r.kind === "reflect") assertEquals(r.state, { progress: 0.5, note: "halfway" });
  });
});

Deno.test("tool call round-trips with zod-validated args", async () => {
  await withSession(async (session) => {
    const tools = new ToolRegistry([
      defineTool({
        name: "add",
        description: "sum two numbers",
        schema: z.object({ a: z.number(), b: z.number() }),
        handler: ({ a, b }) => ({ sum: a + b }),
      }),
    ]);
    const r = await Sandbox.run({
      llmCode: `
        const r = await add({ a: 2, b: 3 });
        await reply("sum=" + (r as any).sum);
      `,
      tools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "sum=5");
  });
});

Deno.test("tool call validation failure → ToolError carrying issues", async () => {
  await withSession(async (session) => {
    const tools = new ToolRegistry([
      defineTool({
        name: "needsString",
        description: "",
        schema: z.object({ s: z.string() }),
        handler: () => "ok",
      }),
    ]);
    const r = await Sandbox.run({
      llmCode: `
        try {
          await needsString({ s: 123 } as any);
          await reply("did not throw");
        } catch (e: any) {
          await reply("caught:" + e.name + ":" + e.message);
        }
      `,
      tools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") {
      assertStringIncludes(r.message, "caught:ToolError:invalid arguments for needsString");
    }
  });
});

Deno.test("uncaught throw → throw event with stack", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'throw new Error("boom");',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "throw");
    if (r.kind === "throw") assertStringIncludes(r.error, "boom");
  });
});

Deno.test("permission denied: net fetch without --allow-net → permission_denied", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        await fetch("https://example.com/");
        await reply("should not reach here");
      `,
      tools: noTools,
      session,
      permissions: { net: [] }, // no net allowed
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "permission_denied");
    if (r.kind === "permission_denied") {
      assertEquals(r.permission, "net");
      assertStringIncludes(r.target.toLowerCase(), "example.com");
    }
  });
});

Deno.test("net fetch IS allowed when host is on the allowlist", async () => {
  await withSession(async (session) => {
    // We don't actually want to hit the network in tests, so we use a
    // host the allowlist permits but we never reach (the LLM code resolves
    // before fetch). Just verify the sandbox doesn't reject up front.
    const r = await Sandbox.run({
      llmCode: 'await reply("net allowed but unused");',
      tools: noTools,
      session,
      permissions: { net: ["example.com"] },
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
  });
});

Deno.test("returning without a control fn → synthetic abort", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'const x = 1 + 1; void x;',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "abort");
    if (r.kind === "abort") {
      assertStringIncludes(r.error, "without calling");
    }
  });
});

Deno.test("canonical pattern: `return reply(...)` works", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'return reply("returned");',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "returned");
  });
});

Deno.test("`return reflect(...)` carries state through", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'return reflect({ n: 42 });',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reflect");
    if (r.kind === "reflect") assertEquals(r.state, { n: 42 });
  });
});

Deno.test("returned control wins when both returned and called", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      // Body calls abort, but RETURNS reply — return value should win.
      llmCode: `
        abort("ignored");
        return reply("kept");
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "kept");
  });
});

Deno.test("fire-and-forget tool call still completes before terminal frame", async () => {
  // Regression for the T14-class bug: a tool called without `await` must
  // still execute parent-side before the terminal frame fires (otherwise
  // we get phantom side effects after the agent has "finished").
  let toolRan = false;
  await withSession(async (session) => {
    const tools = new ToolRegistry([
      defineTool({
        name: "mark",
        description: "set a flag in the parent",
        schema: z.object({}),
        handler: () => {
          toolRan = true;
          return { ok: true };
        },
      }),
    ]);
    const r = await Sandbox.run({
      // No `await` — promise floats. The trailer must still drain it.
      llmCode: `
        mark({});
        return reply("done");
      `,
      tools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
  });
  assertEquals(toolRan, true);
});

Deno.test("console.log is captured and surfaced as logs", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        console.log("hello");
        console.warn("watch out");
        await reply("done");
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    const logs = r.logs;
    assertEquals(logs.length, 2);
    assertEquals(logs[0].level, "log");
    assertEquals(logs[0].args, ["hello"]);
    assertEquals(logs[1].level, "warn");
    assertEquals(logs[1].args, ["watch out"]);
  });
});

Deno.test("logs over the cap are truncated with a marker", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        for (let i = 0; i < 1000; i++) console.log("x".repeat(200));
        await reply("done");
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: { ...DEFAULT_SIZE_CAPS, logBytes: 2048 },
    });
    assertEquals(r.kind, "reply");
    const lastLog = r.logs[r.logs.length - 1];
    assertStringIncludes(String(lastLog.args[0]), "log truncated");
  });
});

Deno.test("step timeout → throw event, child killed", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        // Keep the event loop alive forever via setInterval — Deno won't
        // detect this as a top-level-await deadlock, so the only way out
        // is the parent's wall-clock timeout (and SIGKILL).
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: { ...DEFAULT_SIZE_CAPS, stepTimeoutMs: 500 },
    });
    assertEquals(r.kind, "throw");
    if (r.kind === "throw") {
      assertStringIncludes(r.error, "wall-clock");
    }
  });
});

Deno.test("writeLib persists across the same sandbox call (used by next step)", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        await writeLib("export const greet = (n: string) => 'hi, ' + n;");
        await reply("written");
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    const exports = await session.libExports();
    assertEquals(exports, ["greet"]);
  });
});

Deno.test("writeLib that fails ModuleGuard surfaces as WriteLibError", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        try {
          await writeLib('import x from "node:fs"; export const y = 1;');
          await reply("did-not-throw");
        } catch (e: any) {
          await reply("caught:" + e.name);
        }
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "caught:WriteLibError");
  });
});

Deno.test("storage round-trip from inside the sandbox", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        await storage.set("count", 7);
        const v = await storage.get("count");
        const ks = await storage.keys();
        await reply(JSON.stringify({ v, ks }));
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") {
      assertEquals(JSON.parse(r.message), { v: 7, ks: ["count"] });
    }
    assertEquals(session.storageGet("count"), 7);
  });
});

Deno.test("session:lib import works after writeLib", async () => {
  await withSession(async (session) => {
    // Step 1: write a helper.
    const w = await Sandbox.run({
      llmCode: `
        await writeLib("export const triple = (n: number) => n * 3;");
        await reply("ok");
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(w.kind, "reply");

    // Step 2: import + use the helper.
    const r = await Sandbox.run({
      llmCode: `
        const m: any = await import("session:lib");
        await reply("triple(5)=" + m.triple(5));
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "triple(5)=15");
  });
});

Deno.test("module guard rejects disallowed import before spawn", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: 'import x from "node:fs"; await reply("nope");',
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "throw");
    if (r.kind === "throw") {
      assertStringIncludes(r.error, "module guard");
      assertStringIncludes(r.error, "node:fs");
    }
  });
});

Deno.test("reflect state over cap → throw (so LLM gets a chance to retry)", async () => {
  await withSession(async (session) => {
    const r = await Sandbox.run({
      llmCode: `
        const big = "x".repeat(2000);
        await reflect({ payload: big });
      `,
      tools: noTools,
      session,
      permissions: noPerms,
      sizeCaps: { ...DEFAULT_SIZE_CAPS, reflectStateBytes: 256 },
    });
    assertEquals(r.kind, "throw");
    if (r.kind === "throw") assertStringIncludes(r.error, "state too large");
  });
});

Deno.test("oversize tool result → ToolResultTooLargeError in sandbox", async () => {
  await withSession(async (session) => {
    const tools = new ToolRegistry([
      defineTool({
        name: "huge",
        description: "",
        schema: z.object({}),
        handler: () => ({ blob: "x".repeat(2000) }),
      }),
    ]);
    const r = await Sandbox.run({
      llmCode: `
        try {
          await huge({});
          await reply("did-not-throw");
        } catch (e: any) {
          await reply("caught:" + e.name);
        }
      `,
      tools,
      session,
      permissions: noPerms,
      sizeCaps: { ...DEFAULT_SIZE_CAPS, toolResultBytes: 256 },
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "caught:ToolResultTooLargeError");
  });
});

Deno.test("oversize tool result also caught as ToolError (subclass)", async () => {
  // ToolResultTooLargeError extends ToolError, so a single
  // `catch (e) { if (e instanceof ToolError) }` in agent code handles
  // both validation failures and oversize results uniformly.
  await withSession(async (session) => {
    const tools = new ToolRegistry([
      defineTool({
        name: "huge",
        description: "",
        schema: z.object({}),
        handler: () => ({ blob: "x".repeat(2000) }),
      }),
    ]);
    const r = await Sandbox.run({
      llmCode: `
        try {
          await huge({});
          await reply("did-not-throw");
        } catch (e: any) {
          await reply("isToolError:" + (e instanceof ToolError));
        }
      `,
      tools,
      session,
      permissions: noPerms,
      sizeCaps: { ...DEFAULT_SIZE_CAPS, toolResultBytes: 256 },
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "isToolError:true");
  });
});

Deno.test("concurrent in-flight tool calls don't race the stdin writer", async () => {
  // Regression: the parent used to acquire `proc.stdin.getWriter()` per
  // frame; multiple simultaneous tool replies threw "stream is already
  // locked." With the writer held + serialized via a promise chain, a
  // burst of `Promise.all` calls from the LLM body must all complete.
  await withSession(async (session) => {
    const tools = new ToolRegistry([
      defineTool({
        name: "echo_n",
        description: "return the input number",
        schema: z.object({ n: z.number() }),
        handler: ({ n }) => n,
      }),
    ]);
    const r = await Sandbox.run({
      llmCode: `
        const xs = await Promise.all(
          Array.from({ length: 16 }, (_, i) => echo_n({ n: i }))
        );
        await reply("sum:" + (xs as number[]).reduce((a, b) => a + b, 0));
      `,
      tools,
      session,
      permissions: noPerms,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    assertEquals(r.kind, "reply");
    if (r.kind === "reply") assertEquals(r.message, "sum:120");
  });
});
