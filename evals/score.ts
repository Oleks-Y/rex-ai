// Score / report — reads a results.jsonl and writes a markdown summary.
//
// Aggregates by (layer, model). Per-task table for L1; BFCL benchmark
// breakdown for L2. Tail of failures with judge rationales.

import { dirname, join, relative, resolve } from "@std/path";
import { ensureDir } from "@std/fs";
import type { RunResultRow } from "./types.ts";

interface Aggregate {
  layer: string;
  model: string;
  tasks: number;
  passed: number;
  costSum: number;
  tokensInSum: number;
  tokensOutSum: number;
  stepsSum: number;
  walls: number[];
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function fmtPct(num: number, den: number): string {
  return den === 0 ? "—" : `${Math.round((num / den) * 100)}%`;
}
function p50(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function readJsonl(path: string): Promise<RunResultRow[]> {
  const text = await Deno.readTextFile(path);
  const rows: RunResultRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as RunResultRow);
    } catch {
      // skip bad rows
    }
  }
  return rows;
}

function aggregate(rows: RunResultRow[]): Aggregate[] {
  const by = new Map<string, Aggregate>();
  for (const r of rows) {
    const key = `${r.layer}|${r.model}`;
    let a = by.get(key);
    if (!a) {
      a = {
        layer: r.layer,
        model: r.model,
        tasks: 0,
        passed: 0,
        costSum: 0,
        tokensInSum: 0,
        tokensOutSum: 0,
        stepsSum: 0,
        walls: [],
      };
      by.set(key, a);
    }
    a.tasks++;
    a.passed += r.score === 1 ? 1 : 0;
    a.costSum += r.cost_usd;
    a.tokensInSum += r.tokens_in;
    a.tokensOutSum += r.tokens_out;
    a.stepsSum += r.steps;
    a.walls.push(r.wall_ms);
  }
  return [...by.values()].sort((a, b) =>
    a.layer === b.layer ? a.model.localeCompare(b.model) : a.layer.localeCompare(b.layer)
  );
}

function headlineTable(aggs: Aggregate[]): string {
  const lines = [
    "| layer | model | tasks | accuracy | avg cost | avg tokens | avg steps | p50 wall |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const a of aggs) {
    lines.push(
      `| ${a.layer} | ${a.model} | ${a.tasks} | ${fmtPct(a.passed, a.tasks)} | ${
        fmtUsd(a.costSum / Math.max(1, a.tasks))
      } | ${Math.round((a.tokensInSum + a.tokensOutSum) / Math.max(1, a.tasks))} | ${
        (a.stepsSum / Math.max(1, a.tasks)).toFixed(1)
      } | ${p50(a.walls)}ms |`,
    );
  }
  return lines.join("\n");
}

function perTaskTable(rows: RunResultRow[]): string {
  const l1 = rows.filter((r) => r.layer === "l1");
  if (l1.length === 0) return "";
  const taskIds = [...new Set(l1.map((r) => r.task_id))].sort();
  const models = [...new Set(l1.map((r) => r.model))].sort();
  const head = ["task_id", ...models, "tags"];
  const lines = [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
  ];
  for (const id of taskIds) {
    const cells: string[] = [id];
    for (const m of models) {
      const row = l1.find((r) => r.task_id === id && r.model === m);
      cells.push(row ? String(row.score) : "—");
    }
    cells.push(""); // tags placeholder
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function bfclBreakdown(rows: RunResultRow[]): string {
  const l2 = rows.filter((r) => r.layer === "l2");
  if (l2.length === 0) return "";
  const benches = [...new Set(l2.map((r) => r.source))].sort();
  const models = [...new Set(l2.map((r) => r.model))].sort();
  const head = ["benchmark", ...models];
  const lines = [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
  ];
  for (const b of benches) {
    const cells: string[] = [b];
    for (const m of models) {
      const subset = l2.filter((r) => r.source === b && r.model === m);
      const passed = subset.filter((r) => r.score === 1).length;
      cells.push(fmtPct(passed, subset.length));
    }
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

function failuresSection(rows: RunResultRow[]): string {
  const fails = rows.filter((r) => r.score !== 1).slice(0, 10);
  if (fails.length === 0) return "_no failures_";
  const lines: string[] = [];
  for (const r of fails) {
    const tail = r.judge_rationale
      ? `judge: ${r.judge_rationale}`
      : r.error
      ? `error: ${r.error}`
      : `reply: ${r.reply.slice(0, 120)}`;
    lines.push(`- **${r.task_id}** / ${r.model} — ${tail}`);
  }
  return lines.join("\n");
}

export async function generateReport(jsonlPath: string, outPath: string): Promise<void> {
  const rows = await readJsonl(jsonlPath);
  const aggs = aggregate(rows);
  const runId = rows[0]?.run_id ?? "(empty)";
  const commit = rows[0]?.rex_ai_commit ?? "unknown";
  const ts = new Date().toISOString();
  const layers = [...new Set(rows.map((r) => r.layer))].sort().join(", ");

  const md = [
    `# Eval Report — ${ts}`,
    `**Run ID:** \`${runId.slice(0, 8)}\` | **Commit:** \`${commit}\` | **Layers:** ${layers}`,
    "",
    "## Headline",
    "",
    headlineTable(aggs),
    "",
    "## L1 Per-task",
    "",
    perTaskTable(rows) || "_no L1 rows_",
    "",
    "## L2 BFCL breakdown",
    "",
    bfclBreakdown(rows) || "_no L2 rows_",
    "",
    "## Failures (top 10)",
    "",
    failuresSection(rows),
    "",
  ].join("\n");

  await ensureDir(dirname(outPath));
  await Deno.writeTextFile(outPath, md);
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (!path) {
    console.error("usage: score.ts <results.jsonl> [out.md]");
    Deno.exit(2);
  }
  const out = Deno.args[1] ?? join(dirname(resolve(path)), "report.md");
  await generateReport(resolve(path), resolve(out));
  console.log(`wrote ${relative(Deno.cwd(), out)}`);
}
