// Dreaming agents — a support-conversation agent + a dreamer that
// watches every parent `reply` for unresolved customer issues and
// creates a (mock) support ticket when it sees one.
//
// The parent agent has the actual customer-facing tools. The dreamer
// runs alongside it with its OWN sandbox, OWN model, OWN task, and
// OWN tools (a `createTicket` mock that the parent doesn't have or
// need). The dreamer reads the parent's session dir read-only — it
// can inspect the parent's transcript but cannot mutate it.
//
// CLI:
//   OPENAI_API_KEY=... deno run -A src/cli.ts \
//     --agent examples/dreaming_ticket_writer.ts \
//     --session support \
//     -- "I can't reset my password and the support page is down."
//
// Direct (no CLI):
//   OPENAI_API_KEY=... deno run -A examples/dreaming_ticket_writer.ts
//
// On exit, inspect the dreamer's index at:
//   .rex/sessions/<id>/dreams/ticket-writer/dream.jsonl
// and its full transcript at:
//   .rex/sessions/<id>/dreams/ticket-writer/transcript.jsonl

import { Agent, defineDreamer, defineTool } from "../src/mod.ts";
import { openai } from "npm:@ai-sdk/openai@2";
import { z } from "npm:zod@4";
import type { AgentFactoryInput } from "../src/cli.ts";

// ── Parent agent: a tiny customer-support assistant ────────────────────

const lookupAccount = defineTool({
  name: "lookupAccount",
  description: "Look up a customer account by email. Returns the plan tier.",
  schema: z.object({ email: z.string() }),
  // deno-lint-ignore require-await
  handler: async ({ email }) => {
    return { email, tier: email.endsWith("@enterprise.example") ? "enterprise" : "free" };
  },
});

// ── Dreamer: a ticket writer running alongside the parent ──────────────

const createTicket = defineTool({
  name: "createTicket",
  description:
    "Create a support ticket. Returns the ticket id. ONLY call this when the agent's reply indicates an unresolved customer issue (not a clarifying question, not a successful resolution).",
  schema: z.object({
    summary: z.string().describe("One-sentence summary of the unresolved issue."),
    severity: z.enum(["low", "medium", "high"]),
  }),
  // deno-lint-ignore require-await
  handler: async ({ summary, severity }) => {
    const id = "TKT-" + Math.floor(Math.random() * 100_000).toString().padStart(5, "0");
    return { id, summary, severity, status: "open" };
  },
});

const dreamer = defineDreamer({
  name: "ticket-writer",
  // Fire on every parent reply. Most replies won't warrant a ticket;
  // the dreamer decides.
  triggers: ["reply"],
  // The dreamer can use a small, cheap model — it's reading short
  // summaries and writing a structured tool call.
  model: openai("gpt-5-nano"),
  task: [
    "You are a support-ops assistant. You watch a live customer-support",
    "conversation. For each parent agent reply you receive, decide:",
    "  1) Is the customer's issue UNRESOLVED?",
    "  2) If yes, call createTicket() with a one-sentence summary + severity.",
    "  3) If no, just reply with `noop`.",
    "",
    "Severity rubric: low (cosmetic / FAQ), medium (functional impairment,",
    "workaround exists), high (account locked, data loss, outage).",
    "",
    "Never write to disk. Your transcript is recorded automatically.",
  ].join("\n"),
  tools: [createTicket],
  maxStepsPerFire: 3,
  // The dreamer's network access is independent of the parent's. If
  // your real ticket system requires net access, list its host here.
  permissions: {},
  // Always wait — for a real ticketing workflow we'd rather the parent
  // shut down a few hundred ms later than miss a ticket.
});

// ── Wiring ─────────────────────────────────────────────────────────────

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    model: openai("gpt-5-nano"),
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    experimental: input.asyncWakeups ? { asyncWakeups: true } : undefined,
    tools: [lookupAccount],
    permissions: {},
    maxSteps: 5,
    dreamers: [dreamer],
    awaitDreamsOnClose: true,
    onDream: (ev) => {
      // Surface dreamer activity inline so the CLI demo shows it. Keep
      // it terse — a real host would route this to a UI / dashboard.
      if (ev.kind === "fired") {
        console.error(
          `[dream:${ev.dreamer}] fired on ${ev.triggerKind} (step ${ev.stepIndex})`,
        );
      } else if (ev.kind === "finished") {
        const tail = ev.ok ? (ev.reply ?? "(no reply)") : `error: ${ev.error}`;
        console.error(
          `[dream:${ev.dreamer}] finished in ${ev.durationMs}ms, steps=${ev.steps}, ${tail}`,
        );
      } else if (ev.kind === "dropped") {
        console.error(`[dream:${ev.dreamer}] dropped (${ev.reason})`);
      }
    },
  });
}

if (import.meta.main) {
  const result = await createAgent({
    task:
      "I can't reset my password and the support page is down. " +
      "My email is alice@enterprise.example.",
  }).run();
  console.log("RESULT:", result);
}
