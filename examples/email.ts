// Agent definition: send an email.
//
// Architectural point this demonstrates:
//   - The sandbox has NO permissions (no net, no fs writes, no subprocess).
//   - Email sending is exposed as a TOOL.
//   - Tools execute in the parent process (per §7, Parent-RPC), so they
//     can do privileged things the LLM-generated code can't.
//   - Net access for the email provider lives entirely in the parent.
//
// Run via CLI:
//   OPENAI_API_KEY=... deno run -A src/cli.ts \
//     --agent examples/email.ts --session inbox -- \
//     "Send an email to alice@example.com saying hi."
//
// The actual delivery is stubbed — the tool persists the message to
// .rex/sent/<timestamp>.eml so you can verify the call shape. To wire up
// a real provider, replace the body of `sendEmailHandler` with a fetch
// to Resend / SendGrid / SES / etc.

import { Agent, defineTool } from "../src/mod.ts";
import { openai } from "npm:@ai-sdk/openai@2";
import { z } from "zod";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { AgentFactoryInput } from "../src/cli.ts";

const SENT_DIR = join(Deno.cwd(), ".rex", "sent");

async function sendEmailHandler(args: { to: string; subject: string; body: string }) {
  // STUB: persist the message instead of hitting an SMTP/API provider.
  // Replace with a real `fetch(...)` to your provider when ready.
  await ensureDir(SENT_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeTo = args.to.replace(/[^a-zA-Z0-9@._-]/g, "_");
  const path = join(SENT_DIR, `${ts}__${safeTo}.eml`);
  const eml = [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "",
    args.body,
  ].join("\n");
  await Deno.writeTextFile(path, eml);
  console.error(`[parent] sendEmail: wrote ${path}`);
  return { ok: true, savedTo: path };
}

const sendEmail = defineTool({
  name: "sendEmail",
  description:
    "Send an email. Returns { ok: true, savedTo: string } on success. " +
    "Throws ToolError if the address is invalid.",
  schema: z.object({
    to: z.string().email().describe("recipient email address"),
    subject: z.string().min(1).describe("subject line"),
    body: z.string().min(1).describe("plain-text body"),
  }),
  handler: sendEmailHandler,
});

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    model: openai("gpt-5.5"),
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    tools: [sendEmail],
    // Locked-down sandbox — the LLM cannot fetch, read fs beyond its
    // session dir, or spawn anything. The only way to send mail is the
    // sendEmail tool, which runs parent-side.
    permissions: {},
    maxSteps: 4,
  });
}

if (import.meta.main) {
  const result = await createAgent({
    task: "Send an email to alice@example.com with subject 'hello' and body 'sup?'",
  }).run();
  console.log("RESULT:", result);
}
