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
//     [--no-color] [--verbose] \
//     -- <task...>
//
// Usage (interactive):
//   deno run -A src/cli.ts --interactive \
//     --agent <path-to-agent.ts> \
//     [--session <id>] [--no-color] [--verbose] \
//     -- <initial task...>
//
// The --agent file must `export default` a factory:
//
//   export default function (input: AgentFactoryInput): Agent { ... }
//
//   where AgentFactoryInput is { task, sessionId?, onStep?, onPhase?,
//   resumeHistory?, asyncWakeups? } and the returned Agent already has
//   model / permissions / tools wired.

import { resolve, toFileUrl } from "@std/path";
import type { Agent } from "./agent.ts";
import type {
  AgentEvent,
  AgentPhase,
  AgentSession,
  StepRecord,
  WakeupKind,
  WakeupResolvedPayload,
} from "./types.ts";
import {
  buildHistory,
  type HistoryTerminal,
  writeHistoryFile,
} from "./history.ts";

export interface AgentFactoryInput {
  task: string;
  sessionId?: string;
  onStep?: (step: StepRecord) => void | Promise<void>;
  /** Called before each phase of a fresh step (`generating` then
   *  `running`). The CLI uses this to drive a spinner; factories should
   *  forward it to `new Agent({ onPhase })`. */
  onPhase?: (phase: AgentPhase, stepIndex: number) => void;
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

export type Color = ReturnType<typeof makeColor>;

// ── truncation caps ───────────────────────────────────────────────────────

/** Per-step rendering caps. `verbose` mode disables every limit. */
export interface RenderCaps {
  /** Max characters per console.log argument. */
  logArg: number;
  /** Max log lines emitted per step (extras collapse to "+K more"). */
  logsPerStep: number;
  /** Max code-block lines before the rest is hidden behind "(+M more)". */
  codeLines: number;
  /** Max characters for reflect.state JSON. */
  state: number;
  /** Max characters for throw.error. */
  throwError: number;
}

export const DEFAULT_CAPS: RenderCaps = {
  logArg: 200,
  logsPerStep: 10,
  codeLines: 20,
  state: 500,
  throwError: 800,
};

export const VERBOSE_CAPS: RenderCaps = {
  logArg: Infinity,
  logsPerStep: Infinity,
  codeLines: Infinity,
  state: Infinity,
  throwError: Infinity,
};

/** Truncate a string to `n` characters, appending a count of hidden chars. */
export function truncStr(s: string, n: number): string {
  if (s.length <= n || !isFinite(n)) return s;
  const hidden = s.length - n;
  return s.slice(0, n) + `…(+${hidden} chars)`;
}

/** Truncate a multi-line block to `n` lines, returning the kept text and a
 *  count of hidden lines (0 when nothing was dropped). */
export function truncLines(s: string, n: number): { text: string; hidden: number } {
  if (!isFinite(n)) return { text: s, hidden: 0 };
  const lines = s.split("\n");
  if (lines.length <= n) return { text: s, hidden: 0 };
  return { text: lines.slice(0, n).join("\n"), hidden: lines.length - n };
}

// ── arg parsing (tiny — no @std dep) ──────────────────────────────────────

export type HistoryFormat = "json" | "md" | "both";

export interface ParsedArgs {
  agent?: string;
  session?: string;
  maxSteps?: number;
  color: boolean;
  verbose: boolean;
  help: boolean;
  interactive: boolean;
  task: string;
  /** Whether to write a history archive at end of run. Default true;
   *  flipped off by `--no-save-history`. */
  saveHistory: boolean;
  /** Directory for history files. Default `.rex/history`. */
  historyDir: string;
  /** Output format. Default `json`. */
  historyFormat: HistoryFormat;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    color: true,
    verbose: false,
    help: false,
    interactive: false,
    task: "",
    saveHistory: true,
    historyDir: ".rex/history",
    historyFormat: "json",
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
    if (a === "-v" || a === "--verbose") {
      out.verbose = true;
      i++;
      continue;
    }
    if (a === "-i" || a === "--interactive") {
      out.interactive = true;
      i++;
      continue;
    }
    if (a === "--no-save-history") {
      out.saveHistory = false;
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
      case "--history-dir":
        out.historyDir = val;
        i += advance;
        continue;
      case "--history-format": {
        if (val !== "json" && val !== "md" && val !== "both") {
          throw new Error(
            `--history-format must be json|md|both (got: ${val})`,
          );
        }
        out.historyFormat = val;
        i += advance;
        continue;
      }
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
  deno run -A src/cli.ts --agent <path> [--session <id>] [--max-steps <n>] [--no-color] [--verbose] -- <task...>
  deno run -A src/cli.ts --interactive --agent <path> [--session <id>] [--no-color] [--verbose] -- <initial task...>

Options:
  -a, --agent <path>       Required. Path to a .ts file with a default-exported
                           Agent factory (input: { task, sessionId, onStep,
                           onPhase, resumeHistory, asyncWakeups }) => Agent.
  -s, --session <id>       Persistent session id. Reusing the id continues
                           the prior conversation (lib + storage + transcript).
  -i, --interactive        Open a long-lived AgentSession (experimental
                           async-wakeups). Reads further user messages from
                           stdin between turns. Type "/exit" or send EOF
                           (Ctrl+D) to close.
      --max-steps <n>      Override the agent's maxSteps. (One-shot only.)
      --no-color           Disable ANSI colors and the live spinner.
      --no-save-history    Disable the automatic per-run history archive.
      --history-dir <path> Directory for history archives. Default: .rex/history
      --history-format <f> json | md | both. Default: json
  -v, --verbose            Disable log / code / state truncation.
  -h, --help               Show this help.

Notes:
  - The CLI never instantiates an Agent directly. It imports the factory
    so the model / permissions / tools live with the agent definition.
  - Per-resume transcript lives in .rex/sessions/<id>/transcript.jsonl.
  - Per-run history archive lives in .rex/history/<file>. Saved by default
    for both ephemeral and persistent sessions; opt out with --no-save-history.
  - Reusing --session replays the session's transcript as prior steps.
  - In --interactive mode the CLI passes asyncWakeups: true to the factory.
    The factory must forward it to \`new Agent({ experimental: { asyncWakeups } })\`.
`;

// ── render helpers ────────────────────────────────────────────────────────

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Format a single sandbox log line. */
function renderLog(
  log: { level: "log" | "info" | "warn" | "error" | "debug"; args: unknown[] },
  c: Color,
  caps: RenderCaps,
): string {
  const lvlColor = log.level === "error"
    ? c.red
    : log.level === "warn"
    ? c.yellow
    : c.grey;
  const args = log.args
    .map((a) => typeof a === "string" ? a : safeJson(a))
    .map((s) => truncStr(s, caps.logArg))
    .join(" ");
  return `    ${lvlColor(`[${log.level}]`)} ${c.dim(args)}`;
}

/** Compact, indented step renderer. One-line header + body indented 4ch
 *  (no horizontal divider, no fence markers). */
export function renderStep(
  step: StepRecord,
  c: Color,
  caps: RenderCaps = DEFAULT_CAPS,
  /** Wall-clock ms between onPhase("generating") and this onStep. Omit
   *  if the caller didn't measure it. */
  durationMs?: number,
): string {
  const lines: string[] = [];

  // ── header ──
  const codeLines = step.code.split("\n").length;
  const logCount = step.event.logs?.length ?? 0;
  const kindIcon = step.source === "resumed" ? c.dim("↺") : c.bold("▶");
  const meta: string[] = [c.grey(step.event.kind)];
  if (typeof durationMs === "number") meta.push(c.grey(`${(durationMs / 1000).toFixed(1)}s`));
  meta.push(c.grey(`${codeLines}L`));
  if (logCount > 0) meta.push(c.grey(`${logCount} log${logCount === 1 ? "" : "s"}`));
  lines.push("");
  lines.push(
    `${kindIcon} ${c.bold(`Step ${step.index}`)} ${c.dim("·")} ${meta.join(c.dim(" · "))}`,
  );

  // ── code body ──
  const { text: codeText, hidden: codeHidden } = truncLines(step.code, caps.codeLines);
  for (const ln of codeText.split("\n")) lines.push(`    ${c.cyan(ln)}`);
  if (codeHidden > 0) {
    lines.push(`    ${c.dim(`(+${codeHidden} more line${codeHidden === 1 ? "" : "s"})`)}`);
  }

  // ── logs ──
  if (step.event.logs && step.event.logs.length > 0) {
    const visibleLogs = isFinite(caps.logsPerStep)
      ? step.event.logs.slice(0, caps.logsPerStep)
      : step.event.logs;
    const hiddenLogs = step.event.logs.length - visibleLogs.length;
    for (const log of visibleLogs) lines.push(renderLog(log, c, caps));
    if (hiddenLogs > 0) {
      lines.push(`    ${c.dim(`(+${hiddenLogs} more log${hiddenLogs === 1 ? "" : "s"})`)}`);
    }
  }

  // ── per-event tail ──
  switch (step.event.kind) {
    case "reply":
      lines.push(`    ${c.green("→ reply:")} ${step.event.message}`);
      break;
    case "abort":
      lines.push(`    ${c.red("→ abort:")} ${step.event.error}`);
      break;
    case "reflect": {
      const json = safeJson(step.event.state);
      lines.push(`    ${c.magenta("→ reflect:")} ${c.dim(truncStr(json, caps.state))}`);
      break;
    }
    case "permission_denied":
      lines.push(
        `    ${c.yellow("→ permission_denied:")} ${step.event.permission} → ${step.event.target}`,
      );
      break;
    case "throw":
      lines.push(`    ${c.red("→ threw:")} ${truncStr(step.event.error, caps.throwError)}`);
      break;
    case "guardrail_blocked":
      lines.push(
        `    ${c.yellow("→ blocked:")} ${c.bold(step.event.guardrail)} ${
          c.dim(`(was ${step.event.originalKind})`)
        } ${c.dim("—")} ${truncStr(step.event.reason, caps.throwError)}`,
      );
      break;
  }
  return lines.join("\n");
}

/** Render an AgentEvent (interactive mode). The `step` kind is rendered
 *  via the existing one-shot `renderStep` so output matches between modes.
 *
 *  Pass `tracker` to enrich wakeup events with elapsed time, fire count,
 *  and the interval period — without a tracker the renderer falls back to
 *  what's on the event itself. */
export function renderAgentEvent(
  ev: AgentEvent,
  c: Color,
  caps: RenderCaps = DEFAULT_CAPS,
  durationMs?: number,
  tracker?: WakeupTracker,
): string | null {
  switch (ev.kind) {
    case "step":
      return renderStep(
        { index: ev.index, source: ev.source, code: ev.code, event: ev.event },
        c,
        caps,
        durationMs,
      );
    case "reply":
      return `\n${c.green(c.bold("REPLY"))} ${c.dim(`(turn ${ev.turn}, ${ev.cause})`)} ${ev.message}`;
    case "abort":
      return `\n${c.red(c.bold("ABORT"))} ${c.dim(`(turn ${ev.turn}, ${ev.cause})`)} ${ev.error}`;
    case "exhausted":
      return `\n${c.yellow(c.bold("EXHAUSTED"))} ${c.dim(`(turn ${ev.turn}, ${ev.cause})`)} ${ev.steps} steps`;
    case "wakeup_scheduled": {
      const period = formatWakeupPeriod(ev.wakeupKind, ev.delayMs);
      const meta = period ? `${ev.wakeupKind}, ${period}` : ev.wakeupKind;
      return `${c.magenta("⏲")} ${c.bold("scheduled")} ${c.bold(ev.id)} ${
        c.dim(`(${meta})`)
      } ${c.dim("—")} ${ev.reason}`;
    }
    case "wakeup_resolved":
      return renderWakeupResolved(ev, c, caps, tracker);
    case "wakeup_rejected": {
      const elapsed = tracker?.elapsedSinceScheduled(ev.id);
      const tail = elapsed !== undefined ? c.dim(` · after ${formatDuration(elapsed)}`) : "";
      return `${c.red("✗")} ${c.bold("rejected")} ${c.bold(ev.id)}${tail}${c.dim(":")} ${ev.error}`;
    }
    case "wakeup_cancelled": {
      const elapsed = tracker?.elapsedSinceScheduled(ev.id);
      const tail = elapsed !== undefined ? c.dim(` · after ${formatDuration(elapsed)}`) : "";
      return `${c.yellow("⊘")} ${c.bold("cancelled")} ${c.bold(ev.id)}${tail}${c.dim(":")} ${ev.reason}`;
    }
    case "session_closed":
      return c.dim(`\n[session closed: ${ev.reason}]`);
  }
}

function renderWakeupResolved(
  ev: Extract<AgentEvent, { kind: "wakeup_resolved" }>,
  c: Color,
  caps: RenderCaps,
  tracker: WakeupTracker | undefined,
): string {
  const meta = tracker?.getMeta(ev.id);
  const elapsedMs = meta ? Date.now() - meta.scheduledAt : undefined;

  // Header — make it visually distinct so the user can scan "what fired"
  // at a glance. For intervals include the fire count + period; for one-
  // shots include the elapsed delay.
  let header: string;
  if (meta?.kind === "interval" && meta.delayMs !== undefined) {
    const after = elapsedMs !== undefined ? formatDuration(elapsedMs) : "?";
    header = `${c.magenta("⏰")} ${c.bold(ev.id)} ${
      c.dim(`(interval, every ${formatDuration(meta.delayMs)})`)
    } ${c.green("fired")} ${c.dim(`#${meta.fireCount} · +${after}`)}`;
  } else {
    const kindLabel = meta?.kind ?? "wakeup";
    const after = elapsedMs !== undefined ? `after ${formatDuration(elapsedMs)}` : "fired";
    const tail = elapsedMs !== undefined ? c.dim(` · ${after}`) : "";
    header = `${c.magenta("⏰")} ${c.bold(ev.id)} ${c.dim(`(${kindLabel})`)} ${c.green("fired")}${tail}`;
  }

  const body = renderWakeupPayload(ev.payload, c, caps);
  if (body.length === 0) {
    // No control-fn call inside the callback. Make it explicit so the
    // user understands why this didn't wake the agent for a new turn.
    return `${header} ${c.dim("(silent — no reflect / reply / abort)")}`;
  }
  return [header, ...body].join("\n");
}

/** Format the payload a timer callback surfaced (reflect state or
 *  translated reply/abort). Returns 0–2 lines indented to match the
 *  step renderer's body column. */
function renderWakeupPayload(
  payload: WakeupResolvedPayload | undefined,
  c: Color,
  caps: RenderCaps,
): string[] {
  if (!payload) return [];
  const lines: string[] = [];
  if (payload.intent) {
    const verb = payload.intent.kind === "reply" ? "would reply" : "would abort";
    const tint = payload.intent.kind === "reply" ? c.green : c.red;
    lines.push(`    ${tint(`→ ${verb}:`)} ${truncStr(payload.intent.text, caps.state)}`);
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, "state")) {
    lines.push(
      `    ${c.magenta("→ state:")} ${c.dim(truncStr(safeJson(payload.state), caps.state))}`,
    );
  }
  return lines;
}

/** Format a configured delay for the wakeup_scheduled banner. */
function formatWakeupPeriod(kind: WakeupKind, delayMs: number | undefined): string {
  if (kind === "promise") return "awaiting promise";
  if (delayMs === undefined) return "";
  if (kind === "interval") return `every ${formatDuration(delayMs)}`;
  return `in ${formatDuration(delayMs)}`;
}

/** Render a wall-clock millisecond count with one of three units. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// ── live status line (spinner + wakeup footer share one line) ─────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Shared single-line live status on stderr. The spinner (during a turn)
 *  and the wakeup footer (between turns) share this slot — only one is
 *  visible at a time. Becomes a no-op when stderr is not a TTY or when
 *  the user passed `--no-color`. */
export class StatusLine {
  readonly #enabled: boolean;
  #frame = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #current: string | null = null;
  #shown = "";

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  /** Replace whatever is on the line with `text`. Pass null to clear. */
  set(text: string | null): void {
    if (!this.#enabled) return;
    this.#current = text;
    this.#paint(text ?? "");
  }

  /** Begin a 100ms-tick spinner with a label that may include a {f}
   *  placeholder for the animated frame and {t} for elapsed seconds. */
  spin(label: (frame: string, elapsedMs: number) => string): void {
    if (!this.#enabled) return;
    const start = Date.now();
    const tick = () => {
      this.#frame = (this.#frame + 1) % SPINNER_FRAMES.length;
      this.#paint(label(SPINNER_FRAMES[this.#frame], Date.now() - start));
    };
    this.stopSpin();
    tick();
    this.#timer = setInterval(tick, 100);
  }

  /** Stop the spinner without clearing. Use `set(null)` to also clear. */
  stopSpin(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Clear the line entirely. */
  clear(): void {
    this.stopSpin();
    if (!this.#enabled) return;
    this.#paint("");
    this.#current = null;
  }

  #paint(text: string): void {
    // CR + CSI EL ("erase to end of line") + new text. Avoids leftover
    // characters when text shrinks without tracking the previous width.
    Deno.stderr.writeSync(new TextEncoder().encode(`\r\x1b[K${text}`));
    this.#shown = text;
  }
}

/** Strip ANSI escape sequences for width measurement. */
function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── wakeup tracker ────────────────────────────────────────────────────────

/** Live metadata for a wakeup. Retained for the lifetime of the session
 *  (entries are not deleted on resolve/reject/cancel) so resolved events
 *  can be rendered with their scheduled-time context. */
export interface WakeupMeta {
  kind: WakeupKind;
  reason: string;
  /** Configured period: setInterval period, setTimeout delay, or
   *  undefined for `reflect(promise)`. */
  delayMs?: number;
  /** Wall-clock ms when the scheduled event was applied. Used to
   *  compute "fired after X". */
  scheduledAt: number;
  /** Number of `wakeup_resolved` events seen for this id. Stays at 0
   *  for silent timeouts that never fire; bumps on every interval tick. */
  fireCount: number;
  status: "pending" | "resolved" | "rejected" | "cancelled";
}

/** Tracks wakeups in interactive mode so the CLI can render a pending
 *  footer AND so the per-event renderer can show "fired after Xs" or
 *  "fire #3 of interval every 30s". Entries persist past their terminal
 *  transition (status updated, not deleted), and are only cleared on
 *  `session_closed`. */
export class WakeupTracker {
  readonly #meta = new Map<string, WakeupMeta>();

  apply(ev: AgentEvent): void {
    switch (ev.kind) {
      case "wakeup_scheduled":
        this.#meta.set(ev.id, {
          kind: ev.wakeupKind,
          reason: ev.reason,
          delayMs: ev.delayMs,
          scheduledAt: Date.now(),
          fireCount: 0,
          status: "pending",
        });
        break;
      case "wakeup_resolved": {
        const m = this.#meta.get(ev.id);
        if (m) {
          m.fireCount++;
          // Intervals keep firing — only timeout / promise become "resolved".
          // The footer's "pending" filter relies on this so a live
          // interval is still counted as pending after each tick.
          if (m.kind !== "interval") m.status = "resolved";
        }
        break;
      }
      case "wakeup_rejected": {
        const m = this.#meta.get(ev.id);
        if (m) m.status = "rejected";
        break;
      }
      case "wakeup_cancelled": {
        const m = this.#meta.get(ev.id);
        if (m) m.status = "cancelled";
        break;
      }
      case "session_closed":
        this.#meta.clear();
        break;
    }
  }

  /** Look up an entry by id. The renderer reads this to attach elapsed
   *  time, fire count, and the configured period to a fire event. */
  getMeta(id: string): WakeupMeta | undefined {
    return this.#meta.get(id);
  }

  /** Convenience for renderers that just want a "fired after X" tail. */
  elapsedSinceScheduled(id: string): number | undefined {
    const m = this.#meta.get(id);
    return m ? Date.now() - m.scheduledAt : undefined;
  }

  /** Return the footer text, or null when nothing is pending. Truncates
   *  to `maxWidth` visible characters with a "+N more" tail. */
  render(c: Color, maxWidth: number): string | null {
    const pending = [...this.#meta.values()].filter((m) => m.status === "pending");
    if (pending.length === 0) return null;
    const names = pending.map((w) => w.reason);
    const head = c.magenta(`⏲ ${pending.length} pending`);
    let body = "";
    let shown = 0;
    for (let i = 0; i < names.length; i++) {
      const next = (i === 0 ? " · " : " · ") + names[i];
      if (stripAnsi(head).length + body.length + next.length > maxWidth - 12) break;
      body += next;
      shown++;
    }
    const hidden = names.length - shown;
    const tail = hidden > 0 ? c.dim(` · +${hidden} more`) : "";
    return head + c.dim(body) + tail;
  }

  /** Count of currently-pending wakeups. Exposed for tests + footer logic. */
  size(): number {
    let n = 0;
    for (const m of this.#meta.values()) if (m.status === "pending") n++;
    return n;
  }
}

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
  c: Color,
  caps: RenderCaps,
  status: StatusLine,
  phaseTimer: { stepStart: Map<number, number> },
  hooks: {
    onStep: (step: StepRecord) => void;
    onTerminal: (t: HistoryTerminal) => void;
  },
): Promise<number> {
  let session: AgentSession;
  try {
    session = await agent.openSession();
  } catch (e) {
    status.clear();
    console.error(c.red("error opening session:"), (e as Error).message);
    console.error(
      c.dim("(hint: --interactive requires the factory to enable experimental.asyncWakeups)"),
    );
    return 1;
  }

  const tracker = new WakeupTracker();
  const repaintFooter = () => {
    const width = Math.max(40, terminalCols() ?? 80);
    const text = tracker.render(c, width);
    status.set(text);
  };

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
    if (ev.kind === "step") {
      hooks.onStep({
        index: ev.index,
        source: ev.source,
        code: ev.code,
        event: ev.event,
      });
      const start = phaseTimer.stepStart.get(ev.index);
      const dur = start !== undefined ? Date.now() - start : undefined;
      phaseTimer.stepStart.delete(ev.index);
      status.clear();
      const out = renderAgentEvent(ev, c, caps, dur, tracker);
      if (out !== null) console.log(out);
      repaintFooter();
      continue;
    }
    // Apply BEFORE rendering so resolved/rejected events see the bumped
    // fireCount and updated status. Meta is retained either way so
    // elapsed-since-scheduled stays available.
    tracker.apply(ev);
    status.clear();
    const out = renderAgentEvent(ev, c, caps, undefined, tracker);
    if (out !== null) console.log(out);
    repaintFooter();
    if (ev.kind === "reply") {
      hooks.onTerminal({ kind: "reply", message: ev.message });
    } else if (ev.kind === "abort") {
      hooks.onTerminal({ kind: "abort", error: ev.error });
      exitCode = 1;
    } else if (ev.kind === "exhausted") {
      hooks.onTerminal({ kind: "exhausted", steps: ev.steps });
    }
  }

  status.clear();
  await readerDone;
  return exitCode;
}

function terminalCols(): number | null {
  try {
    return Deno.consoleSize().columns;
  } catch {
    return null;
  }
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
  const caps = args.verbose ? VERBOSE_CAPS : DEFAULT_CAPS;
  const status = new StatusLine(colorEnabled && Deno.stderr.isTerminal());

  let factory: AgentFactory;
  try {
    factory = await loadFactory(args.agent);
  } catch (e) {
    console.error(c.red("error loading agent file:"), (e as Error).message);
    return 1;
  }

  // Per-step timing: started on onPhase("generating"), consumed on onStep.
  const phaseTimer = { stepStart: new Map<number, number>() };

  const onPhase = (phase: AgentPhase, stepIndex: number) => {
    if (phase === "generating") {
      phaseTimer.stepStart.set(stepIndex, Date.now());
      status.spin((f, t) =>
        `${c.cyan(f)} ${c.dim(`generating step ${stepIndex} (${(t / 1000).toFixed(1)}s)`)}`
      );
    } else {
      status.spin((f, t) =>
        `${c.cyan(f)} ${c.dim(`running step ${stepIndex} (${(t / 1000).toFixed(1)}s)`)}`
      );
    }
  };

  // Accumulators for the history archive. The CLI captures every step
  // (one-shot via onStep, interactive via session.events) plus the
  // terminal outcome, then writes a single ConversationHistory file at
  // end of run.
  const accumulatedSteps: StepRecord[] = [];
  let accumulatedTerminal: HistoryTerminal = null;
  const recordStep = (step: StepRecord) => {
    accumulatedSteps.push(step);
  };
  const recordTerminal = (t: HistoryTerminal) => {
    accumulatedTerminal = t;
  };

  const onStep = (step: StepRecord) => {
    recordStep(step);
    const start = phaseTimer.stepStart.get(step.index);
    const dur = start !== undefined ? Date.now() - start : undefined;
    phaseTimer.stepStart.delete(step.index);
    status.clear();
    console.log(renderStep(step, c, caps, dur));
  };

  console.log(c.bold(`rex ${args.session ? `(session ${args.session})` : "(ephemeral)"}`));
  console.log(c.dim(`task: ${args.task}`));

  let agent: Agent;
  try {
    agent = await factory({
      task: args.task,
      sessionId: args.session,
      onStep: args.interactive ? undefined : onStep,
      onPhase,
      resumeHistory: !!args.session,
      asyncWakeups: args.interactive,
    });
  } catch (e) {
    status.clear();
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

  // Resolve the effective session id we'll stamp the history with. The
  // agent may use a generated ephemeral id under the hood; without
  // hooking the agent we surface "auto-<timestamp>" so the history file
  // still has a stable identifier.
  const effectiveSessionId = args.session ?? `auto-${stableTimestamp()}`;
  const ephemeral = args.session === undefined;

  const finalize = async (exitCode: number): Promise<number> => {
    if (!args.saveHistory) return exitCode;
    try {
      const history = buildHistory({
        sessionId: effectiveSessionId,
        ephemeral,
        task: args.task,
        agentPath: args.agent,
        steps: accumulatedSteps,
        terminal: accumulatedTerminal,
      });
      const written = await writeHistoryFile(history, {
        dir: args.historyDir,
        format: args.historyFormat,
      });
      const paths = [written.json, written.md].filter((p): p is string => !!p);
      for (const p of paths) {
        console.log(c.dim(`history written: ${p}`));
      }
    } catch (e) {
      console.error(c.red("history write failed:"), (e as Error).message);
    }
    return exitCode;
  };

  if (args.interactive) {
    const code = await runInteractive(agent, c, caps, status, phaseTimer, {
      onStep: recordStep,
      onTerminal: recordTerminal,
    });
    return await finalize(code);
  }

  let result;
  try {
    result = await agent.run();
  } catch (e) {
    status.clear();
    console.error(c.red("error during run:"), (e as Error).message);
    return await finalize(1);
  }

  status.clear();
  console.log("");
  switch (result.kind) {
    case "reply":
      recordTerminal({ kind: "reply", message: result.message });
      console.log(c.green(c.bold("REPLY:")), result.message);
      return await finalize(0);
    case "abort":
      recordTerminal({ kind: "abort", error: result.error });
      console.log(c.red(c.bold("ABORT:")), result.error);
      return await finalize(1);
    case "exhausted":
      recordTerminal({ kind: "exhausted", steps: result.steps });
      console.log(
        c.yellow(c.bold("EXHAUSTED:")),
        `agent took ${result.steps} steps without terminating`,
      );
      return await finalize(1);
  }
}

/** ISO timestamp with `:` and `.` removed — safe in file names on all
 *  platforms and stable across runs in the same wall-clock millisecond. */
function stableTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
