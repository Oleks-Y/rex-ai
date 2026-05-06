# Plan: rex-ai Evaluation Suite

**Status:** approved direction; ready to implement.
**Scope:** L1 (in-repo curated tasks against real LLMs) + L2 (BFCL v4 via `@ai-sdk-tool/eval`).
**Out of scope (for now):** L3 Python-bridged benchmarks (SWE-bench / AppWorld / τ²-bench). Revisit at v0.5+.
**Source research:** [`docs/research/eval-suite-survey.md`](../research/eval-suite-survey.md).

---

## 0. Goals

1. **Detect regressions in the agent loop** when refactoring sandbox / extractor / prompt / tools.
2. **Compare model choices** (gpt-5-nano vs claude-haiku-4-5 vs sonnet, etc.) on accuracy / cost / latency / step count.
3. **Demonstrate code-action's value** with diagnostic tasks where one script beats N tool calls.
4. **Publish credible function-calling numbers** via BFCL v4 (industry-standard, comparable to other libs).

Non-goals (for v1):
- Full SWE-bench / AppWorld scores.
- Comparison head-to-head against Mastra / LangGraph / Claude Agent SDK (record this in followups; needs separate harness wrappers).
- A leaderboard or public dashboard.

---

## 1. Top-level layout

```
evals/
├─ deno.json                   # task aliases: eval:l1, eval:l2, eval:all
├─ runner.ts                   # core: load tasks, spawn agent, write JSONL
├─ score.ts                    # JSONL → markdown report
├─ types.ts                    # Task, RunResult, Grader, Metrics
├─ models.ts                   # model registry (pinned versions + judge model)
├─ budget.ts                   # cost cap + task limit + abort logic
│
├─ graders/
│  ├─ exact_match.ts           # string normalize + compare
│  ├─ numeric_match.ts         # extract last number, ==/>=/range
│  ├─ json_match.ts            # parse JSON, structural compare
│  ├─ regex_match.ts           # answer must match pattern
│  └─ llm_judge.ts             # judge model + rubric → 0|1 + rationale
│
├─ golden/                     # L1: in-repo tasks
│  ├─ import.ts                # one-shot script: pull from sources → YAML
│  ├─ smolagents_gaia.yaml     # 4 tasks
│  ├─ math_l1.yaml             # 3 tasks
│  ├─ simpleqa.yaml            # 2 tasks
│  ├─ humaneval_easy.yaml      # 3 tasks
│  └─ rex_specific.yaml        # 3 hand-written tasks
│
├─ bfcl/                       # L2
│  ├─ run.ts                   # wires @ai-sdk-tool/eval against rex-ai
│  └─ adapter.ts               # adapts rex-ai Agent to LanguageModelV3 surface
│
├─ agents/                     # eval-only agent factories
│  ├─ generic.ts               # default rex-ai agent w/ minimal tools
│  ├─ web.ts                   # adds GoogleSearch / VisitWebpage tools
│  └─ math.ts                  # adds numpy/sympy-equivalent permissions (modules: ["jsr:@stdlib/math"])
│
├─ runs/                       # gitignored: JSONL output of runs
│  └─ <timestamp>_<run-id>/
│     ├─ results.jsonl
│     └─ report.md
│
└─ README.md
```

---

## 2. L1: in-repo golden set

### 2.1 Task file format (YAML, committed to repo)

```yaml
# evals/golden/smolagents_gaia.yaml
source:
  name: smolagents/benchmark-v1 (GAIA config)
  url: https://huggingface.co/datasets/smolagents/benchmark-v1
  license: CC-BY-4.0
  pulled_at: 2026-05-04
  pinned_revision: <commit-or-dataset-hash>
agent: web        # which evals/agents/<name>.ts factory to use
tasks:
  - id: gaia-001
    task: "Summarize the latest open issues in denoland/deno (top 5)."
    grader:
      type: llm_judge
      rubric: |
        Score 1 if the answer (a) names denoland/deno explicitly,
        (b) lists at least 3 distinct issues with titles,
        (c) is plain prose (not raw JSON dump).
        Otherwise 0.
    max_steps: 5
    tags: [http, multi-step, summarization]

  - id: gaia-002
    task: "What is 17 * 23 - sqrt(144) ?"
    grader:
      type: numeric_match
      expected: 379       # 17*23 - 12 = 391-12 = 379
      tolerance: 0
    max_steps: 2
    tags: [math, single-step]
```

### 2.2 Sources + counts (15 tasks total)

| File | Source | License | Count |
|---|---|---|---|
| `smolagents_gaia.yaml` | `smolagents/benchmark-v1` GAIA config (validation level-1 subset) | CC-BY-4.0 | 4 |
| `math_l1.yaml` | `hendrycks/MATH` Level 1–2 algebra/precalc | MIT | 3 |
| `simpleqa.yaml` | `openai/simple-evals` SimpleQA subset | MIT | 2 |
| `humaneval_easy.yaml` | `openai/human-eval` (problems 0, 1, 7 — easiest) | MIT | 3 |
| `rex_specific.yaml` | hand-written | rex-ai license | 3 |

`rex_specific.yaml` covers:
1. **Tool RPC + permission scoping** — fetch GitHub issues count via parent-side tool, no direct net.
2. **Sandbox-only computation** — given an inline JSON blob, return record matching predicate (no I/O).
3. **Multi-tool chain** — fetch URL via tool A, write summary via tool B, persist to `storage`, reply.

### 2.3 Importer: `evals/golden/import.ts`

One-shot script (deno run, manual invocation) that:

1. Reads source URLs from each `*.yaml` `source:` block.
2. Pulls the source dataset (HF parquet via `npm:@huggingface/hub` or direct fetch).
3. Selects pre-pinned task IDs (recorded in YAML, not random).
4. Verifies expected answers match the source (warn on drift).
5. Re-writes the `tasks:` array of each YAML.

Importer is **manual** — not run on every eval. Re-run only when refreshing source data. The committed YAML is the source of truth for runs.

License compliance: every YAML carries `source.url` + `source.license` + `pulled_at`. README includes attribution block.

GAIA gating: importer requires `HF_TOKEN` env var; without it, skip GAIA and warn. The committed `smolagents_gaia.yaml` lives in the repo (CC-BY-4.0 permits redistribution with attribution).

### 2.4 Agent factories for evals (`evals/agents/`)

Eval tasks need a rex-ai agent configured per task category. We ship 3 stock factories:

- **`generic.ts`** — model + no tools + zero permissions. For tasks rex-ai must solve in pure sandbox.
- **`web.ts`** — adds `googleSearch` (tool) + `visitWebpage` (tool with allow-list). For GAIA / SimpleQA.
- **`math.ts`** — allows `jsr:@stdlib/math` import in sandbox. For MATH.

Each factory accepts `{ model: string }` so the runner can swap models. The YAML's `agent:` field selects which factory.

---

## 3. L2: BFCL via `@ai-sdk-tool/eval`

### 3.1 Wiring

`evals/bfcl/run.ts` imports from `npm:@ai-sdk-tool/eval` and calls:

- `bfclSimpleBenchmark`
- `bfclParallelBenchmark`
- `bfclMultiTurnBaseBenchmark`
- `bfclMultiTurnLongContextBenchmark`
- `bfclMultiTurnMissParamBenchmark`
- `bfclMultiTurnMissFuncBenchmark`

Each takes a `LanguageModelV3` and returns a result struct.

### 3.2 Adapter strategy

BFCL grades function-calling. rex-ai's surface is "agent runs code that calls tools, returns a final reply." We bridge the two with a single adapter — `evals/bfcl/adapter.ts` — that exposes a synthetic `LanguageModelV2` to BFCL while running rex-ai underneath:

1. BFCL calls `generateText({ model, messages, tools })` against the adapter.
2. The adapter's `doGenerate` formats the message history into a rex-ai task description, registers each BFCL tool as a recording stub (`z.unknown()` schema, handler appends `{name, args}` to a list and returns a placeholder), and runs `Agent.run()` against the **inner** real provider model.
3. After the agent terminates, the adapter returns the recorded tool invocations as `tool-call` content parts plus the agent's final `reply` text.

Why a single mode: a "raw model" baseline only measures what BFCL upstream already publishes, which we don't need to re-run. The published L2 score is rex-ai's score — the harness contribution shows up directly when we compare against BFCL's published numbers for the same model.

The adapter accepts anything as tool args (`z.unknown()`) rather than reconstructing a zod schema from BFCL's JSONSchema. BFCL grades the call signature against `possible_answer.jsonl`, so over-restricting the schema would mask actual harness behavior. Tool returns are a synthetic `{ ok: true }` — single-turn benches don't depend on realistic returns; multi-turn benches will score lower against rex-ai than against a tool-native model, and that gap is a real property of running code-action through a function-calling benchmark, not an adapter bug.

### 3.3 BFCL output

BFCL's own scorers produce per-task pass/fail. We convert to our standard JSONL row schema (§5.2) so L1 + L2 reports share infrastructure.

---

## 4. Graders

### 4.1 `exact_match.ts`
- Strip whitespace, lowercase, drop `$ % , ;`. Smolagents-style.
- Config: `{ expected: string | string[], normalize?: 'strict'|'loose' }`.

### 4.2 `numeric_match.ts`
- Extract last number via regex `/-?\d+(\.\d+)?/g`.
- Config: `{ expected: number | string, tolerance?: number, op?: '=='|'>='|'<='|'range' }`.

### 4.3 `json_match.ts`
- Parse final reply as JSON; compare structurally (deep equal, with optional `subset: true` for "expected is a subset of actual").

### 4.4 `regex_match.ts`
- Config: `{ pattern: string, flags?: string }`. Useful when the answer is freeform but must contain a known substring.

### 4.5 `llm_judge.ts`
- Calls a **pinned** judge model (default: `claude-haiku-4-5-20251001`).
- Prompt template:
  ```
  You are grading an agent's answer to a task.
  Task: {{task}}
  Agent reply: {{reply}}
  Rubric: {{rubric}}

  Respond with strict JSON: {"score": 0 | 1, "rationale": "<1 sentence>"}.
  ```
- Logs the judge's full response (rationale) into the JSONL row for debugging.
- Judge model + version pinned in `evals/models.ts`; never auto-bumped.

---

## 5. Runner

### 5.1 Entry points

```sh
# L1: full golden set, all default models
deno task eval:l1

# L1: single file, single model, limited tasks (smoke test)
deno task eval:l1 --file evals/golden/math_l1.yaml --models gpt-5-nano --limit 1

# L2: BFCL
deno task eval:l2 --models gpt-5-nano,claude-haiku-4-5

# Both
deno task eval:all
```

`deno.json` adds tasks; the underlying call is `deno run --allow-env --allow-net --allow-read --allow-write --allow-run evals/runner.ts ...`.

### 5.2 JSONL row schema

One row per `(task, model, seed)` tuple. Single source of truth — both L1 and L2 emit this.

```ts
type RunResult = {
  // identity
  run_id: string;             // UUID per `eval:*` invocation
  layer: "l1" | "l2";
  source: string;             // YAML filename or "bfcl-simple"
  task_id: string;
  seed: number;               // 0 by default, >0 only when --seeds N
  // config
  model: string;              // pinned id, e.g. "gpt-5-nano-2025-12-01"
  agent: string;              // L1 factory name; L2 always "rex-ai"
  // result
  score: 0 | 1 | number;      // numeric for fractional graders later
  grader_type: string;
  judge_rationale?: string;   // only for llm_judge
  reply: string;              // final agent message
  trajectory: Array<{step: number; code?: string; tool_calls?: unknown[]; observation?: unknown}>;
  // metrics
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  steps: number;
  wall_ms: number;
  // failure
  error?: string;             // only on uncaught throw / abort
  finish_reason: "reply" | "abort" | "exhausted" | "error";
  // env
  rex_ai_commit: string;      // git SHA
  ts: string;                 // ISO timestamp
};
```

### 5.3 Cost / budget

`evals/budget.ts`:
- Hard cap per run (default $5, configurable via `--budget 10`).
- Tracked across all rows; abort with summary if exceeded.
- Per-task soft cap (default $0.50, configurable) — task scored 0 if exceeded.

### 5.4 Concurrency

`--concurrency 4` (default) parallelizes via `Promise.all` chunks. BFCL benchmarks already parallelize internally; we respect their setting.

### 5.5 Determinism

- Temperature 0 by default (`--temperature 0.7` overrides).
- Seed pinned where the SDK allows.
- For variance studies: `--seeds 3` runs each task 3× and reports pass@1 + pass@3.

---

## 6. Score / report

`evals/score.ts` reads a `runs/<id>/results.jsonl` and writes `runs/<id>/report.md`:

```markdown
# Eval Report — 2026-05-15 14:22 UTC
**Run ID:** abc123 | **Commit:** 9f8e7d6 | **Layers:** l1, l2

## Headline

| layer  | model            | tasks | accuracy | avg cost | avg tokens | avg steps | p50 wall |
|--------|------------------|-------|----------|----------|------------|-----------|----------|
| l1     | gpt-5-nano       | 15    | 73%      | $0.012   | 2,140      | 3.1       | 4.4s     |
| l1     | claude-haiku-4-5 | 15    | 80%      | $0.018   | 1,830      | 2.4       | 3.1s     |
| l2     | gpt-5-nano       | 400   | 81%      | $0.004   | 580        | n/a       | 1.2s     |
| l2     | claude-haiku-4-5 | 400   | 87%      | $0.006   | 510        | n/a       | 0.9s     |

## L1 Per-task

| task_id   | gpt-5-nano | haiku-4-5 | notes                 |
|-----------|------------|-----------|-----------------------|
| gaia-001  | 1          | 1         | both correct          |
| gaia-002  | 0          | 1         | gpt-5-nano off-by-one |
| ...       |            |           |                       |

## L2 BFCL breakdown

| benchmark              | gpt-5-nano | haiku-4-5 |
|------------------------|------------|-----------|
| simple                 | 92%        | 95%       |
| parallel               | 78%        | 85%       |
| multi-turn-base        | 71%        | 79%       |
| multi-turn-long-ctx    | 65%        | 73%       |
| multi-turn-miss-param  | 68%        | 75%       |
| multi-turn-miss-func   | 62%        | 70%       |

## Failures (top 10 by frequency)

1. gaia-001 / gpt-5-nano: missed mentioning denoland/deno explicitly (judge rationale: ...)
...
```

---

## 7. CI integration

**On every PR** (cheap, deterministic):
- `tests/` (existing unit + integration) — must pass.
- *No L1/L2 — they cost money.*

**Nightly cron + `gh workflow run` manual trigger** (the eval gates):
- `eval:l1` against `gpt-5-nano` (single model, $0.20/run).
- `eval:l2` simple+parallel only (skip multi-turn — long).
- Post `report.md` as a workflow artifact.
- **Regression gate:** fail the workflow if L1 accuracy on `gpt-5-nano` drops by more than 10 percentage points vs the last main-branch run on the same model. (Stored as `runs/baseline.json` updated on green main runs.)

**On-demand (developer laptop):**
- `deno task eval:l1 --limit 3 --models gpt-5-nano` for quick smoke after local changes.

---

## 8. Pinning + drift management

`evals/models.ts`:

```ts
export const MODELS = {
  "gpt-5-nano":        { provider: "openai",     id: "gpt-5-nano-2025-12-01" },
  "claude-haiku-4-5":  { provider: "anthropic",  id: "claude-haiku-4-5-20251001" },
  "claude-sonnet-4-6": { provider: "anthropic",  id: "claude-sonnet-4-6-20251015" },
} as const;

export const JUDGE_MODEL = MODELS["claude-haiku-4-5"];
```

JSONL records the **dated** id (`gpt-5-nano-2025-12-01`), not the alias, so historical runs stay interpretable when `gpt-5-nano` is rotated to a new dated id.

---

## 9. Implementation order (milestones)

1. **M1 — runner skeleton.** `runner.ts`, `types.ts`, `budget.ts`, `models.ts`, JSONL output, `score.ts`. Hardcode 1 fake task. Verify end-to-end.
2. **M2 — graders.** All five (`exact_match`, `numeric_match`, `json_match`, `regex_match`, `llm_judge`). Unit-test each with table-driven tests.
3. **M3 — agents/.** Three eval factories. Reuse pieces from existing `examples/`.
4. **M4 — `rex_specific.yaml`.** Three hand-written tasks. Run end-to-end against gpt-5-nano. Confirm scores look reasonable.
5. **M5 — importer + remaining YAMLs.** `import.ts` pulls smolagents/MATH/SimpleQA/HumanEval. Commit YAMLs. Run full L1.
6. **M6 — L2 wiring.** `bfcl/run.ts` + `bfcl/adapter.ts` (rex-ai-only). Run BFCL simple + parallel through the harness. Sanity-check the adapter end-to-end against gpt-5-nano; expect the rex-ai score to be lower than BFCL's published native function-calling number for the same model — that gap *is* the published harness contribution.
7. **M7 — multi-turn BFCL.** Add the four multi-turn benchmarks. Treat scores as **experimental** until the adapter feeds realistic tool returns (today every call gets `{ok:true}`); the recorded calls are still meaningful, but downstream chained logic that depends on inspecting tool results will degrade.
8. **M8 — CI.** Nightly workflow + regression gate + baseline tracking.
9. **M9 — README + docs.** `evals/README.md` covers task aliases, attribution, how to add a task.

Each milestone is independently mergeable. M1–M4 are the critical path to "first useful eval result"; M5+ is breadth.

---

## 10. Open questions / explicit followups

These are deliberately deferred — flag if you want to revisit before M1:

1. **Comparison baselines** (Mastra / LangGraph / Claude Agent SDK / raw Vercel AI SDK). Big chunk of work — separate plan when L1+L2 are stable.
2. **Trajectory grading.** Hand-written graders that inspect tool-call sequence, not just final answer. Skip for v1.
3. **Public dashboard** (Langfuse / Phoenix / Braintrust). Ship local-only first.
4. **L3 Python bridges.** SWE-bench Verified Lite / AppWorld / τ²-bench. Revisit when rex-ai hits v0.5 / a public release-blog.
5. **Generative tasks.** Programmatically-generated code-action tasks with deterministic ground truth. Could replace some hand-written tasks if curation bias becomes a concern.
