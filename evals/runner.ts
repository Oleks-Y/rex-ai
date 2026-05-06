// rex-ai L1 eval runner.
//
// Loads YAML task files, runs each (task × model × seed) tuple, grades
// the result, and writes a JSONL row per run to evals/runs/<id>/results.jsonl.
//
// Usage:
//   deno task eval:l1                                       # all files, default model
//   deno task eval:l1 --file evals/golden/math_l1.yaml      # one file
//   deno task eval:l1 --models gpt-5-nano,claude-haiku-4-5  # multiple models
//   deno task eval:l1 --limit 1                             # smoke test
//   deno task eval:l1 --seeds 3                             # variance
//   deno task eval:l1 --budget 2.00                         # USD cap

import { parse as parseYaml } from "@std/yaml";
import { ensureDir, walk } from "@std/fs";
import { join, relative, resolve } from "@std/path";

import type { RunResultRow, TaskFile } from "./types.ts";
import { Budget, BudgetExceededError } from "./budget.ts";
import { MODELS } from "./models.ts";
import { runOne } from "./run_one.ts";
import { generateReport } from "./score.ts";

interface CliArgs {
  layer: "l1" | "l2";
  file?: string[];
  models: string[];
  limit?: number;
  seeds: number;
  concurrency: number;
  budget: number;
  perTaskBudget: number;
  outDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    layer: "l1",
    file: undefined,
    models: ["gpt-5-nano"],
    seeds: 1,
    concurrency: 1,
    budget: 5.0,
    perTaskBudget: 0.5,
    outDir: resolve("evals/runs"),
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
      case "--file":
        (out.file ??= []).push(val);
        i += advance;
        break;
      case "--models":
        out.models = val.split(",").map((s) => s.trim()).filter(Boolean);
        i += advance;
        break;
      case "--limit":
        out.limit = Number(val);
        i += advance;
        break;
      case "--seeds":
        out.seeds = Number(val);
        i += advance;
        break;
      case "--concurrency":
        out.concurrency = Number(val);
        i += advance;
        break;
      case "--budget":
        out.budget = Number(val);
        i += advance;
        break;
      case "--per-task-budget":
        out.perTaskBudget = Number(val);
        i += advance;
        break;
      case "--out-dir":
        out.outDir = resolve(val);
        i += advance;
        break;
      case "-h":
      case "--help":
        printHelp();
        Deno.exit(0);
        break;
      default:
        // ignore unknowns so positional args don't break us
        break;
    }
  }
  return out;
}

function printHelp(): void {
  const known = Object.keys(MODELS).join(", ");
  console.log(`rex-ai eval runner

Flags:
  --file <path>            YAML task file (repeatable). Defaults to all evals/golden/*.yaml.
  --models a,b,c           Comma-separated model aliases or provider model ids.
                           Default: gpt-5-nano.
  --limit <n>              Max tasks per file (smoke test).
  --seeds <n>              Run each task n times. Default 1.
  --concurrency <n>        Parallel runs. Default 1.
  --budget <usd>           Hard cap on total cost. Default 5.00.
  --per-task-budget <usd>  Soft cap per task. Default 0.50.
  --out-dir <path>         Where to write runs. Default evals/runs.

Registered aliases: ${known}
(Unregistered ids are passed through if prefixed with gpt-/o1-/o3- or claude-.)`);
}

async function loadFiles(roots: string[] | undefined): Promise<
  Array<{ path: string; doc: TaskFile }>
> {
  const out: Array<{ path: string; doc: TaskFile }> = [];
  if (roots && roots.length > 0) {
    for (const path of roots) {
      out.push({ path: resolve(path), doc: await readYaml(resolve(path)) });
    }
    return out;
  }
  const goldenDir = resolve("evals/golden");
  for await (
    const entry of walk(goldenDir, {
      exts: [".yaml", ".yml"],
      includeDirs: false,
    })
  ) {
    out.push({ path: entry.path, doc: await readYaml(entry.path) });
  }
  return out;
}

async function readYaml(path: string): Promise<TaskFile> {
  const raw = await Deno.readTextFile(path);
  const doc = parseYaml(raw) as TaskFile;
  if (!doc.tasks || !Array.isArray(doc.tasks)) {
    throw new Error(`${path}: missing tasks[] array`);
  }
  return doc;
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
  return join(outDir, `${ts}_${id}`);
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  const runDir = freshRunDir(args.outDir);
  await ensureDir(runDir);
  const jsonlPath = join(runDir, "results.jsonl");
  const reportPath = join(runDir, "report.md");
  const runId = crypto.randomUUID();
  const rexAiCommit = await gitCommit();

  const files = await loadFiles(args.file);
  if (files.length === 0) {
    console.error("no YAML task files found");
    return 1;
  }

  const budget = new Budget(args.budget, args.perTaskBudget);
  const writer = await Deno.open(jsonlPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const enc = new TextEncoder();
  const writeRow = async (row: RunResultRow) => {
    await writer.write(enc.encode(JSON.stringify(row) + "\n"));
  };

  console.log(
    `[runner] run_id=${runId.slice(0, 8)} commit=${rexAiCommit} budget=$${
      args.budget.toFixed(2)
    } models=${args.models.join(",")}`,
  );
  console.log(`[runner] out → ${relative(Deno.cwd(), jsonlPath)}`);

  let total = 0;
  let completed = 0;
  for (const { doc } of files) {
    const tasks = args.limit ? doc.tasks.slice(0, args.limit) : doc.tasks;
    total += tasks.length * args.models.length * args.seeds;
  }

  outer:
  for (const { path, doc } of files) {
    const sourceLabel = relative(Deno.cwd(), path);
    const tasks = args.limit ? doc.tasks.slice(0, args.limit) : doc.tasks;
    for (const task of tasks) {
      for (const modelAlias of args.models) {
        for (let seed = 0; seed < args.seeds; seed++) {
          completed++;
          const tag = `[${completed}/${total}]`;
          console.log(`${tag} ${task.id} model=${modelAlias} seed=${seed}`);
          let row: RunResultRow;
          try {
            row = await runOne({
              layer: args.layer,
              source: sourceLabel,
              task,
              modelAlias,
              seed,
              runId,
              rexAiCommit,
              defaultAgent: doc.agent,
            });
          } catch (e) {
            console.error(`  ! ${(e as Error).message}`);
            continue;
          }
          await writeRow(row);
          try {
            budget.charge(row.cost_usd);
          } catch (e) {
            if (e instanceof BudgetExceededError) {
              console.error(`! ${e.message}`);
              break outer;
            }
            throw e;
          }
          const flag = row.score === 1 ? "✓" : "✗";
          console.log(
            `  ${flag} score=${row.score} steps=${row.steps} cost=$${
              row.cost_usd.toFixed(4)
            } wall=${row.wall_ms}ms`,
          );
          if (row.judge_rationale) {
            console.log(`    judge: ${row.judge_rationale}`);
          }
        }
      }
    }
  }
  writer.close();

  console.log(
    `[runner] done. spent=$${budget.spent.toFixed(4)} / cap=$${budget.cap.toFixed(2)}`,
  );
  await generateReport(jsonlPath, reportPath);
  console.log(`[runner] report → ${relative(Deno.cwd(), reportPath)}`);
  return 0;
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}
