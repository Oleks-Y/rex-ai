// L2 BFCL runner — drives `@ai-sdk-tool/eval` through the rex-ai harness.
//
// L2's job is to publish credible function-calling numbers for rex-ai
// itself, not for the underlying model. Every benchmark run is wrapped by
// `RexAiAdapter`: BFCL → AI SDK generateText → rex-ai Agent loop →
// recorded tool calls. There is no longer a "baseline" mode that hands
// BFCL the raw provider model — that measured the model alone, which is
// what BFCL upstream already publishes; running it ourselves gave us
// nothing rex-ai-specific to grade.
//
// Usage:
//   deno task eval:l2 --models gpt-5-nano
//   deno task eval:l2 --models gpt-5-nano,claude-haiku-4-5 --benchmarks simple,parallel
//   deno task eval:l2 --benchmarks all-single --max-steps 6

import { ensureDir } from "@std/fs";
import { dirname, fromFileUrl, join, relative, resolve } from "@std/path";
import {
  bfclMultipleBenchmark,
  bfclMultiTurnBaseBenchmark,
  bfclMultiTurnLongContextBenchmark,
  bfclMultiTurnMissFuncBenchmark,
  bfclMultiTurnMissParamBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
  evaluate,
  type LanguageModelV3Benchmark,
} from "npm:@ai-sdk-tool/eval@1";

import type { RunResultRow } from "../types.ts";
import { MODELS, resolveModel } from "../models.ts";
import { generateReport } from "../score.ts";
import { RexAiAdapter } from "./adapter.ts";

interface CliArgs {
  models: string[];
  benchmarks: string[];
  outDir: string;
  maxSteps: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    models: ["gpt-5-nano"],
    benchmarks: ["simple", "parallel"],
    outDir: resolve("evals/runs"),
    maxSteps: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const val = eq >= 0 ? a.slice(eq + 1) : argv[i + 1];
    const advance = eq >= 0 ? 0 : 1;
    switch (key) {
      case "--models":
        out.models = val.split(",").map((s) => s.trim()).filter(Boolean);
        i += advance;
        break;
      case "--benchmarks":
        out.benchmarks = val.split(",").map((s) => s.trim()).filter(Boolean);
        i += advance;
        break;
      case "--out-dir":
        out.outDir = resolve(val);
        i += advance;
        break;
      case "--max-steps":
        out.maxSteps = Number(val);
        i += advance;
        break;
      case "-h":
      case "--help":
        printHelp();
        Deno.exit(0);
        break;
    }
  }
  return out;
}

function printHelp(): void {
  const known = Object.keys(MODELS).join(", ");
  console.log(`rex-ai BFCL (L2) runner

Drives @ai-sdk-tool/eval BFCL benchmarks through the rex-ai code-action
loop. Each turn is one call into the rex-ai Agent; recorded tool calls
are surfaced back to BFCL for grading.

Flags:
  --models a,b,c           Comma-separated model aliases. Default: gpt-5-nano.
  --benchmarks a,b,c       Default: simple,parallel.
                           Single-turn:   simple, parallel, multiple, parallel-multiple
                           Multi-turn:    multi-turn-base, multi-turn-long-context,
                                          multi-turn-miss-func, multi-turn-miss-param
                           Shorthand:     all-single, all-multi-turn, all
  --out-dir <path>         Where to write runs. Default evals/runs.
  --max-steps <n>          Hard cap on rex-ai loop iterations per BFCL turn. Default 4.

Known models: ${known}`);
}

const BENCHMARKS: Record<string, LanguageModelV3Benchmark> = {
  simple: bfclSimpleBenchmark,
  parallel: bfclParallelBenchmark,
  multiple: bfclMultipleBenchmark,
  "parallel-multiple": bfclParallelMultipleBenchmark,
  "multi-turn-base": bfclMultiTurnBaseBenchmark,
  "multi-turn-long-context": bfclMultiTurnLongContextBenchmark,
  "multi-turn-miss-func": bfclMultiTurnMissFuncBenchmark,
  "multi-turn-miss-param": bfclMultiTurnMissParamBenchmark,
};

const SHORTHANDS: Record<string, string[]> = {
  "all-single": ["simple", "parallel", "multiple", "parallel-multiple"],
  "all-multi-turn": [
    "multi-turn-base",
    "multi-turn-long-context",
    "multi-turn-miss-func",
    "multi-turn-miss-param",
  ],
  all: [
    "simple",
    "parallel",
    "multiple",
    "parallel-multiple",
    "multi-turn-base",
    "multi-turn-long-context",
    "multi-turn-miss-func",
    "multi-turn-miss-param",
  ],
};

function expandShorthands(names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const expanded = SHORTHANDS[n] ?? [n];
    for (const e of expanded) {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
  }
  return out;
}

/** `@ai-sdk-tool/eval` ships the BFCL JSONLs inside its npm package, but its
 *  Node-style data-dir resolver (`createRequire`, package.json traversal)
 *  doesn't fire under Deno — it falls back to `<cwd>/../../data`, which on a
 *  typical clone is `/Users/<you>/data`. We resolve the package's bundled
 *  `data/` ourselves and feed it via the documented `BFCL_DATA_DIR` env. */
async function ensureBfclDataDir(): Promise<string> {
  const override = Deno.env.get("BFCL_DATA_DIR");
  if (override && override.trim().length > 0) {
    return override;
  }
  const entryUrl = import.meta.resolve("npm:@ai-sdk-tool/eval@1");
  const entryPath = fromFileUrl(entryUrl);
  const dataDir = join(dirname(dirname(entryPath)), "data");
  try {
    await Deno.stat(join(dataDir, "BFCL_v4_simple.jsonl"));
  } catch {
    throw new Error(
      `bfcl: bundled data not found at ${dataDir}. Set BFCL_DATA_DIR to a directory containing BFCL_v4_*.jsonl files.`,
    );
  }
  Deno.env.set("BFCL_DATA_DIR", dataDir);
  return dataDir;
}

async function gitCommit(): Promise<string> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      stdout: "piped",
    });
    const { stdout } = await cmd.output();
    return new TextDecoder().decode(stdout).trim();
  } catch {
    return "unknown";
  }
}

function freshRunDir(outDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const id = crypto.randomUUID().slice(0, 8);
  return join(outDir, `${ts}_${id}_l2`);
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  const dataDir = await ensureBfclDataDir();
  console.log(`[bfcl] data → ${relative(Deno.cwd(), dataDir) || dataDir}`);
  const runDir = freshRunDir(args.outDir);
  await ensureDir(runDir);
  const jsonlPath = join(runDir, "results.jsonl");
  const reportPath = join(runDir, "report.md");
  const runId = crypto.randomUUID();
  const rexAiCommit = await gitCommit();

  const expanded = expandShorthands(args.benchmarks);
  const benchmarks: LanguageModelV3Benchmark[] = [];
  for (const b of expanded) {
    const bench = BENCHMARKS[b];
    if (!bench) {
      throw new Error(
        `unknown benchmark "${b}". Known: ${Object.keys(BENCHMARKS).join(", ")}. Shorthands: ${
          Object.keys(SHORTHANDS).join(", ")
        }`,
      );
    }
    benchmarks.push(bench);
  }

  // Each alias becomes a rex-ai-wrapped model. EvaluationResult.modelKey
  // surfaces the alias, so the JSONL row records `rex-ai+<alias>`.
  // deno-lint-ignore no-explicit-any
  const models: Record<string, any> = {};
  for (const alias of args.models) {
    const { entry, model } = resolveModel(alias);
    const adapter = new RexAiAdapter({
      innerModel: model,
      providerLabel: `rex-ai+${entry.provider}`,
      modelId: entry.id,
      maxSteps: args.maxSteps,
    });
    models[`rex-ai+${alias}`] = adapter;
  }

  console.log(
    `[bfcl] run_id=${runId.slice(0, 8)} commit=${rexAiCommit} models=${
      Object.keys(models).join(",")
    } benchmarks=${expanded.join(",")} maxSteps=${args.maxSteps}`,
  );
  console.log(`[bfcl] out → ${relative(Deno.cwd(), jsonlPath)}`);

  const results = await evaluate({
    models,
    benchmarks,
    reporter: "console.summary",
  });

  const writer = await Deno.open(jsonlPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const enc = new TextEncoder();
  for (const r of results) {
    const key = r.modelKey ?? r.model;
    const alias = key.startsWith("rex-ai+") ? key.slice("rex-ai+".length) : key;
    const recordedModel = MODELS[alias]?.id ?? r.model;
    const score = r.result.success ? 1 : 0;
    const row: RunResultRow = {
      run_id: runId,
      layer: "l2",
      source: r.benchmark,
      task_id: `${r.benchmark}-aggregate`,
      seed: 0,
      model: recordedModel,
      agent: "rex-ai",
      score,
      grader_type: "bfcl",
      reply: "",
      trajectory: [],
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      steps: 0,
      wall_ms: 0,
      finish_reason: r.result.error ? "error" : "reply",
      error: r.result.error?.message,
      rex_ai_commit: rexAiCommit,
      ts: new Date().toISOString(),
    };
    await writer.write(enc.encode(JSON.stringify(row) + "\n"));
  }
  writer.close();

  await generateReport(jsonlPath, reportPath);
  console.log(`[bfcl] report → ${relative(Deno.cwd(), reportPath)}`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
