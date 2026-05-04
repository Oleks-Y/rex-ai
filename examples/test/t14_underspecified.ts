// T14 — vague task; model has sendEmail but no recipient.
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
  handler: (args) => {
    console.error(`[parent] sendEmail called in T14 with to=${args.to}`);
    return { ok: true, to: args.to };
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
