// rex-ai CLI — command runner around an Agent factory.
//
// Two modes:
//   one-shot (default): runs the agent until a terminal event, prints it.
//   interactive (`--interactive` / `-i`): opens a long-lived AgentSession,
//     reads user messages from stdin between turns, and streams events
//     including async wakeups. Requires the agent to enable
//     `experimental.asyncWakeups`; the CLI sets `asyncWakeups: true` on
//     the factory input so factories can pass it through.
//
// Usage (one-shot):
//   deno run -A src/cli.ts \
//     --agent <path-to-agent.ts> \
//     [--session <id>] \
//     [--max-steps <n>] \
//     [--no-color] \
//     -- <task...>
//
// Usage (interactive):
//   deno run -A src/cli.ts --interactive \
//     --agent <path-to-agent.ts> \
//     [--session <id>] [--no-color] \
//     -- <initial task...>
//
// The --agent file must `export default` a factory:
//
//   export default function (input: AgentFactoryInput): Agent { ... }
//
//   where AgentFactoryInput is { task, sessionId?, onStep?, resumeHistory?,
//   asyncWakeups? } and the returned Agent already has model / permissions
//   / tools wired.

import { resolve, toFileUrl } from "@std/path";
import type { Agent } from "./agent.ts";
import type { AgentEvent, AgentSession, StepRecord } from "./types.ts";

export interface AgentFactoryInput {
  task: string;
  sessionId?: string;
  onStep?: (step: StepRecord) => void | Promise<void>;
  /** Whether to replay transcript.jsonl on resume. CLI sets this to true. */
  resumeHistory?: boolean;
  /** Whether to enable experimental async-wakeup mode. CLI sets this to
   *  true when invoked with `--interactive`. Factories should forward it
   *  to `new Agent({ experimental: { asyncWakeups } })`. */
  asyncWakeups?: boolean;
}

export type AgentFactory = (input: AgentFactoryInput) => Agent | Promise<Agent>;

// ── ANSI helpers ──────────────────────────────────────────────────────────

export function makeColor(enabled: boolean) {
  const wrap = (open: number, close: number) => (s: string): string =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    grey: wrap(90, 39),
  };
}

// ── arg parsing (tiny — no @std dep) ──────────────────────────────────────

export interface ParsedArgs {
  agent?: string;
  session?: string;
  maxSteps?: number;
  color: boolean;
  help: boolean;
  interactive: boolean;
  task: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    color: true,
    help: false,
    interactive: false,
    task: "",
  };
  const taskParts: string[] = [];
  let i = 0;
  let separatorSeen = false;
  while (i < argv.length) {
    const a = argv[i];
    if (separatorSeen) {
      taskParts.push(a);
      i++;
      continue;
    }
    if (a === "--") {
      separatorSeen = true;
      i++;
      continue;
    }
    if (a === "-h" || a === "--help") {
      out.help = true;
      i++;
      continue;
    }
    if (a === "--no-color") {
      out.color = false;
      i++;
      continue;
    }
    if (a === "-i" || a === "--interactive") {
      out.interactive = true;
      i++;
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const val = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
    const advance = eq >= 0 ? 1 : 2;
    switch (key) {
      case "--agent":
      case "-a":
        out.agent = val;
        i += advance;
        continue;
      case "--session":
      case "-s":
        out.session = val;
        i += advance;
        continue;
      case "--max-steps":
        out.maxSteps = Number(val);
        i += advance;
        continue;
      default:
        // Treat anything else as part of the task (positional).
        taskParts.push(a);
        i++;
    }
  }
  out.task = taskParts.join(" ").trim();
  return out;
}

const HELP = `rex - agent runner

Usage:
  deno run -A src/cli.ts --agent <path> [--session <id>] [--max-steps <n>] [--no-color] -- <task...>
  deno run -A src/cli.ts --interactive --agent <path> [--session <id>] [--no-color] -- <initial task...>

Options:
  -a, --agent <path>       Required. Path to a .ts file with a default-exported
                           Agent factory (input: { task, sessionId, onStep,
                           resumeHistory, asyncWakeups }) => Agent.
  -s, --session <id>       Persistent session id. Reusing the id continues
                           the prior conversation (lib + storage + transcript).
  -i, --interactive        Open a long-lived AgentSession (experimental
                           async-wakeups). Reads further user messages from
                           stdin between turns. Type "/exit" or send EOF
                           (Ctrl+D) to close.
      --max-steps <n>      Override the agent's maxSteps. (One-shot only.)
      --no-color           Disable ANSI colors.
  -h, --help               Show this help.

Notes:
  - The CLI never instantiates an Agent directly. It imports the factory
    so the model / permissions / tools live with the agent definition.
  - Conversation history lives in .rex/sessions/<id>/transcript.jsonl.
  - Reusing --session replays that transcript as the agent's prior steps.
  - In --interactive mode the CLI passes asyncWakeups: true to the factory.
    The factory must forward it to \`new Agent({ experimental: { asyncWakeups } })\`.
`;

// ── main ──────────────────────────────────────────────────────────────────

async function loadFactory(path: string): Promise<AgentFactory> {
  const abs = resolve(path);
  const url = toFileUrl(abs).href;
  const mod = await import(url);
  const fn = mod.default;
  if (typeof fn !== "function") {
    throw new Error(`agent file ${path} must default-export a factory function`);
  }
  return fn as AgentFactory;
}

function renderStep(step: StepRecord, c: ReturnType<typeof makeColor>): string {
  const lines: string[] = [];
  const tag = step.source === "resumed" ? c.dim("[resumed]") : c.bold("●");
  const head = `${tag} ${c.bold(`Step ${step.index}`)} ${c.grey("(" + step.event.kind + ")")}`;
  lines.push("");
  lines.push(head);
  lines.push(c.dim("─".repeat(60)));
  lines.push(c.dim("```ts"));
  for (const ln of step.code.split("\n")) lines.push(c.cyan(ln));
  lines.push(c.dim("```"));
  if (step.event.logs && step.event.logs.length > 0) {
    lines.push(c.dim("Logs:"));
    for (const log of step.event.logs) {
      const lvlColor = log.level === "error"
        ? c.red
        : log.level === "warn"
        ? c.yellow
        : c.grey;
      const args = log.args.map((a) => typeof a === "string" ? a : safeJson(a)).join(" ");
      lines.push(`  ${lvlColor(`[${log.level}]`)} ${args}`);
    }
  }
  // Per-event tail.
  switch (step.event.kind) {
    case "reply":
      lines.push(`${c.green("→ reply:")} ${step.event.message}`);
      break;
    case "abort":
      lines.push(`${c.red("→ abort:")} ${step.event.error}`);
      break;
    case "reflect":
      lines.push(`${c.magenta("→ reflect state:")} ${safeJson(step.event.state)}`);
      break;
    case "permission_denied":
      lines.push(
        `${c.yellow("→ permission_denied:")} ${step.event.permission} → ${step.event.target}`,
      );
      break;
    case "throw":
      lines.push(`${c.red("→ threw:")} ${truncate(step.event.error, 800)}`);
      break;
  }
  return lines.join("\n");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Render an AgentEvent (interactive mode). The `step` kind is rendered
 *  via the existing one-shot `renderStep` so output matches between modes. */
export function renderAgentEvent(
  ev: AgentEvent,
  c: ReturnType<typeof makeColor>,
): string | null {
  switch (ev.kind) {
    case "step":
      return renderStep(
        { index: ev.index, source: ev.source, code: ev.code, event: ev.event },
        c,
      );
    case "reply":
      return `\n${c.green(c.bold("REPLY"))} ${c.dim(`(turn ${ev.turn}, ${ev.cause})`)} ${ev.message}`;
    case "abort":
      return `\n${c.red(c.bold("ABORT"))} ${c.dim(`(turn ${ev.turn}, ${ev.cause})`)} ${ev.error}`;
    case "exhausted":
      return `\n${c.yellow(c.bold("EXHAUSTED"))} ${c.dim(`(turn ${ev.turn}, ${ev.cause})`)} ${ev.steps} steps`;
    case "wakeup_scheduled":
      return c.magenta(`⏲  wakeup_scheduled ${ev.id} (${ev.wakeupKind}) — ${ev.reason}`);
    case "wakeup_resolved":
      return c.magenta(`✓  wakeup_resolved ${ev.id}`);
    case "wakeup_rejected":
      return c.red(`✗  wakeup_rejected ${ev.id}: ${ev.error}`);
    case "wakeup_cancelled":
      return c.yellow(`⊘  wakeup_cancelled ${ev.id}: ${ev.reason}`);
    case "session_closed":
      return c.dim(`\n[session closed: ${ev.reason}]`);
  }
}

/** Yield input lines from stdin, one at a time. Ends when stdin closes (EOF). */
async function* iterStdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Deno.stdin.readable) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      yield line;
    }
  }
  // Flush any trailing line without a newline.
  buf += decoder.decode();
  if (buf.length > 0) yield buf.replace(/\r$/, "");
}

/** Run the agent in interactive (session) mode. Streams session events
 *  and reads further user messages from stdin between turns. */
async function runInteractive(
  agent: Agent,
  c: ReturnType<typeof makeColor>,
): Promise<number> {
  let session: AgentSession;
  try {
    session = await agent.openSession();
  } catch (e) {
    console.error(c.red("error opening session:"), (e as Error).message);
    console.error(
      c.dim("(hint: --interactive requires the factory to enable experimental.asyncWakeups)"),
    );
    return 1;
  }

  console.log(c.dim("(interactive mode — type /exit or Ctrl+D to quit)"));

  // Reader: forward stdin lines to session.send(); on EOF or /exit, close.
  const readerDone = (async () => {
    try {
      for await (const line of iterStdinLines()) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        if (trimmed === "/exit" || trimmed === "/quit") break;
        session.send({ kind: "user_message", content: line });
      }
    } catch (e) {
      console.error(c.red("stdin reader error:"), (e as Error).message);
    } finally {
      await session.close();
    }
  })();

  // Writer: drain session.events and pretty-print.
  let exitCode = 0;
  for await (const ev of session.events) {
    const out = renderAgentEvent(ev, c);
    if (out !== null) console.log(out);
    if (ev.kind === "abort") exitCode = 1;
  }

  await readerDone;
  return exitCode;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!args.agent) {
    console.error("error: --agent <path> is required\n");
    console.error(HELP);
    return 2;
  }
  if (!args.task) {
    console.error("error: task is required (after --, e.g. -- 'do the thing')\n");
    console.error(HELP);
    return 2;
  }

  const colorEnabled = args.color && Deno.stdout.isTerminal();
  const c = makeColor(colorEnabled);

  let factory: AgentFactory;
  try {
    factory = await loadFactory(args.agent);
  } catch (e) {
    console.error(c.red("error loading agent file:"), (e as Error).message);
    return 1;
  }

  const onStep = (step: StepRecord) => {
    console.log(renderStep(step, c));
  };

  console.log(c.bold(`rex ${args.session ? `(session ${args.session})` : "(ephemeral)"}`));
  console.log(c.dim(`task: ${args.task}`));

  let agent: Agent;
  try {
    agent = await factory({
      task: args.task,
      sessionId: args.session,
      onStep: args.interactive ? undefined : onStep,
      resumeHistory: !!args.session,
      asyncWakeups: args.interactive,
    });
  } catch (e) {
    console.error(c.red("error constructing agent:"), (e as Error).message);
    return 1;
  }

  // Optional: max-steps override. The factory already configured maxSteps,
  // but the CLI flag should win if specified. We can't change it after
  // construction, so we ask the factory to honor it instead — most factories
  // will already pass through the input. For now, just inform the user.
  if (typeof args.maxSteps === "number") {
    console.log(c.dim(`(--max-steps ${args.maxSteps} requires factory to honor it)`));
  }

  if (args.interactive) {
    return await runInteractive(agent, c);
  }

  let result;
  try {
    result = await agent.run();
  } catch (e) {
    console.error(c.red("error during run:"), (e as Error).message);
    return 1;
  }

  console.log("");
  switch (result.kind) {
    case "reply":
      console.log(c.green(c.bold("REPLY:")), result.message);
      return 0;
    case "abort":
      console.log(c.red(c.bold("ABORT:")), result.error);
      return 1;
    case "exhausted":
      console.log(
        c.yellow(c.bold("EXHAUSTED:")),
        `agent took ${result.steps} steps without terminating`,
      );
      return 1;
  }
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
