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
import { openai } from "npm:@ai-sdk/openai@2";
import type { AgentFactoryInput } from "../src/cli.ts";

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    model: openai("gpt-5-nano"),
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    permissions: {}, // no net / fs needed: Math.random() suffices
    maxSteps: 3,
  });
}

if (import.meta.main) {
  const result = await createAgent({
    task:
      "Generate a random integer between 1 and 100 (inclusive) and reply with just the number.",
  }).run();
  console.log("RESULT:", result);
}
