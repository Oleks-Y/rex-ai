// Integration test for the BFCL adapter — drives `RexAiAdapter.doGenerate`
// with a fake inner V2 model and asserts the recorded tool calls flow back
// out as V2 tool-call content parts. Exercises the full rex-ai loop +
// sandbox; no API keys, no network.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type {
  JSONSchema7,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2FunctionTool,
} from "@ai-sdk/provider";
import { generateText, jsonSchema, tool as aiTool } from "ai";
import { RexAiAdapter } from "../../bfcl/adapter.ts";

function mockInnerModel(scripts: string[]): LanguageModelV2 {
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

function fnTool(
  name: string,
  inputSchema: JSONSchema7,
  description = "",
): LanguageModelV2FunctionTool {
  return { type: "function", name, description, inputSchema };
}

function callOptions(
  prompt: string,
  tools: LanguageModelV2FunctionTool[],
): LanguageModelV2CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    tools,
    toolChoice: { type: "auto" },
  };
}

Deno.test("RexAiAdapter: records single tool call and reply text", async () => {
  const adapter = new RexAiAdapter({
    innerModel: mockInnerModel([
      'const r = await search_flights({ from: "NYC", to: "LAX" });\nawait reply("done");',
    ]),
    providerLabel: "rex-ai+mock",
    modelId: "rex-mock-1",
    maxSteps: 2,
  });

  const result = await adapter.doGenerate(callOptions(
    "find me a flight from NYC to LAX",
    [fnTool("search_flights", {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
    })],
  ));

  const toolCalls = result.content.filter((c) => c.type === "tool-call");
  const texts = result.content.filter((c) => c.type === "text");
  assertEquals(toolCalls.length, 1);
  assertEquals(toolCalls[0].toolName, "search_flights");
  assertEquals(
    JSON.parse(toolCalls[0].input),
    { from: "NYC", to: "LAX" },
  );
  assertEquals(texts.length, 1);
  assertEquals(texts[0].text, "done");
  assertEquals(result.finishReason, "tool-calls");
});

Deno.test("RexAiAdapter: records multiple tool calls in order", async () => {
  const adapter = new RexAiAdapter({
    innerModel: mockInnerModel([
      'await search_flights({ from: "SFO", to: "JFK" });\n' +
      'await book_flight({ id: "F1" });\n' +
      'await reply("ok");',
    ]),
    providerLabel: "rex-ai+mock",
    modelId: "rex-mock-1",
    maxSteps: 2,
  });

  const result = await adapter.doGenerate(callOptions(
    "book the first SFO→JFK flight",
    [
      fnTool("search_flights", {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
      }),
      fnTool("book_flight", {
        type: "object",
        properties: { id: { type: "string" } },
      }),
    ],
  ));

  const names = result.content
    .filter((c) => c.type === "tool-call")
    .map((c) => c.toolName);
  assertEquals(names, ["search_flights", "book_flight"]);
  assertEquals(result.finishReason, "tool-calls");
});

Deno.test("RexAiAdapter: pure reply with no tool calls finishes 'stop'", async () => {
  const adapter = new RexAiAdapter({
    innerModel: mockInnerModel(['await reply("nothing to do");']),
    providerLabel: "rex-ai+mock",
    modelId: "rex-mock-1",
    maxSteps: 2,
  });

  const result = await adapter.doGenerate(callOptions(
    "say hi",
    [fnTool("noop", { type: "object" })],
  ));

  const toolCalls = result.content.filter((c) => c.type === "tool-call");
  const texts = result.content.filter((c) => c.type === "text");
  assertEquals(toolCalls.length, 0);
  assertEquals(texts.length, 1);
  assertEquals(texts[0].text, "nothing to do");
  assertEquals(result.finishReason, "stop");
});

Deno.test("RexAiAdapter: agent abort surfaces as finishReason='other' + providerMetadata", async () => {
  const adapter = new RexAiAdapter({
    innerModel: mockInnerModel(['await abort("missing capability");']),
    providerLabel: "rex-ai+mock",
    modelId: "rex-mock-1",
    maxSteps: 2,
  });

  const result = await adapter.doGenerate(callOptions(
    "do the thing",
    [fnTool("noop", { type: "object" })],
  ));

  assertEquals(result.finishReason, "other");
  const text = result.content.find((c) => c.type === "text");
  assertStringIncludes(text?.text ?? "", "missing capability");
  const meta = result.providerMetadata?.["rex-ai"]?.error;
  assertEquals(meta, "missing capability");
});

Deno.test("RexAiAdapter: AI SDK generateText surfaces tool calls + text", async () => {
  // Drives the adapter the way @ai-sdk-tool/eval BFCL does, via the AI SDK
  // `generateText` entry point. Verifies our V2 content array parses into
  // public `toolCalls` / `text` correctly — the contract BFCL grades against.
  const adapter = new RexAiAdapter({
    innerModel: mockInnerModel([
      'await search_flights({ from: "SFO", to: "JFK" });\nawait reply("done");',
    ]),
    providerLabel: "rex-ai+mock",
    modelId: "rex-mock-1",
    maxSteps: 2,
  });

  const result = await generateText({
    model: adapter,
    prompt: "find me a flight from SFO to JFK",
    tools: {
      search_flights: aiTool({
        description: "Search for flights",
        inputSchema: jsonSchema<{ from: string; to: string }>({
          type: "object",
          properties: { from: { type: "string" }, to: { type: "string" } },
          required: ["from", "to"],
        }),
        execute: () => Promise.resolve({ ok: true }),
      }),
    },
  });

  assertEquals(result.toolCalls.length, 1);
  assertEquals(result.toolCalls[0].toolName, "search_flights");
  assertEquals(result.toolCalls[0].input, { from: "SFO", to: "JFK" });
  assertEquals(result.text, "done");
  assertEquals(result.finishReason, "tool-calls");
});

Deno.test("RexAiAdapter: loop exhaustion finishes 'length'", async () => {
  // Each step is a non-terminal reflect; with maxSteps: 1 the agent loop
  // records one step and falls through to kind:"exhausted".
  const adapter = new RexAiAdapter({
    innerModel: mockInnerModel(['await reflect({ stage: "thinking" });']),
    providerLabel: "rex-ai+mock",
    modelId: "rex-mock-1",
    maxSteps: 1,
  });

  const result = await adapter.doGenerate(callOptions(
    "ponder",
    [fnTool("noop", { type: "object" })],
  ));

  assertEquals(result.finishReason, "length");
});
