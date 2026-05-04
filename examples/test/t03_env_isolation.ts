// T03 — sandbox cannot read parent env vars.
import { Agent } from "../../src/mod.ts";
import { openai } from "npm:@ai-sdk/openai@2";
import type { AgentFactoryInput } from "../../src/cli.ts";

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    model: openai("gpt-5-nano"),
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    permissions: {},
    maxSteps: 3,
  });
}
