// rex-ai LanguageModelV2 adapter — drives BFCL through the rex-ai harness.
//
// BFCL's benchmarks call `generateText({ model, messages, tools })`. The
// AI SDK funnels that into `model.doGenerate(options)`. We implement
// `doGenerate` so that — instead of asking a provider directly — it spins
// up a rex-ai `Agent` whose tools are recording stubs, runs the
// code-action loop with an inner real model, and surfaces every tool
// invocation back to BFCL as a tool-call content part.
//
// What this measures:
//   the rex-ai loop's ability to translate BFCL's task into the right
//   sequence of tool calls. The inner model is the LLM doing the
//   reasoning; the harness (prelude + sandbox + prompt builder) is what
//   we're scoring.
//
// What this deliberately does NOT do:
//   - Honor BFCL's expected return values from each tool. We hand the
//     model `{ ok: true }` regardless. BFCL grades tool-call signatures
//     (name + args), not downstream behavior, so this is fine for
//     single-turn benches. Multi-turn benches that depend on realistic
//     tool returns will score lower than a tool-call-native model — that
//     is a true property of running rex-ai through a function-calling
//     benchmark, not an adapter bug.
//   - Track tokens / cost. Token usage is recorded as zero; populate from
//     the inner model's response when we plumb usage through Agent.run().

import type {
  JSONSchema7,
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2FunctionTool,
  LanguageModelV2Prompt,
  SharedV2ProviderMetadata,
} from "@ai-sdk/provider";

type JsonPrimitive = "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";

import { z } from "zod";
import { Agent, defineTool } from "../../src/mod.ts";
import type { ToolDefinition } from "../../src/types.ts";

export interface RexAiAdapterOptions {
  /** The real provider model rex-ai will reason with. */
  innerModel: LanguageModelV2;
  /** Provider name surfaced for logging (e.g. `rex-ai+gpt-5-nano`). */
  providerLabel: string;
  /** Pinned dated model id (recorded in eval JSONL). */
  modelId: string;
  /** Hard cap on rex-ai loop iterations per BFCL turn. Default 4. */
  maxSteps?: number;
}

export interface ToolCallRecord {
  toolName: string;
  args: unknown;
}

/** Wraps a provider model so BFCL drives the full rex-ai code-action
 *  loop. Implements the V2 surface so it can be passed to AI SDK 5/6
 *  `generateText` without a typecast. */
export class RexAiAdapter implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  readonly #inner: LanguageModelV2;
  readonly #maxSteps: number;

  constructor(opts: RexAiAdapterOptions) {
    this.#inner = opts.innerModel;
    this.#maxSteps = opts.maxSteps ?? 4;
    this.provider = opts.providerLabel;
    this.modelId = opts.modelId;
  }

  doGenerate(
    options: LanguageModelV2CallOptions,
  ): ReturnType<LanguageModelV2["doGenerate"]> {
    return this.#runHarness(options);
  }

  doStream(): ReturnType<LanguageModelV2["doStream"]> {
    // BFCL goes through generateText, not streamText; we don't need
    // streaming and don't want to maintain two code paths.
    throw new Error(
      "RexAiAdapter does not implement doStream. BFCL uses generateText.",
    );
  }

  async #runHarness(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const recorded: ToolCallRecord[] = [];
    const toolDefs = collectFunctionTools(options.tools).map(
      (t) => buildRecordingTool(t, recorded),
    );

    const task = formatPromptAsTask(options.prompt);
    const agent = new Agent({
      model: this.#inner,
      task,
      tools: toolDefs,
      permissions: {},
      maxSteps: this.#maxSteps,
    });

    let replyText = "";
    let agentError: string | undefined;
    let finishReason: LanguageModelV2FinishReason = "stop";
    try {
      const result = await agent.run();
      switch (result.kind) {
        case "reply":
          replyText = result.message;
          break;
        case "abort":
          replyText = `[rex-ai abort] ${result.error}`;
          agentError = result.error;
          finishReason = "other";
          break;
        case "exhausted":
          agentError = `rex-ai loop exhausted after ${result.steps} steps`;
          finishReason = "length";
          break;
      }
    } catch (e) {
      agentError = (e as Error).message;
      finishReason = "error";
    }

    const content: LanguageModelV2Content[] = [];
    for (let i = 0; i < recorded.length; i++) {
      const r = recorded[i];
      content.push({
        type: "tool-call",
        toolCallId: `rex-${i}-${randomId()}`,
        toolName: r.toolName,
        input: stableStringify(r.args),
      });
    }
    if (replyText.length > 0) {
      content.push({ type: "text", text: replyText });
    }
    if (recorded.length > 0 && finishReason === "stop") {
      finishReason = "tool-calls";
    }

    const providerMetadata: SharedV2ProviderMetadata | undefined = agentError
      ? { "rex-ai": { error: agentError } }
      : undefined;

    return {
      content,
      finishReason,
      // No usage plumbed yet; populate when Agent.run() returns it.
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      warnings: [],
      providerMetadata,
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────────

function collectFunctionTools(
  tools: LanguageModelV2CallOptions["tools"],
): LanguageModelV2FunctionTool[] {
  if (!tools) return [];
  const out: LanguageModelV2FunctionTool[] = [];
  for (const t of tools) {
    if (t.type === "function") out.push(t);
  }
  return out;
}

function buildRecordingTool(
  t: LanguageModelV2FunctionTool,
  recorded: ToolCallRecord[],
): ToolDefinition {
  // BFCL grades the *signature* of the call, so we accept anything the
  // model produces. Validating against the BFCL JSONSchema would reject
  // calls the underlying model would have made (and that BFCL might have
  // accepted), masking real harness behavior.
  const schema = z.unknown();
  return defineTool({
    name: t.name,
    description: t.description ?? "",
    schema,
    handler: (args: unknown) => {
      recorded.push({ toolName: t.name, args });
      // Synthetic placeholder. Real BFCL backends would return a parsed
      // result; we don't have one, but the prelude needs *something*
      // serializable so the model's code can continue if it wants to
      // chain calls.
      return { ok: true } as const;
    },
    tsSignature: jsonSchemaToTsSignature(t.inputSchema),
  });
}

/** Best-effort JSONSchema → TS so the prompt's tool catalog reads sensibly.
 *  We don't need fidelity — the model gets the BFCL system prompt anyway —
 *  but a useful signature beats `(args: unknown)`. */
export function jsonSchemaToTsSignature(schema: JSONSchema7): string {
  return `(args: ${jsonSchemaToTs(schema)}): Promise<unknown>`;
}

function jsonSchemaToTs(schema: JSONSchema7 | undefined): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (Array.isArray(schema.type)) {
    return (schema.type as JsonPrimitive[]).map(primitiveTs).join(" | ");
  }
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  }
  switch (schema.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return primitiveTs(schema.type);
    case "array": {
      const items = (schema.items as JSONSchema7) ?? {};
      return `Array<${jsonSchemaToTs(items)}>`;
    }
    case "object": {
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const lines: string[] = [];
      for (const [k, v] of Object.entries(props)) {
        const opt = required.has(k) ? "" : "?";
        const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
        lines.push(`  ${key}${opt}: ${jsonSchemaToTs(v as JSONSchema7)};`);
      }
      return lines.length === 0 ? "Record<string, unknown>" : `{\n${lines.join("\n")}\n}`;
    }
    default:
      return "unknown";
  }
}

function primitiveTs(t: JsonPrimitive | string): string {
  switch (t) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

/** Render the AI SDK message list into a single rex-ai task description.
 *  We collapse history into prose because rex-ai's prompt builder owns the
 *  system prompt; injecting BFCL's system prompt directly would conflict
 *  with the code-action contract. */
export function formatPromptAsTask(prompt: LanguageModelV2Prompt): string {
  const parts: string[] = [
    "You are completing the user's request through the rex-ai code-action loop.",
    "Use ONLY the listed tools to satisfy the request. Each tool call is " +
    "recorded for grading. Once you have made every necessary tool call, " +
    'call `reply("done")` to terminate.',
  ];
  const transcript: string[] = [];
  for (const msg of prompt) {
    switch (msg.role) {
      case "system":
        transcript.push(`SYSTEM: ${msg.content}`);
        break;
      case "user": {
        const text = msg.content
          .map((p) => (p.type === "text" ? p.text : "[non-text part]"))
          .join(" ");
        transcript.push(`USER: ${text}`);
        break;
      }
      case "assistant": {
        const chunks: string[] = [];
        for (const p of msg.content) {
          if (p.type === "text") chunks.push(p.text);
          else if (p.type === "tool-call") {
            chunks.push(
              `[called ${p.toolName} with ${stableStringify(p.input)}]`,
            );
          }
        }
        if (chunks.length > 0) transcript.push(`ASSISTANT: ${chunks.join(" ")}`);
        break;
      }
      case "tool": {
        const chunks: string[] = [];
        for (const p of msg.content) {
          chunks.push(
            `[${p.toolName} returned ${
              stableStringify(extractToolResult(p.output))
            }]`,
          );
        }
        if (chunks.length > 0) transcript.push(`TOOL: ${chunks.join(" ")}`);
        break;
      }
    }
  }
  if (transcript.length > 0) {
    parts.push("Conversation so far:");
    parts.push(transcript.join("\n"));
  }
  return parts.join("\n\n");
}

function extractToolResult(
  output: import("@ai-sdk/provider").LanguageModelV2ToolResultOutput,
): unknown {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return output.value;
    case "content":
      return output.value;
  }
}

function stableStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function randomId(): string {
  return crypto.randomUUID().slice(0, 8);
}
