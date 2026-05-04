// T13 — task asks for a tool that doesn't exist; only sendEmail is exposed.
import { Agent, defineTool } from "../../src/mod.ts";
import { openai } from "npm:@ai-sdk/openai@2";
import { z } from "zod";
import type { AgentFactoryInput } from "../../src/cli.ts";

const sendEmail = defineTool({
  name: "sendEmail",
  description: "Send an email. Returns { ok: true } on success.",
  schema: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  // Should NOT be invoked in this test — the model must NOT misuse it for SMS.
  handler: (args) => {
    console.error(`[parent] WARNING: sendEmail called in T13: ${JSON.stringify(args)}`);
    return { ok: true };
  },
});

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    model: openai("gpt-5-nano"),
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    tools: [sendEmail],
    permissions: {},
    maxSteps: 3,
  });
}
