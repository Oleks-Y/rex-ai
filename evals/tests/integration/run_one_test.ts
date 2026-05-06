// End-to-end-with-fake-model integration test for the eval runner.
// Drives runOne → buildAgent → real Agent loop → real sandbox → grader,
// using a hand-rolled LanguageModelV2. No API keys, no network.

import { assertEquals } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { runOne } from "../../run_one.ts";
import type { TaskDef } from "../../types.ts";

function mockModel(scripts: string[]): LanguageModelV2 {
  let i = 0;
  return {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: () => {
      const next = scripts[i] ?? scripts[scripts.length - 1];
      i++;
      const text = "```ts\n" + next + "\n```";
      return Promise.resolve({
        finishReason: "stop" as const,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        content: [{ type: "text" as const, text }],
        warnings: [],
      });
    },
    doStream: () => {
      throw new Error("not implemented");
    },
  };
}

Deno.test("runOne: numeric_match grader against fake model", async () => {
  const task: TaskDef = {
    id: "test-num-1",
    task: "Compute 17 * 23 - 12. Return the number.",
    grader: { type: "numeric_match", expected: 379, tolerance: 0 },
    agent: "generic",
    max_steps: 2,
  };
  const row = await runOne({
    layer: "l1",
    source: "test",
    task,
    modelAlias: "gpt-5-nano",
    modelOverride: mockModel(['await reply("the answer is 379");']),
    seed: 0,
    runId: "test-run",
    rexAiCommit: "abc123",
  });
  assertEquals(row.score, 1);
  assertEquals(row.finish_reason, "reply");
  assertEquals(row.task_id, "test-num-1");
  assertEquals(row.layer, "l1");
});

Deno.test("runOne: numeric_match fails on wrong answer", async () => {
  const task: TaskDef = {
    id: "test-num-2",
    task: "Compute 17 * 23 - 12.",
    grader: { type: "numeric_match", expected: 379 },
    agent: "generic",
    max_steps: 2,
  };
  const row = await runOne({
    layer: "l1",
    source: "test",
    task,
    modelAlias: "gpt-5-nano",
    modelOverride: mockModel(['await reply("the answer is 380");']),
    seed: 0,
    runId: "test-run",
    rexAiCommit: "abc",
  });
  assertEquals(row.score, 0);
  assertEquals(row.finish_reason, "reply");
});

Deno.test("runOne: json_match subset against fake model", async () => {
  const task: TaskDef = {
    id: "test-json-1",
    task: "Return JSON with word_count, longest_word.",
    grader: {
      type: "json_match",
      subset: true,
      expected: { word_count: 9, longest_word: "jumps" },
    },
    agent: "generic",
    max_steps: 2,
  };
  const row = await runOne({
    layer: "l1",
    source: "test",
    task,
    modelAlias: "gpt-5-nano",
    modelOverride: mockModel([
      'await reply(JSON.stringify({word_count: 9, longest_word: "jumps", extra: 1}));',
    ]),
    seed: 0,
    runId: "test-run",
    rexAiCommit: "abc",
  });
  assertEquals(row.score, 1);
});

Deno.test("runOne: agent abort surfaces as finish_reason=abort, score=0", async () => {
  const task: TaskDef = {
    id: "test-abort-1",
    task: "Aborts.",
    grader: { type: "exact_match", expected: "anything" },
    agent: "generic",
    max_steps: 1,
  };
  const row = await runOne({
    layer: "l1",
    source: "test",
    task,
    modelAlias: "gpt-5-nano",
    modelOverride: mockModel(['await abort("missing capability");']),
    seed: 0,
    runId: "test-run",
    rexAiCommit: "abc",
  });
  assertEquals(row.finish_reason, "abort");
  assertEquals(row.score, 0);
  assertEquals(row.error, "missing capability");
});

Deno.test("runOne: trajectory captures multi-step reflect → reply", async () => {
  const task: TaskDef = {
    id: "test-multi-1",
    task: "Multi-step task.",
    grader: { type: "exact_match", expected: "done" },
    agent: "generic",
    max_steps: 3,
  };
  const row = await runOne({
    layer: "l1",
    source: "test",
    task,
    modelAlias: "gpt-5-nano",
    modelOverride: mockModel([
      'await reflect({ stage: "halfway" });',
      'await reply("done");',
    ]),
    seed: 0,
    runId: "test-run",
    rexAiCommit: "abc",
  });
  assertEquals(row.score, 1);
  assertEquals(row.steps, 2);
  assertEquals(row.trajectory[0].observation, { kind: "reflect" });
  assertEquals(
    (row.trajectory[1].observation as { kind: string }).kind,
    "reply",
  );
});
