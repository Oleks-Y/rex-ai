// Regression gate — fails the workflow if accuracy on a baseline model
// drops more than `MAX_DROP_PCT` percentage points vs the last green run
// recorded in evals/runs/baseline.json.
//
// Baseline file format:
//   {
//     "l1": { "<modelDatedId>": { "accuracy": 0.73, "rex_ai_commit": "abc123", "ts": "..." } },
//     "l2": { "<modelDatedId>": { "accuracy": 0.81, ... } }
//   }
//
// Usage in CI:
//   deno run --allow-read --allow-write evals/regression_gate.ts --layer l1
//
// On `--update`, refresh the baseline from the latest run instead of
// gating. CI calls this on green main runs (separate workflow step).

import { join, resolve } from "@std/path";
import { ensureFile, walk } from "@std/fs";
import type { RunResultRow } from "./types.ts";

const MAX_DROP_PCT = 10;

interface Baseline {
  [layer: string]: Record<string, { accuracy: number; rex_ai_commit?: string; ts?: string }>;
}

interface Args {
  layer: "l1" | "l2";
  update: boolean;
  baseline: string;
  runsRoot: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    layer: "l1",
    update: false,
    baseline: resolve("evals/runs/baseline.json"),
    runsRoot: resolve("evals/runs"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const val = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
    const advance = eq >= 0 ? 0 : 1;
    switch (key) {
      case "--layer":
        out.layer = val as "l1" | "l2";
        i += advance;
        break;
      case "--update":
        out.update = true;
        break;
      case "--baseline":
        out.baseline = resolve(val);
        i += advance;
        break;
      case "--runs":
        out.runsRoot = resolve(val);
        i += advance;
        break;
    }
  }
  return out;
}

async function findLatestRun(runsRoot: string, layer: "l1" | "l2"): Promise<string | null> {
  const dirs: { path: string; mtime: number }[] = [];
  for await (const entry of walk(runsRoot, { maxDepth: 1, includeFiles: false })) {
    if (entry.path === runsRoot) continue;
    const isLayer2 = entry.path.endsWith("_l2");
    if (layer === "l2" && !isLayer2) continue;
    if (layer === "l1" && isLayer2) continue;
    try {
      const stat = await Deno.stat(entry.path);
      dirs.push({ path: entry.path, mtime: stat.mtime?.getTime() ?? 0 });
    } catch { /* */ }
  }
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => b.mtime - a.mtime);
  const candidate = join(dirs[0].path, "results.jsonl");
  try {
    await Deno.stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

async function readJsonl(path: string): Promise<RunResultRow[]> {
  const text = await Deno.readTextFile(path);
  const out: RunResultRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as RunResultRow);
    } catch { /* */ }
  }
  return out;
}

function aggregateAccuracy(rows: RunResultRow[]): Record<string, number> {
  const stats = new Map<string, { passed: number; total: number }>();
  for (const r of rows) {
    let s = stats.get(r.model);
    if (!s) {
      s = { passed: 0, total: 0 };
      stats.set(r.model, s);
    }
    s.total++;
    if (r.score === 1) s.passed++;
  }
  const out: Record<string, number> = {};
  for (const [m, { passed, total }] of stats) {
    out[m] = total === 0 ? 0 : passed / total;
  }
  return out;
}

async function readBaseline(path: string): Promise<Baseline> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Baseline;
  } catch {
    return {};
  }
}

async function writeBaseline(path: string, b: Baseline): Promise<void> {
  await ensureFile(path);
  await Deno.writeTextFile(path, JSON.stringify(b, null, 2) + "\n");
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  const latestPath = await findLatestRun(args.runsRoot, args.layer);
  if (!latestPath) {
    console.log(`[gate] no ${args.layer} run found — nothing to gate`);
    return 0;
  }
  const rows = await readJsonl(latestPath);
  const acc = aggregateAccuracy(rows);
  const baseline = await readBaseline(args.baseline);
  const layerBaseline = baseline[args.layer] ?? {};
  const commit = rows[0]?.rex_ai_commit ?? "unknown";

  if (args.update) {
    baseline[args.layer] = {};
    for (const [model, accuracy] of Object.entries(acc)) {
      baseline[args.layer][model] = {
        accuracy,
        rex_ai_commit: commit,
        ts: new Date().toISOString(),
      };
    }
    await writeBaseline(args.baseline, baseline);
    console.log(`[gate] updated baseline at ${args.baseline}`);
    return 0;
  }

  let failed = false;
  for (const [model, accuracy] of Object.entries(acc)) {
    const prev = layerBaseline[model]?.accuracy;
    if (prev === undefined) {
      console.log(
        `[gate] ${args.layer}/${model}: no baseline (acc=${(accuracy * 100).toFixed(1)}%) — skip`,
      );
      continue;
    }
    const dropPct = (prev - accuracy) * 100;
    const ok = dropPct <= MAX_DROP_PCT;
    const tag = ok ? "OK" : "FAIL";
    console.log(
      `[gate ${tag}] ${args.layer}/${model}: ${(accuracy * 100).toFixed(1)}% (baseline ${
        (prev * 100).toFixed(1)
      }%, drop ${dropPct.toFixed(1)}pp / max ${MAX_DROP_PCT}pp)`,
    );
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
