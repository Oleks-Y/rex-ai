# Eval Suite Survey for rex-ai

**Date:** 2026-05-04
**Purpose:** Inform the design of an evaluation suite for rex-ai (TS/Deno code-action agent on Vercel AI SDK).
**Sources:** smolagents repo + benchmark, open-source agentic eval ecosystem, TS/Node agent landscape.

---

## 1. How smolagents does evals (the reference we were inspired by)

- **Benchmark suite:** `examples/smolagents_benchmark/` runs against HF dataset `smolagents/benchmark-v1` with three configs: **GAIA (validation)**, **MATH**, **SimpleQA**. An older bundle (`m-ric/agents_medium_benchmark_2`) is referenced in the README.
- **Methodology:** single-pass per task (no pass@k, no majority vote), parallel via thread pool, JSONL with predicted answer + intermediate steps + token counts. **Auto-graded with normalized exact-match — NOT LLM-as-judge.** GAIA: strip `$`, `%`, commas; split list answers; lowercase. MATH: extract last number, `np.isclose(rtol=1e-5)`. 10 step max, 8192 token cap.
- **Tasks:** multi-step research+tool-use (GAIA via `GoogleSearchTool`+`VisitWebpageTool`), math (MATH, with `numpy`+`sympy` allowed), factual short-answer (SimpleQA). Code execution is implicit (the "code agent" variant runs LLM-generated Python).
- **Metrics:** **only accuracy.** Tokens and step counts are recorded but not aggregated. No cost / latency / trajectory-length / tool-call efficiency.
- **Comparisons:** internal A/B — `code` agent vs `tool-calling` agent vs `vanilla` LLM, across models (GPT-4o, Sonnet 3.5, Llama 3.x, Qwen, DeepSeek-R1) via `LiteLLMModel`. **Does not benchmark vs LangChain/CrewAI/AutoGen.** External numbers (Magentic-One, OpenAI Deep Research) are cited in blog posts, not re-run.
- **Test infra patterns worth borrowing:**
  - `FakeToolCallModel` / `FakeCodeModel` subclasses override `generate()` and return canned `ChatMessage`s, branching on message count or content marker — deterministic multi-step trajectories without real LLM calls.
  - Sandbox tests are **separated** from agent-loop tests (`test_local_python_executor.py`, `test_remote_executors.py`).
  - `test_all_docs.py` runs every doc snippet — keeps examples from rotting.
  - Telemetry/monitoring tests verify token accounting independently.
  - Benchmark JSONL stores full trajectory keyed by `(model, agent_action_type, question)` — clean replay/audit format.
- **Gaps in smolagents' approach (rex-ai can do better):** no LLM-as-judge for fuzzy answers; no aggregated cost/latency/budget metrics despite collecting the data; no pass@k or seed sweeps; no comparison vs other harnesses; no coding benchmarks (HumanEval/SWE-bench).

Key files:
- https://github.com/huggingface/smolagents/blob/main/examples/smolagents_benchmark/run.py
- https://github.com/huggingface/smolagents/blob/main/examples/smolagents_benchmark/score.ipynb
- https://huggingface.co/datasets/smolagents/benchmark-v1
- https://github.com/huggingface/smolagents/tree/main/tests
- https://huggingface.co/blog/beating-gaia
- https://huggingface.co/blog/open-deep-research

---

## 2. Benchmark + harness inventory (what's out there)

### Generic agent benchmarks

| Benchmark | What it measures | License | Lang | URL |
|---|---|---|---|---|
| **GAIA** | 466 multi-step research/browsing tasks, 3 difficulties, multimodal | CC-BY-4.0 (gated) | Py | [HF dataset](https://huggingface.co/datasets/gaia-benchmark/GAIA) |
| **AgentBench** | 8 envs (OS, DB, KG, web shop, browse, household, etc.) | Apache-2.0 | Py | [THUDM/AgentBench](https://github.com/THUDM/AgentBench) |
| **AgentBoard** | Multi-turn analytical eval | — | Py | [hkust-nlp/AgentBoard](https://github.com/hkust-nlp/AgentBoard) |
| **ToolBench / ToolLLM** | Tool-use across 16k+ APIs | Apache-2.0 | Py | [OpenBMB/ToolBench](https://github.com/OpenBMB/ToolBench) |
| **MINT** | Multi-turn tool use w/ Python exec + GPT-4 user feedback | — | Py | [xingyaoww/mint-bench](https://github.com/xingyaoww/mint-bench) |
| **AppWorld** ⭐ | 750 interactive tasks, agent **writes Python**, code runs against 9 simulated apps + 457 APIs, **state-based grading**. Closest semantic match to rex-ai. | Apache-2.0 | Py | [StonyBrookNLP/appworld](https://github.com/StonyBrookNLP/appworld) |
| **WebArena / VisualWebArena** | Self-hosted web env w/ realistic sites | Apache-2.0 | Py | [web-arena-x](https://github.com/web-arena-x/webarena) |
| **OSWorld** | Real desktop GUI tasks | Apache-2.0 | Py | [xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld) |
| **TheAgentCompany** | 175 sim-software-company tasks (GitLab/OwnCloud/Plane/RocketChat); execution-based grading | MIT | Py | [TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany) |
| **WorkArena** | Enterprise SaaS workflows | Apache-2.0 | Py | [ServiceNow/WorkArena](https://github.com/ServiceNow/WorkArena) |
| **Mind2Web** | Open-web nav | MIT/CC-BY-4.0 | Py | [OSU-NLP-Group/Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web) |

### Code-execution / SWE benchmarks

| Benchmark | Notes | URL |
|---|---|---|
| **SWE-bench / Verified / Lite / Multimodal** | Real GitHub issue resolution; Verified is human-validated | [SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench) |
| **HumanEval / MBPP** | Function-completion classics | [openai/human-eval](https://github.com/openai/human-eval) |
| **BigCodeBench** | 1140 tasks w/ diverse function calls + complex instructions | [bigcode-project/bigcodebench](https://github.com/bigcode-project/bigcodebench) |
| **LiveCodeBench** | Contamination-free, contest-sourced | [LiveCodeBench](https://github.com/LiveCodeBench/LiveCodeBench) |
| **MLE-bench** | 75 Kaggle ML competitions in a sandbox | [openai/mle-bench](https://github.com/openai/mle-bench) |
| **RE-Bench (METR)** | 7 long-horizon ML R&D tasks vs. human experts | [METR/RE-Bench](https://github.com/METR/RE-Bench) |
| **BIRD-SQL** | Large-scale text-to-SQL on real DBs | [BIRD-SQL](https://github.com/AlibabaResearch/DAMO-ConvAI/tree/main/bird) |

### Reasoning + tool use

| Benchmark | Notes | URL |
|---|---|---|
| **GSM8K / MATH / MMLU-Pro** | Classic reasoning sets | various |
| **ARC-AGI 1/2/3** | Abstraction reasoning | [fchollet/ARC-AGI](https://github.com/fchollet/ARC-AGI) |
| **BrowseComp (OpenAI 2025)** | 1,266 hard-to-find browsing facts | [openai.com/browsecomp](https://openai.com/index/browsecomp/) |
| **FRAMES (Google)** | Multi-hop factual Q&A w/ retrieval | [HF dataset](https://huggingface.co/datasets/google/frames-benchmark) |
| **τ-bench / τ²-bench / τ³-bench (Sierra)** ⭐ | Simulated user × tool-agent in retail/airline/banking. Best-in-class adversarial tool use. | [sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench) |
| **BFCL v4 (Berkeley)** ⭐ | Function-calling: simple, parallel, multi-turn, missing-func/param, multi-step. **Has TS port via `@ai-sdk-tool/eval`.** | [Gorilla BFCL](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard) |

### Eval runners / harnesses

| Runner | Lang | License | URL |
|---|---|---|---|
| **EleutherAI lm-evaluation-harness** | Py | MIT | [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) |
| **Inspect AI (UK AISI)** ⭐ | Py core (TS in web-UI only) | MIT | [inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai) + [inspect_evals](https://github.com/UKGovernmentBEIS/inspect_evals) |
| **OpenAI Evals** | Py | MIT | [openai/evals](https://github.com/openai/evals) |
| **OpenAI simple-evals** | Py (deprecated 2025-07 but reference impls remain) | MIT | [openai/simple-evals](https://github.com/openai/simple-evals) |
| **LangSmith / LangChain evals** | TS+Py | SaaS | [docs.smith.langchain.com](https://docs.smith.langchain.com) |
| **DeepEval** | Py | Apache-2.0 | [confident-ai/deepeval](https://github.com/confident-ai/deepeval) |
| **Promptfoo** ⭐ | **TS/Node-native** | MIT (acquired by OpenAI 2026-03) | [promptfoo](https://github.com/promptfoo/promptfoo) |
| **Braintrust** | TS+Py | Proprietary SaaS, OSS SDK | [braintrust.dev](https://www.braintrust.dev) |
| **Langfuse** | TS+Py | MIT (self-hostable) | [langfuse/langfuse](https://github.com/langfuse/langfuse) |
| **Arize Phoenix** | TS+Py | Elastic-2.0 | [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) |
| **Helicone / Ragas / AgentOps** | mixed | various | — |

### TS-native eval kit (the standout for our stack)

**`@ai-sdk-tool/eval`** — Vercel AI SDK eval kit. Ships `bfclSimpleBenchmark`, `bfclParallelBenchmark`, and four `bfclMultiTurn*` benchmarks executed in **pure TS** against a `LanguageModelV3`. **This is the only eval kit that natively speaks rex-ai's runtime.**
URL: https://www.npmjs.com/package/@ai-sdk-tool/eval

### Code-action / sandboxed-execution (rex-ai's exact pattern)

- **AppWorld** — agent writes Python, runs against stateful API world, graded on DB state.
- **MLE-bench** — sandbox executes agent's code against held-out test sets.
- **RE-Bench** — long-horizon coding tasks scored by function output.
- **MINT** — Python tool execution + simulated user feedback.
- **smolagents `CodeAgent`** — same loop pattern.

---

## 3. Node.js / TS agent libraries to compare against

(May 2026 snapshot.)

| # | Library | Stars / Last push | Abstraction | Code-action? | Own evals? |
|---|---|---|---|---|---|
| 1 | **Vercel AI SDK** (`ai` v6) | 24.0k / 2026-05-04 | Single-agent loop, `Agent`/`ToolLoopAgent` | No first-class — pair w/ Vercel Sandbox / E2B | No |
| 2 | **LangGraph.js** | 2.9k / 2026-05-04 | Stateful graph / ReAct / plan-execute | No native; `deepagentsjs` adds planning, tools only | LangSmith |
| 3 | **LangChain.js** | 17.6k / 2026-05-04 | Tool-calling + chains | Via E2B | LangSmith |
| 4 | **Mastra** ⭐ | 23.6k / 2026-05-04 | Agent + workflows + RAG + Workspaces | **Yes** — coding-agent template, sandbox providers (E2B/Daytona/Blaxel) | **Yes — `@mastra/evals` w/ scorers + CI runner** |
| 5 | **VoltAgent** | 8.6k / 2026-04-28 | Supervisor multi-agent + observability console | Tools only | Observability instead |
| 6 | **Inngest AgentKit** | 854 / 2026-04-29 | Multi-agent networks w/ deterministic router | Tools/MCP only | No |
| 7 | **OpenAI Agents JS** | 2.9k / 2026-05-04 | Single-agent loop + handoffs + voice | OpenAI hosted code-interpreter | No |
| 8 | **Claude Agent SDK** | 1.4k / 2026-05-01 | Claude Code loop as library; built-in Bash/Read/Edit | Discrete tools, not arbitrary scripts | No |
| 9 | **Axar AI** | 158 / 2026-02-09 (slow) | Decorator/DI typed agent | Tools only | No |
| 10 | **SpinAI** | 353 / 2025-11-14 (stale) | Lightweight | Tools only | No |
| 11 | **Eko (FellouAI)** ⭐ | 4.9k / 2026-03-03 | Generates JS workflow code; browser/computer-use focus | Partial — not isolated sandbox | No |
| 12 | **AgentScope-TS** | 13 / 2026-04-07 (early) | ReAct, multi-agent | Tools only | Has eval module (Python parent) |
| 13 | **CrewAI TS ports** | dead | — | — | — |
| 14 | **Letta (MemGPT)** | 47 / 2026-04-30 | Client SDK to Letta server | Server-side | Server-side |
| 15 | **SmythOS SDK** | 1.3k / 2026-04-03 | Fluent + visual builder | Tools/skills | No |
| 16 | **BeeAI Framework** | 3.2k / 2026-05-04 | ReAct + workflows + MCP/A2A | Tools only | No |
| 17 | **GenSX** | archived 2025-09 | — | — | — |

### Direct competitors (apples-to-apples) — these pair an agent loop with LLM-generated code → isolated execution

1. **Mastra coding-agent + E2B/Daytona** — closest match; TS, Vercel-AI-SDK-compatible, has its own evals. **Top priority comparison.**
2. **Claude Agent SDK** — code-editing/Bash agent loop; different shape (discrete tools vs. write-&-run scripts) but same task domain. Useful upper-bound baseline.
3. **LangGraph.js + `@langchain/community` E2B tool** — graph-orchestrated code-action; dominant orchestration baseline.
4. **OpenAI Agents JS + hosted code-interpreter** — managed code execution vs rex-ai's BYO sandbox.
5. **Eko** — JS-as-action paradigm, philosophical sibling.
6. **Vercel AI SDK ToolLoopAgent + Deno sandbox tool** — bare-stack baseline ("is rex-ai's abstraction worth it over raw AI SDK?").

### Skip head-to-head

- **VoltAgent, Inngest AgentKit, BeeAI, SmythOS** — multi-agent orchestration / durable workflows / visual builders. Different problem.
- **Letta** — stateful memory agents; client SDK only.
- **Axar, SpinAI, AgentScope-TS, CrewAI TS** — too small/stale or experimental.
- **GenSX** — archived.
- **LangChain.js core agents** — superseded by LangGraph.js for new work.

---

## 4. Synthesis: opinionated recommendation

### Eval stack to adopt for rex-ai

1. **`@ai-sdk-tool/eval` (TS-native)** — the default. Same SDK surface (`LanguageModelV3`), runs BFCL v4 simple/parallel/multi-turn with no Python dep. Speaks rex-ai's runtime natively. **Start here.**
2. **τ²-bench (Python via subprocess)** — best-in-class multi-turn tool-use eval; simulated user adversary surfaces failure modes specific to code-action loops.
3. **AppWorld (Python via subprocess)** — closest semantic match to "agent emits code, sandbox runs it, state-based grading." Worth the Python bridge.
4. **SWE-bench Verified (Python via subprocess)** — credibility benchmark for code-editing agents.
5. **Inspect AI as the umbrella runner** — wrap rex-ai as an Inspect "bridged solver" so GAIA, BrowseComp, BFCL, SWE-bench all share one harness with shared logging + replay.

For tracing/observability: **Langfuse** (MIT, self-hostable, TS SDK) or **Arize Phoenix** (OTel, TS SDK).

### Test/infra patterns to borrow from smolagents

- **Fake model classes** that return canned `ChatMessage`s branching on message count — deterministic multi-step trajectories without API calls (huge for unit tests).
- **Sandbox tests separated from agent-loop tests.**
- **Doc-snippet test harness** — run every README/example as a test.
- **Trajectory JSONL keyed by (model, agent_type, task)** for replay/audit.

### Improvements over smolagents' methodology

- Aggregate **cost / latency / step-budget / token** metrics — smolagents collects but doesn't report.
- Add **LLM-as-judge** for fuzzy answers (smolagents misses semantically correct ones).
- Add **pass@k or seed sweeps** for non-deterministic tasks.
- **Compare against direct competitor harnesses** (Mastra, LangGraph, Claude Agent SDK, raw Vercel AI SDK) — smolagents doesn't.
- Add a **coding-benchmark layer** (HumanEval / BigCodeBench / SWE-bench Verified) — smolagents ignores this and it's exactly where code-action should win.
