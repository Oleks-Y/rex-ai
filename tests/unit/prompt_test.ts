import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import { PromptBuilder, type PromptInput } from "../../src/prompt.ts";
import { defineTool, ToolRegistry } from "../../src/tools.ts";

function baseInput(over: Partial<PromptInput> = {}): PromptInput {
  return {
    task: "Do the thing.",
    tools: [],
    permissions: undefined,
    session: { libExports: [], libSource: "export {};", storageKeys: [] },
    priorSteps: [],
    ...over,
  };
}

Deno.test("header always includes the three control fns + ts fence rule", () => {
  const out = PromptBuilder.build(baseInput());
  assertStringIncludes(out, "reply(message: string)");
  assertStringIncludes(out, "abort(error: string)");
  assertStringIncludes(out, "reflect(state: unknown)");
  assertStringIncludes(out, "```ts");
});

Deno.test("permissions block: no permissions → all (none) defaults", () => {
  const out = PromptBuilder.build(baseInput({ permissions: undefined }));
  assertStringIncludes(out, "network:    (none)");
  assertStringIncludes(out, "subprocess: no");
  assertStringIncludes(out, "modules:    (none beyond session:lib)");
});

Deno.test("permissions block: full config rendered", () => {
  const out = PromptBuilder.build(baseInput({
    permissions: {
      net: ["api.github.com"],
      read: ["./cache"],
      write: ["./out"],
      run: true,
      modules: ["jsr:@std/encoding"],
    },
  }));
  assertStringIncludes(out, "network:    api.github.com");
  assertStringIncludes(out, "file read:  ./cache");
  assertStringIncludes(out, "file write: ./out");
  assertStringIncludes(out, "subprocess: yes");
  assertStringIncludes(out, "modules:    jsr:@std/encoding");
});

Deno.test("tools block: empty → '(none registered)'", () => {
  const out = PromptBuilder.build(baseInput());
  assertStringIncludes(out, "Tools: (none registered)");
});

Deno.test("tools block: rendered signature uses zod-to-ts", () => {
  const reg = new ToolRegistry([
    defineTool({
      name: "fetchIssues",
      description: "Fetch open GitHub issues for a repo.",
      schema: z.object({
        repo: z.string(),
        limit: z.number().default(10),
        tags: z.array(z.string()).optional(),
      }),
      handler: () => [],
    }),
  ]);
  const out = PromptBuilder.build(baseInput({ tools: reg.describe() }));
  assertStringIncludes(out, "fetchIssues(args: {");
  assertStringIncludes(out, "repo: string;");
  assertStringIncludes(out, "limit?: number;");
  assertStringIncludes(out, "tags?: Array<string> | undefined;");
  assertStringIncludes(out, "Fetch open GitHub issues for a repo.");
});

Deno.test("tools block: tsSignature override wins over auto-rendered", () => {
  const out = PromptBuilder.build(baseInput({
    tools: [{
      name: "manual",
      description: "uses manual sig",
      schema: z.object({}),
      tsSignature: "(custom: 'shape'): Promise<{ ok: true }>",
    }],
  }));
  assertStringIncludes(out, "manual(custom: 'shape'): Promise<{ ok: true }>");
  // Auto-rendered shape should NOT appear:
  const idx = out.indexOf("manual(args:");
  assertEquals(idx, -1);
});

Deno.test("session block: empty lib + empty storage", () => {
  const out = PromptBuilder.build(baseInput());
  assertStringIncludes(out, "Current lib.ts exports: (empty)");
  assertStringIncludes(out, "Current lib.ts source:\n      (empty)");
  assertStringIncludes(out, "Storage keys: (empty)");
});

Deno.test("session block: lib source surfaced + exports listed", () => {
  const out = PromptBuilder.build(baseInput({
    session: {
      libExports: ["greet", "PI"],
      libSource: "export const PI = 3.14;\nexport const greet = (n: string) => 'hi, ' + n;",
      storageKeys: ["count", "lastSeen"],
    },
  }));
  assertStringIncludes(out, "Current lib.ts exports: greet, PI");
  assertStringIncludes(out, "export const PI = 3.14;");
  assertStringIncludes(out, "export const greet");
  assertStringIncludes(out, "Storage keys: count, lastSeen");
});

Deno.test("prior steps: omitted when empty", () => {
  const out = PromptBuilder.build(baseInput());
  assertEquals(out.includes("Prior steps:"), false);
});

Deno.test("prior steps: reflect step renders code + state", () => {
  const out = PromptBuilder.build(baseInput({
    priorSteps: [{
      code: 'console.log("hello"); await reflect({ progress: 1 });',
      event: {
        kind: "reflect",
        state: { progress: 1 },
        logs: [{ level: "log", args: ["hello"] }],
      },
    }],
  }));
  assertStringIncludes(out, "--- step 1 ---");
  assertStringIncludes(out, '"hello"');
  assertStringIncludes(out, "Result: reflect");
  assertStringIncludes(out, '"progress":1');
  assertStringIncludes(out, "[log] hello");
});

Deno.test("prior steps: permission_denied step explains how to recover", () => {
  const out = PromptBuilder.build(baseInput({
    priorSteps: [{
      code: 'await fetch("https://example.com/");',
      event: {
        kind: "permission_denied",
        permission: "net",
        target: "example.com:443",
        logs: [],
      },
    }],
  }));
  assertStringIncludes(out, "permission_denied");
  assertStringIncludes(out, "net access to");
  assertStringIncludes(out, "example.com:443");
});

Deno.test("prior steps: throw step shows the error message", () => {
  const out = PromptBuilder.build(baseInput({
    priorSteps: [{
      code: 'throw new Error("boom")',
      event: { kind: "throw", error: "Error: boom\n  at line 1", logs: [] },
    }],
  }));
  assertStringIncludes(out, "threw an error");
  assertStringIncludes(out, "boom");
});

Deno.test("task is rendered last", () => {
  const out = PromptBuilder.build(baseInput({ task: "summarize 5 issues" }));
  assertEquals(out.endsWith("Task: summarize 5 issues"), true);
});

Deno.test("multiple tools rendered in registration order", () => {
  const out = PromptBuilder.build(baseInput({
    tools: [
      { name: "a", description: "first", schema: z.object({}) },
      { name: "b", description: "second", schema: z.object({}) },
    ],
  }));
  const ai = out.indexOf("a(args:");
  const bi = out.indexOf("b(args:");
  assertEquals(ai >= 0 && bi >= 0 && ai < bi, true);
});

Deno.test("lastStep: omitted by default — task is last, no directive", () => {
  const out = PromptBuilder.build(baseInput({ task: "x" }));
  assertEquals(out.endsWith("Task: x"), true);
  assertEquals(out.includes("LAST STEP"), false);
});

Deno.test("lastStep: directive appended AFTER task, names reply()/abort()", () => {
  const out = PromptBuilder.build(baseInput({ task: "x", lastStep: true }));
  // Sits after the task block — the model reads it last.
  const taskIdx = out.indexOf("Task: x");
  const directiveIdx = out.indexOf("LAST STEP");
  assertEquals(taskIdx >= 0 && directiveIdx > taskIdx, true);
  // Names the only two acceptable terminals, by name.
  assertStringIncludes(out, "return reply(");
  assertStringIncludes(out, "return abort(");
  // Names the failure mode the model is being warned against.
  assertStringIncludes(out, "EXHAUSTED");
});

Deno.test("lastStep: explicit false renders no directive", () => {
  const out = PromptBuilder.build(baseInput({ lastStep: false }));
  assertEquals(out.includes("LAST STEP"), false);
});

Deno.test("header rules: forbids reply/abort inside timer callbacks", () => {
  const out = PromptBuilder.build(baseInput());
  assertStringIncludes(out, "Inside a timer callback");
  assertStringIncludes(out, "reflect(value)");
  // Silent callbacks remain legal — the rule must call this out so the
  // predicate-poll pattern doesn't get nuked.
  assertStringIncludes(out, "predicate-poll");
});

Deno.test("header rules: verify-before-reply warns about guardrail enforcement", () => {
  const out = PromptBuilder.build(baseInput());
  assertStringIncludes(out, "guardrail may enforce");
});

Deno.test("prior steps: guardrail_blocked event renders revise-and-retry directive", () => {
  const out = PromptBuilder.build(baseInput({
    priorSteps: [{
      code: 'await reply("ugly word");',
      event: {
        kind: "guardrail_blocked",
        guardrail: "no-profanity",
        reason: "contains a banned word",
        originalKind: "reply",
        original: { kind: "reply", message: "ugly word" },
        logs: [],
      },
    }],
  }));
  assertStringIncludes(out, "BLOCKED by guardrail 'no-profanity'");
  assertStringIncludes(out, "contains a banned word");
  assertStringIncludes(out, "previous reply was rejected");
  assertStringIncludes(out, "Blocked payload: reply(ugly word)");
  assertStringIncludes(out, "REVISE");
});
