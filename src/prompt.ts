// PromptBuilder — renders the system prompt + per-step transcript that the
// agent sends to the LLM.
//
// Per §12 + §14a:
//   - Always include the code-action contract + the three control fns.
//   - List tools with name + signature (zod-to-ts) + description.
//   - Render the granted permissions explicitly.
//   - Surface session lib exports + full source + storage keys (so the
//     model knows what helpers and KV state it already has).
//   - Append prior steps (full transcript per §8 option B): each prior
//     step's code, log lines, terminal event, and any error.
//
// The output is a single string used as the system + user message body; the
// Agent decides how to slot it into the message history.

import type { ToolDescription } from "./tools.ts";
import type { PermissionsConfig, SandboxEvent } from "./types.ts";
import { zodToTs } from "./zod_to_ts.ts";

export interface PriorStep {
  code: string;
  event: SandboxEvent;
}

export interface SessionSnapshot {
  /** Names of currently exported symbols from `session:lib`. */
  libExports: string[];
  /** Current `lib.ts` source. Empty (or "export {};") when unused. */
  libSource: string;
  /** Currently-set storage keys. */
  storageKeys: string[];
}

export interface PromptInput {
  task: string;
  tools: ToolDescription[];
  permissions: PermissionsConfig | undefined;
  session: SessionSnapshot;
  priorSteps: PriorStep[];
}

export const PromptBuilder = {
  /** Render the full prompt body (system + state + transcript + task). */
  build(input: PromptInput): string {
    return [
      headerBlock(),
      permissionsBlock(input.permissions),
      toolsBlock(input.tools),
      sessionBlock(input.session),
      priorStepsBlock(input.priorSteps),
      taskBlock(input.task),
    ].filter((s) => s.length > 0).join("\n\n");
  },
};

// ── blocks ────────────────────────────────────────────────────────────────

function headerBlock(): string {
  return [
    "You are a code-action agent. You produce TypeScript code that runs in a",
    "Deno sandbox. You DO NOT return tool calls. You return a single ```ts",
    "block.",
    "",
    "Your code MUST exit through exactly one of these control functions:",
    "  - reply(message: string)   — final answer to the user",
    "  - abort(error: string)     — refuse / fail when capability is missing",
    "  - reflect(state: unknown)  — pause and request another generation step",
    "",
    "Calling a tool with arguments that fail validation throws a ToolError",
    "carrying the specific zod issues. Catch and recover, or call abort().",
    "",
    "A disallowed fetch / read / write / import surfaces as a permission_denied",
    "event on the next step rather than a thrown exception you can catch.",
  ].join("\n");
}

function permissionsBlock(p: PermissionsConfig | undefined): string {
  const net = p?.net?.length ? p.net.join(", ") : "(none)";
  const read = p?.read?.length ? p.read.join(", ") : "(none beyond session workspace)";
  const write = p?.write?.length ? p.write.join(", ") : "(none)";
  const run = p?.run ? "yes" : "no";
  const modules = p?.modules?.length ? p.modules.join(", ") : "(none beyond session:lib)";
  return [
    "Permissions granted to your sandbox:",
    `  - network:    ${net}`,
    `  - file read:  ${read}`,
    `  - file write: ${write}`,
    `  - subprocess: ${run}`,
    `  - modules:    ${modules}`,
    "",
    "If you need a capability not listed, call abort() with a clear explanation.",
  ].join("\n");
}

function toolsBlock(tools: ToolDescription[]): string {
  if (tools.length === 0) {
    return "Tools: (none registered).";
  }
  const lines: string[] = ["Tools available (callable as async functions):"];
  for (const t of tools) {
    const sig = t.tsSignature ?? renderSignature(t);
    lines.push(`  - ${t.name}${sig}`);
    if (t.description) lines.push(`      ${t.description}`);
  }
  return lines.join("\n");
}

function renderSignature(t: ToolDescription): string {
  // Args type from zod schema. Result is unknown (we don't know what the
  // handler returns at the type level — the description should explain it).
  const args = zodToTs(t.schema);
  return `(args: ${args}): Promise<unknown>`;
}

function sessionBlock(s: SessionSnapshot): string {
  const exports = s.libExports.length === 0 ? "(empty)" : s.libExports.join(", ");
  const src = s.libSource.trim() === "" || s.libSource.trim() === "export {};"
    ? "(empty)"
    : s.libSource.trimEnd();
  const storage = s.storageKeys.length === 0 ? "(empty)" : s.storageKeys.join(", ");
  return [
    "Session workspace:",
    "  - You may rewrite your reusable helper module with `writeLib(source)`.",
    '    Its exports are importable next step via `import { ... } from "session:lib"`.',
    "    writeLib replaces the entire file — include any prior helpers you want to keep.",
    "  - You may persist data with `storage.{get, set, del, keys}`.",
    `  - Current lib.ts exports: ${exports}`,
    "  - Current lib.ts source:",
    indent(src, 6),
    `  - Storage keys: ${storage}`,
  ].join("\n");
}

function priorStepsBlock(steps: PriorStep[]): string {
  if (steps.length === 0) return "";
  const lines: string[] = ["Prior steps:"];
  steps.forEach((step, i) => {
    lines.push("");
    lines.push(`--- step ${i + 1} ---`);
    lines.push("Your code was:");
    lines.push("```ts");
    lines.push(step.code);
    lines.push("```");
    if (step.event.logs.length > 0) {
      lines.push("Logs from this step:");
      for (const log of step.event.logs) {
        lines.push(`  [${log.level}] ${log.args.map((a) => safeStr(a)).join(" ")}`);
      }
    }
    lines.push(eventSummary(step.event));
  });
  return lines.join("\n");
}

function eventSummary(ev: SandboxEvent): string {
  switch (ev.kind) {
    case "reflect":
      return `Result: reflect — state passed forward: ${safeStr(ev.state)}`;
    case "permission_denied":
      return `Result: permission_denied — ${ev.permission} access to "${ev.target}" was blocked. Either work around it or abort with an explanation.`;
    case "throw":
      return `Result: threw an error — ${ev.error}\nFix the cause or abort.`;
    case "reply":
    case "abort":
      // These are terminal — we shouldn't see them in prior-steps, but if we
      // do, surface them so the model has full context.
      return `Result: ${ev.kind}`;
  }
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text.split("\n").map((l) => pad + l).join("\n");
}

function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function taskBlock(task: string): string {
  return `Task: ${task}`;
}
