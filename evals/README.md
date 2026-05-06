# rex-ai evaluation suite

Two layers, one runner, one report format.

| Layer  | What it measures                                                                  | Source                          |
| ------ | --------------------------------------------------------------------------------- | ------------------------------- |
| **L1** | rex-ai's full agent loop on curated tasks (math, web, JSON, multi-step)           | YAML files in `evals/golden/`   |
| **L2** | rex-ai's function-calling fidelity — BFCL v4 driven through the rex-ai harness    | BFCL v4 via `@ai-sdk-tool/eval` |

Both layers run the rex-ai code-action loop end-to-end. L2 doesn't expose a "raw model" baseline —
that would only re-measure what BFCL already publishes upstream. The adapter
(`evals/bfcl/adapter.ts`) presents itself to BFCL as a `LanguageModelV2` whose `doGenerate` runs
`Agent.run()` against the inner real model, registers each BFCL tool as a recording stub, and
returns the recorded tool calls as the model's "output."

L0 (fake-model unit tests for the harness) lives in `tests/` and `evals/tests/` — runs on every PR.
L3 (Python-bridged SWE-bench / AppWorld / τ²-bench) is intentionally out of scope for v0.1; see
`docs/plans/eval-suite.md` §10.

## Quick start

```sh
# L1 — golden-set regression check (cheap, ~$0.05 per model)
OPENAI_API_KEY=… deno task eval:l1 --models gpt-5-nano

# L1 smoke test — one task, one model
OPENAI_API_KEY=… deno task eval:l1 --file evals/golden/rex_specific.yaml --limit 1

# L2 — BFCL function-calling
OPENAI_API_KEY=… deno task eval:l2 --models gpt-5-nano --benchmarks simple,parallel

# L2 — full BFCL (single + multi-turn)
OPENAI_API_KEY=… deno task eval:l2 --models gpt-5-nano --benchmarks all

# Score an existing run manually
deno task eval:score evals/runs/<id>/results.jsonl
```

Each invocation creates `evals/runs/<timestamp>_<id>/` containing `results.jsonl` and `report.md`
(aggregated tables). L1 writes one row per task × model × seed; L2 writes one aggregate row per
benchmark × model (BFCL's `evaluate()` only surfaces benchmark-level success).

## Files

```
evals/
├─ runner.ts            # L1 entry point (deno task eval:l1)
├─ run_one.ts           # single-task fn (testable; see evals/tests/)
├─ score.ts             # JSONL → markdown report
├─ regression_gate.ts   # CI gate against evals/runs/baseline.json
├─ types.ts             # JSONL row schema, GraderConfig, TaskFile
├─ models.ts            # Pinned model registry + cost estimate
├─ budget.ts            # Hard / soft cost caps
├─ agents/mod.ts        # Stock agent factories: generic, web, math
├─ graders/             # exact_match, numeric_match, json_match,
│                       # regex_match, llm_judge
├─ golden/              # L1 task YAMLs
│  ├─ import.ts         # Stub: refresh from upstream sources (HF / GitHub)
│  ├─ rex_specific.yaml # 3 hand-written diagnostic tasks
│  ├─ humaneval_easy.yaml
│  ├─ math_l1.yaml
│  ├─ simpleqa.yaml
│  └─ smolagents_gaia.yaml
├─ bfcl/run.ts          # L2 entry point (deno task eval:l2)
├─ tests/               # Offline unit + integration tests (run via deno task test:unit)
└─ runs/                # Gitignored output (per-run JSONL + report.md)
```

## Adding an L1 task

1. Pick the file the task fits into, or create a new one in `evals/golden/`.
2. Add an entry under `tasks:`:

   ```yaml
   - id: my-cat-001 # unique within the file
     task: |
       The full prompt the agent will see.
     grader:
       type: numeric_match # or exact_match, json_match, regex_match, llm_judge
       expected: 42
       tolerance: 0
     agent: generic # generic | web | math (file-level default applies if omitted)
     max_steps: 4
     tags: [math, single-step]
   ```

3. Smoke test:

   ```sh
   OPENAI_API_KEY=… deno task eval:l1 --file evals/golden/<file>.yaml --limit 1
   ```

### Grader cheat sheet

| Grader          | Use for                           | Required keys                                                                                      |
| --------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `exact_match`   | Short factual answers             | `expected: string \| string[]`, optional `normalize: "strict"\|"loose"`                            |
| `numeric_match` | Numerical answers                 | `expected: number`, optional `tolerance`, `op: "==" \| ">=" \| "<=" \| "range"`, `range: [lo, hi]` |
| `json_match`    | Structured outputs                | `expected: <any JSON>`, optional `subset: true`                                                    |
| `regex_match`   | Free-form with required substring | `pattern: string`, optional `flags`                                                                |
| `llm_judge`     | Fuzzy, semantic answers           | `rubric: string` (used to prompt the pinned judge model)                                           |

The judge model is pinned in `evals/models.ts` (`JUDGE_MODEL_ALIAS`). Don't rotate it casually —
historical scores stop being comparable.

### Choosing an agent factory

| Factory   | Permissions                    | Tools      | Best for                                          |
| --------- | ------------------------------ | ---------- | ------------------------------------------------- |
| `generic` | none                           | none       | Pure-sandbox computation (math, JSON, string ops) |
| `web`     | `net: ["*"]`                   | `webFetch` | HTTP / API tasks                                  |
| `math`    | `modules: [@std/math, mathjs]` | none       | Math problems where stdlib JS isn't enough        |

## Adding a model

1. Edit `evals/models.ts`, add to the `MODELS` map. Use a _dated_ `id` so runs stay reproducible.
2. Add the price (USD per 1M input / output tokens).
3. Pass `--models <alias>` to either runner.

## Cost / budget

`--budget <USD>` caps total cost per invocation (default $5). `--per-task-budget <USD>` is a soft
per-task cap (default $0.50). When the hard cap is hit, the runner aborts and writes the partial
JSONL.

## CI

- `.github/workflows/test.yml` — runs `deno task check` + `test:unit` + `test:integration` on every
  PR. **No L1 / L2 runs on PRs.** They cost real money.
- `.github/workflows/evals-nightly.yml` — runs L1 + L2 (`simple,parallel`) nightly at 06:00 UTC.
  Manual dispatch supports custom models / benchmarks / budget. Each layer has a regression gate
  (`evals/regression_gate.ts`) that fails if accuracy drops more than 10pp vs the recorded baseline.

To bless a new baseline (after a deliberate accuracy improvement):

```sh
deno run --allow-read --allow-write evals/regression_gate.ts --layer l1 --update
deno run --allow-read --allow-write evals/regression_gate.ts --layer l2 --update
git add evals/runs/baseline.json
```

## Attribution

Tasks in `evals/golden/` derive style and structure from the following sources. See each YAML's
`source:` block for the per-file pin.

- **HumanEval** — https://github.com/openai/human-eval (MIT)
- **MATH** — https://github.com/hendrycks/math (MIT)
- **SimpleQA** — https://openai.com/index/introducing-simpleqa/ (MIT)
- **GAIA / smolagents/benchmark-v1** — https://huggingface.co/datasets/smolagents/benchmark-v1
  (CC-BY-4.0, gated)
- **BFCL v4** — https://github.com/ShishirPatil/gorilla, vendored via `@ai-sdk-tool/eval`

The committed YAMLs contain _style-equivalent_ tasks where the upstream is gated or unstable.
`evals/golden/import.ts` is the documented refresh path; it's a stub today (per-source TODOs
marked).
