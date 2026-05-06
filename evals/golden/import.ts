// Importer — refreshes evals/golden/*.yaml from upstream sources.
//
// Manual invocation:
//   HF_TOKEN=... deno run --allow-net --allow-read --allow-write \
//       evals/golden/import.ts [--source <name>]
//
// Each YAML's `source.url` declares where its tasks come from. This
// script knows how to pull from each. Re-runs replace the `tasks` array
// while preserving `source` / `agent` blocks.
//
// Status: STUB. Wires up the dispatch + per-source TODOs. The committed
// YAMLs already contain hand-curated tasks; rerun this script when you
// want to refresh from upstream.

import { parse, stringify } from "@std/yaml";
import { join, resolve } from "@std/path";
import type { TaskFile } from "../types.ts";

interface ImporterArgs {
  /** Comma-separated source names; default: all. */
  source?: string[];
  /** Just show what would change. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): ImporterArgs {
  const out: ImporterArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i].split(",");
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

const GOLDEN_DIR = resolve("evals/golden");

// ── per-source pullers ──────────────────────────────────────────────────

function pullSmolagentsGaia(): Promise<unknown[]> {
  const token = Deno.env.get("HF_TOKEN");
  if (!token) {
    console.warn("smolagents_gaia: HF_TOKEN unset — keeping existing YAML");
    return Promise.resolve([]);
  }
  // TODO: pull from https://huggingface.co/datasets/smolagents/benchmark-v1
  // (config: gaia, split: validation, level: 1). HF parquet via
  // @huggingface/hub or direct REST. Filter to tasks with no attached files.
  console.warn("smolagents_gaia: pull not yet implemented — see TODO");
  return Promise.resolve([]);
}

function pullMathL1(): Promise<unknown[]> {
  // TODO: GitHub raw fetch of hendrycks/math train/algebra/level-1*.json.
  console.warn("math_l1: pull not yet implemented");
  return Promise.resolve([]);
}

function pullSimpleQa(): Promise<unknown[]> {
  // TODO: openai/simple-evals SimpleQA test set.
  console.warn("simpleqa: pull not yet implemented");
  return Promise.resolve([]);
}

function pullHumanEval(): Promise<unknown[]> {
  // TODO: github.com/openai/human-eval → HumanEval.jsonl.gz, problems 0/7/13.
  console.warn("humaneval: pull not yet implemented");
  return Promise.resolve([]);
}

const SOURCES: Record<string, () => Promise<unknown[]>> = {
  smolagents_gaia: pullSmolagentsGaia,
  math_l1: pullMathL1,
  simpleqa: pullSimpleQa,
  humaneval_easy: pullHumanEval,
};

// ── main ────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  const sources = args.source ?? Object.keys(SOURCES);
  for (const name of sources) {
    const puller = SOURCES[name];
    if (!puller) {
      console.error(`unknown source: ${name}`);
      continue;
    }
    const yamlPath = join(GOLDEN_DIR, `${name}.yaml`);
    let existing: TaskFile;
    try {
      existing = parse(await Deno.readTextFile(yamlPath)) as TaskFile;
    } catch {
      console.error(`could not read ${yamlPath} — skipping`);
      continue;
    }
    const fresh = await puller();
    if (fresh.length === 0) continue;
    const next: TaskFile = { ...existing, tasks: fresh as TaskFile["tasks"] };
    const out = stringify(next as unknown as Record<string, unknown>);
    if (args.dryRun) {
      console.log(`-- ${name} --\n${out}`);
    } else {
      await Deno.writeTextFile(yamlPath, out);
      console.log(`wrote ${yamlPath} (${fresh.length} tasks)`);
    }
  }
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
