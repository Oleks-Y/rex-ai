// T08 — write to allowlisted dir works, outside is denied.
// Pre-req: ./scratch/ exists. The user's CWD when the CLI runs is the rex-ai
// repo root, so "./scratch" resolves to /Users/alex/proj/rex-ai/scratch.
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
    permissions: { write: ["./scratch"] },
    maxSteps: 3,
  });
}
