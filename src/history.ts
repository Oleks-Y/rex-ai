// Conversation history exporter.
//
// Bundles a run's step records + metadata into a portable artifact that
// survives ephemeral-session cleanup. The CLI writes one of these to
// `.rex/history/<file>` at the end of every run by default.
//
// Why this exists, separately from `transcript.jsonl`:
//   - transcript.jsonl lives INSIDE the session dir and is deleted for
//     ephemeral runs (no `--session` flag).
//   - transcript.jsonl strips per-step logs (kept only in the in-memory
//     prompt-window between steps).
//   - transcript.jsonl has no run-level metadata: task, agent path,
//     terminal outcome, export timestamp.
//
// Builder is a pure function over `StepRecord[]` — the CLI accumulates
// them via the existing `onStep` / `session.events` hooks, so the export
// works identically for ephemeral and persistent sessions.

import { ensureDir } from "@std/fs";
import { join, resolve } from "@std/path";
import type { SandboxEvent, SandboxLog, StepRecord } from "./types.ts";

export const HISTORY_SCHEMA_VERSION = 1 as const;

export type HistoryTerminal =
  | { kind: "reply"; message: string }
  | { kind: "abort"; error: string }
  | { kind: "exhausted"; steps: number }
  | null;

export interface ConversationHistory {
  /** Schema version. Bump on breaking changes. */
  version: typeof HISTORY_SCHEMA_VERSION;
  sessionId: string;
  /** True when the on-disk session workspace was deleted at close
   *  (no `--session` flag on the CLI). Distinguishes archival history
   *  from a still-resumable session. */
  ephemeral: boolean;
  /** ISO-8601 timestamp the export was built. */
  exportedAt: string;
  /** The task the run started with. */
  task: string;
  /** Path to the factory file when invoked via CLI. */
  agentPath?: string;
  /** Every step seen during the run. Both `source: "resumed"` and
   *  `source: "fresh"` are kept so a replayed-resume's history is
   *  also complete. Logs ARE retained here (unlike transcript.jsonl)
   *  since this artifact is archival, not for resume. */
  steps: StepRecord[];
  /** Terminal outcome, when known. Null when the run was interrupted
   *  before producing one (e.g. interactive `/exit` without a reply). */
  terminal: HistoryTerminal;
}

export interface BuildHistoryOptions {
  sessionId: string;
  ephemeral: boolean;
  task: string;
  agentPath?: string;
  steps: StepRecord[];
  terminal: HistoryTerminal;
  /** Override the timestamp source for tests / deterministic output. */
  now?: () => Date;
}

/** Build a `ConversationHistory` from in-memory step records + metadata.
 *  Pure function — no I/O, no side effects. */
export function buildHistory(opts: BuildHistoryOptions): ConversationHistory {
  const now = opts.now ?? (() => new Date());
  return {
    version: HISTORY_SCHEMA_VERSION,
    sessionId: opts.sessionId,
    ephemeral: opts.ephemeral,
    exportedAt: now().toISOString(),
    task: opts.task,
    ...(opts.agentPath !== undefined ? { agentPath: opts.agentPath } : {}),
    steps: opts.steps,
    terminal: opts.terminal,
  };
}

/** Render a human-readable markdown summary of a `ConversationHistory`.
 *  Suitable for hand-off / quick review; the JSON form is the canonical
 *  reload-friendly format. */
export function renderHistoryMarkdown(h: ConversationHistory): string {
  const lines: string[] = [];
  lines.push(`# rex-ai run — ${h.sessionId}`);
  lines.push("");
  lines.push(`- **Task:** ${escapeInline(h.task)}`);
  if (h.agentPath) lines.push(`- **Agent:** \`${h.agentPath}\``);
  lines.push(`- **Exported:** ${h.exportedAt}`);
  lines.push(`- **Ephemeral:** ${h.ephemeral}`);
  lines.push(`- **Terminal:** ${renderTerminalInline(h.terminal)}`);
  lines.push(`- **Steps:** ${h.steps.length}`);
  lines.push("");

  for (const step of h.steps) {
    lines.push(`## Step ${step.index} (${step.source}, ${step.event.kind})`);
    lines.push("");
    lines.push("```ts");
    lines.push(step.code);
    lines.push("```");
    lines.push("");
    if (step.event.logs.length > 0) {
      lines.push("**Logs:**");
      lines.push("");
      for (const log of step.event.logs) {
        lines.push(`- \`[${log.level}]\` ${renderLogArgs(log)}`);
      }
      lines.push("");
    }
    lines.push(renderEventTail(step.event));
    lines.push("");
  }
  return lines.join("\n");
}

function renderTerminalInline(t: HistoryTerminal): string {
  if (t === null) return "—";
  switch (t.kind) {
    case "reply":
      return `REPLY · ${truncate(t.message, 200)}`;
    case "abort":
      return `ABORT · ${truncate(t.error, 200)}`;
    case "exhausted":
      return `EXHAUSTED · ${t.steps} steps`;
  }
}

function renderEventTail(ev: SandboxEvent): string {
  switch (ev.kind) {
    case "reply":
      return `**→ reply:** ${escapeInline(ev.message)}`;
    case "abort":
      return `**→ abort:** ${escapeInline(ev.error)}`;
    case "reflect":
      return `**→ reflect:** \`${escapeInline(safeJson(ev.state))}\``;
    case "permission_denied":
      return `**→ permission_denied:** \`${ev.permission}\` → \`${escapeInline(ev.target)}\``;
    case "throw":
      return `**→ threw:** ${escapeInline(ev.error)}`;
    case "guardrail_blocked":
      return `**→ blocked by \`${ev.guardrail}\` (was ${ev.originalKind}):** ${escapeInline(ev.reason)}`;
  }
}

function renderLogArgs(log: SandboxLog): string {
  return log.args
    .map((a) => (typeof a === "string" ? a : safeJson(a)))
    .map(escapeInline)
    .join(" ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Escape a value for safe inline-markdown rendering. Strips line breaks
 *  (so a multi-line log doesn't blow up a bullet) and pipes (which would
 *  break tables if a caller wraps this output in one). */
function escapeInline(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export interface WriteHistoryOptions {
  dir: string;
  /** Default `"json"`. */
  format?: "json" | "md" | "both";
  /** Override the file basename (no extension). Default is
   *  `<exportedAt-no-colons>-<sessionId>`. */
  baseName?: string;
}

export interface WriteHistoryResult {
  json?: string;
  md?: string;
}

/** Write a `ConversationHistory` to disk. Creates `dir` if missing.
 *  Returns the absolute path(s) written, keyed by format. */
export async function writeHistoryFile(
  history: ConversationHistory,
  opts: WriteHistoryOptions,
): Promise<WriteHistoryResult> {
  const format = opts.format ?? "json";
  const dir = resolve(opts.dir);
  await ensureDir(dir);
  const base = opts.baseName ?? defaultBaseName(history);
  const out: WriteHistoryResult = {};
  if (format === "json" || format === "both") {
    const path = join(dir, `${base}.json`);
    await Deno.writeTextFile(path, JSON.stringify(history, null, 2) + "\n");
    out.json = path;
  }
  if (format === "md" || format === "both") {
    const path = join(dir, `${base}.md`);
    await Deno.writeTextFile(path, renderHistoryMarkdown(history));
    out.md = path;
  }
  return out;
}

/** ISO-no-colons-or-dots timestamp + session id. Safe across filesystems
 *  (no `:` on Windows, no `.` confusion with extensions). */
function defaultBaseName(h: ConversationHistory): string {
  const stamp = h.exportedAt.replace(/[:.]/g, "-");
  return `${stamp}-${h.sessionId}`;
}
