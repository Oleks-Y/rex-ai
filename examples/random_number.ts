// Agent definition for the CLI: a factory that wires the model + tools +
// permissions, leaving task / sessionId / onStep to the CLI invocation.
//
// CLI:
//   OPENAI_API_KEY=... deno run -A src/cli.ts \
//     --agent examples/random_number.ts \
//     --session demo \
//     -- "Generate a random integer between 1 and 100 and reply with just the number."
//
// Direct (no CLI):
//   OPENAI_API_KEY=... deno run -A examples/random_number.ts

import { Agent } from "../src/mod.ts";
import { createOpenAI } from "npm:@ai-sdk/openai@2";
import type { AgentFactoryInput } from "../src/cli.ts";

// Cerebras exposes an OpenAI-compatible Chat Completions endpoint, so the
// @ai-sdk/openai provider works as long as we point it at Cerebras's baseURL
// and use the CEREBRAS_API_KEY. Model id on Cerebras for GPT-OSS-120B is
// `gpt-oss-120b`.
const apiKey = Deno.env.get("CEREBRAS_API_KEY") ?? "";
if (apiKey === "") {
  console.error("[example] WARN: CEREBRAS_API_KEY is empty");
}

const cerebras = createOpenAI({
  baseURL: "https://api.cerebras.ai/v1",
  apiKey,
  name: "cerebras",
});

// Model id per Cerebras docs (https://inference-docs.cerebras.ai/models/overview).
// gpt-oss-120b is a production model and is the example used in their
// quickstart; pricing page confirms all models are available even on the
// Free tier. If a fresh key returns "Model gpt-oss-120b does not exist or
// you do not have access to it", verify what /v1/models returns for your key:
//   curl -H "Authorization: Bearer $CEREBRAS_API_KEY" \
//        https://api.cerebras.ai/v1/models | jq '.data[].id'
const MODEL_ID = "gpt-oss-120b";

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    // Use `.chat()` explicitly: @ai-sdk/openai v2's default factory targets
    // OpenAI's `/responses` endpoint, which Cerebras doesn't implement
    // (returns 404 Not Found). Cerebras only supports `/chat/completions`.
    model: cerebras.chat(MODEL_ID),
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    permissions: {}, // no net / fs needed: Math.random() suffices
    maxSteps: 3,
    experimental: input.asyncWakeups ? { asyncWakeups: true } : undefined,
  });
}

if (import.meta.main) {
  const result = await createAgent({
    task:
      "Generate a random integer between 1 and 100 (inclusive) and reply with just the number.",
  }).run();
  console.log("RESULT:", result);
}
