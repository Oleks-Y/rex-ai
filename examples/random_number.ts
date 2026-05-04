// Smoke test: ask the agent to generate a random number.
//
// Run:  OPENAI_API_KEY=... deno run \
//         --allow-read --allow-write --allow-env --allow-sys --allow-run \
//         examples/random_number.ts

import { Agent } from "../src/mod.ts";
import { openai } from "npm:@ai-sdk/openai@2";

const result = await new Agent({
  model: openai("gpt-5-nano"),
  task:
    "Generate a random integer between 1 and 100 (inclusive) and reply with just the number.",
  // No tools, no net — Math.random() is enough.
  permissions: {},
  maxSteps: 3,
}).run();

console.log("RESULT:", result);
