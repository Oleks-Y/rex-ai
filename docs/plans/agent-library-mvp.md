# Agent Library on Deno Sandbox — MVP Plan

> Code-action agent library, TypeScript + Deno runtime, Vercel AI SDK, smolagents-inspired.
> Status: planning. No code yet.

## 1. North star

A library where an LLM **writes TypeScript code** instead of returning structured tool calls. The code runs in a Deno subprocess with caller-controlled permissions. Communication between the agent code and the host happens through three built-in functions injected into the sandbox:

- `reply(message)` — produce the final answer to the user; loop terminates.
- `abort(error)` — refuse / fail fast (used when permissions or capabilities are insufficient); loop terminates with error.
- `reflect(state)` — request another generation step, passing forward state for the next iteration.

Why code-as-action (smolagents thesis): one LLM step can chain multiple operations, branch, loop, do arithmetic, parse, transform — without round-tripping per tool call. Cheaper, more expressive, fewer tokens. Tradeoff: code execution surface needs strong sandboxing, which Deno gives us for free.

## 2. Public surface (target)

```ts
import { Agent } from "@rex/agent";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const agent = new Agent({
  model: openai("gpt-5.2"),
  task: "Summarize the latest 5 issues in the repo.",
  tools: [
    {
      name: "fetchIssues",
      description: "Fetch open GitHub issues for a repo.",
      schema: z.object({ repo: z.string(), limit: z.number().default(10) }),
      handler: async ({ repo, limit }) => { /* ... */ },
    },
  ],
  permissions: {
    net: ["api.github.com"],     // Deno --allow-net allowlist
    read: ["./cache"],            // Deno --allow-read allowlist
    write: [],                    // no fs writes
    env: ["GITHUB_TOKEN"],        // Deno --allow-env allowlist
    run: false,                   // no subprocesses
    modules: ["std/encoding"],    // import allowlist (see §6)
  },
  sessionId: "abc123",            // persistent workspace across steps (see §14a)
  maxSteps: 8,
});

const result = await agent.run();
// → { kind: "reply", message: "..." } | { kind: "abort", error: "..." } | { kind: "exhausted" }
```

## 3. Component map

| # | Component | Responsibility |
|---|---|---|
| 1 | `Agent` | Orchestrator. Owns the loop, the message history, step counter. |
| 2 | `PromptBuilder` | Renders system prompt: control-fn contract, tool catalog, prior step transcript. |
| 3 | `CodeExtractor` | Pulls the TS code block out of the LLM response. |
| 4 | `Sandbox` | Spawns `deno run` subprocess with permission flags, prelude file, RPC pipe. |
| 5 | `Prelude` | Code injected into every sandbox: `reply` / `abort` / `reflect` stubs + tool RPC stubs. |
| 6 | `RpcChannel` | Length-prefixed JSON message framing over stdin/stdout (or a dedicated pipe). |
| 7 | `ToolRegistry` | Holds user tools, validates args with zod, executes handlers in parent process. |
| 8 | `PermissionCompiler` | Translates `permissions` config → Deno CLI flags + import map. |
| 9 | `ModuleGuard` | Enforces module allowlist (see §6). |
| 10 | `SessionStore` | Owns `.rex/sessions/<id>/`: lib.ts (agent-authored helpers), storage.json (KV), transcript.jsonl. Mediates `writeLib` / `storage.*` RPC. |

## 4. Loop semantics

```
1. step = 0; messages = [systemPrompt(task, tools, control-fns)]
2. while step < maxSteps:
3.   completion = generateText({ model, messages })
4.   code = CodeExtractor.extract(completion.text)
5.   event = await Sandbox.run(code, prelude, permissions)
6.   switch event.kind:
7.     case "reply":   return { kind: "reply", message: event.message }
8.     case "abort":   return { kind: "abort", error: event.error }
9.     case "reflect":
10.      messages.push(assistantTurn(code), reflectionTurn(event.state, event.stdout, event.stderr))
11.      step++
12.    case "throw":   // uncaught exception in sandbox
13.      messages.push(assistantTurn(code), errorTurn(event.error))
14.      step++
15. return { kind: "exhausted" }
```

Key invariant: the sandbox **must** terminate via one of the three control fns. Any other exit (uncaught throw, OOM, permission denial from Deno itself) is fed back to the LLM as a "throw" event so it can self-correct.

## 5. Sandbox protocol (parent ↔ child)

Two message directions:

**Child → Parent** (control + tool calls):
```json
{ "type": "reply",  "message": "..." }
{ "type": "abort",  "error": "..." }
{ "type": "reflect","state": {...} }
{ "type": "tool_call", "id": "u1", "name": "fetchIssues", "args": {...} }
```

**Parent → Child** (tool results only):
```json
{ "type": "tool_result", "id": "u1", "ok": true,  "value": ... }
{ "type": "tool_result", "id": "u1", "ok": false, "error": "..." }
```

Framing: `length\n` + JSON line, on a dedicated FD (Deno supports extra pipes via `Deno.Command` `stdout: "piped"`; for RPC we'll use stdin/stdout and reserve real stdout for `console.log` capture in the transcript).

Recommended split: **stdin/stdout = RPC**, the LLM's `console.log` is captured by overriding `console` in the prelude to forward to a separate "log" RPC message. Cleaner than fighting stdout.

## 6. Module / library restriction

Deno restricts net, fs, env, run, ffi natively — but **not** which std-lib or third-party modules can be imported. Three options for module whitelisting:

- **A. Import map** — generate an import map that maps allowed specifiers to real URLs and leaves disallowed ones unresolved. Fast, declarative, fails at resolution time. Doesn't stop relative imports or dynamic `import()` from arbitrary URLs unless combined with `--no-remote` or a deno.json lockfile.
- **B. AST scan pre-execution** — parse code with a TS parser, walk import declarations + dynamic imports, reject if not in allowlist. Catches dynamic imports. Adds a parser dep.
- **C. Both** — AST scan as defense-in-depth, import map as the runtime backstop.

Recommendation: **C** for the MVP. Import map alone misses dynamic imports; AST alone misses transitive imports inside allowed modules.

## 7. Tool execution location

Two viable models:

- **In-sandbox**: tool source code is concatenated into the prelude. Tools run with the same restricted permissions as the LLM-generated code. Simple. But tools can't do anything privileged (no broader net, no secrets), which defeats the point of having tools.
- **Parent-RPC**: tools run in the parent process; sandbox stubs send a `tool_call` message and `await` the result. Tools have full host privileges; parent mediates auth, logging, rate limiting.

Recommendation: **Parent-RPC**. The whole point of sandboxing is that the LLM runs untrusted, while user tools are trusted host code. Mixing them defeats the model.

## 8. State across `reflect` calls

When the agent calls `reflect(state)`, the next iteration needs context. Options:

- **A. State object only**: pass `state` JSON forward; new iteration starts fresh except for the serialized state. Smallest token footprint.
- **B. Full transcript**: each iteration's code + stdout + state appended to the message history; LLM sees its own prior steps. Most context, biggest token bill.
- **C. Hybrid**: full transcript for the most recent N steps + summarized older steps + always-current `state`.

Recommendation for MVP: **B**. Keep it simple, observable, debuggable. Add summarization later when token costs justify it.

## 9. Permission config → Deno flags

| Config key | Deno flag |
|---|---|
| `permissions.net: string[]` | `--allow-net=host1,host2` (omit flag → no net) |
| `permissions.read: string[]` | `--allow-read=path1,path2` |
| `permissions.write: string[]` | `--allow-write=path1,path2` |
| `permissions.env: string[]` | `--allow-env=VAR1,VAR2` |
| `permissions.run: boolean` | `--allow-run` (boolean, MVP doesn't allowlist binaries) |
| `permissions.modules: string[]` | import map + AST scan (see §6) |

Default: deny everything. User opts in per category.

## 10. Code extraction strategy

LLM output options:
- **A. Markdown fenced block**: prompt instructs the model to wrap code in ` ```ts ... ``` `. Extractor pulls the first/last block. Standard, robust, model-agnostic.
- **B. Vercel AI SDK structured output** (`generateObject` with a schema like `{ code: string }`): cleaner but couples us to one provider's tool/JSON-mode quirks and can be flaky for long code on some models.
- **C. Both, with fallback**: try structured first, fall back to markdown.

Recommendation: **A** for MVP. Markdown is universal; structured can be added later as an optimization.

## 11. Prelude (injected into every sandbox)

Pseudocode:
```ts
// prelude.ts (generated per run)
const __rpc = await openRpc();         // stdin/stdout framed channel
async function reply(message: string): Promise<never> {
  await __rpc.send({ type: "reply", message });
  Deno.exit(0);
}
async function abort(error: string): Promise<never> {
  await __rpc.send({ type: "abort", error });
  Deno.exit(0);
}
async function reflect(state: unknown): Promise<never> {
  await __rpc.send({ type: "reflect", state });
  Deno.exit(0);
}
// One stub per registered tool:
async function fetchIssues(args: {...}): Promise<...> {
  return __rpc.call("tool_call", { name: "fetchIssues", args });
}
// Replace console.log with RPC-forwarded variant
console.log = (...a) => __rpc.send({ type: "log", level: "info", args: a });
// LLM-generated code appended below
```

## 12. System prompt skeleton

```
You are a code-action agent. You produce TypeScript code that runs in a Deno
sandbox. You DO NOT return tool calls. You return a single ```ts block.

You have three control functions; your code MUST exit through exactly one of them:
- reply(message: string)  — final answer to the user
- abort(error: string)    — refuse or fail because of missing capability/permission
- reflect(state: unknown) — pause and request another generation step with state

Permissions granted to your sandbox:
- network: api.github.com
- file read: ./cache
- file write: (none)
- modules:  std/encoding

If you need a capability not listed above, call abort() with a clear explanation.

Tools available (callable as async functions):
- fetchIssues(args: { repo: string; limit?: number }): Promise<Issue[]>
  Fetch open GitHub issues for a repo.

Task: <user task>

Prior steps: <transcript of prior code + stdout + state, if any>
```

## 13. MVP scope (what's IN, what's OUT)

**IN:**
1. `Agent` class with `.run()` returning a discriminated union result.
2. Vercel AI SDK integration (`generateText`).
3. Markdown code-block extraction.
4. Deno subprocess sandbox with permission compilation.
5. Three control functions (`reply`, `abort`, `reflect`).
6. Tool RPC (parent-side execution, zod schema validation).
7. Module allowlist via import map + AST scan.
8. Per-step transcript replay (option B from §8).
9. `maxSteps` cap with `exhausted` result.
10. Tests: unit (extractor, prompt, perm-compiler) + integration (real Deno subprocess, mock LLM).

**OUT (post-MVP):**
- Persistent sandbox process (each step spawns fresh).
- Streaming responses from the model.
- Multi-agent / agent-as-tool composition.
- Memory / RAG.
- Retry policies, exponential backoff.
- Cost / token accounting.
- Python tools, WASM, FFI.

## 14. Resolved decisions

1. ✅ Tool execution location — **Parent-RPC** (§7).
2. ✅ Module whitelisting — **Import map + AST scan** (§6).
3. ✅ State across reflect — **Full transcript** for MVP (§8).
4. ✅ Sandbox lifecycle — **Spawn-per-step + persistent per-session workspace** (see §14a).
5. ✅ Code extraction — **Markdown fenced ts block** (§10).
6. ✅ Imports in generated code — **Allowed, restricted to module allowlist + session lib**.

## 14a. Session persistence model (resolves Issue 4)

The sandbox process is still **spawned per step** (clean isolation, no state-reset complexity), but each agent run is bound to a `sessionId` and gets a persistent on-disk workspace:

```
.rex/sessions/<sessionId>/
  lib.ts          # agent-authored TypeScript module, rewritten via writeLib()
  storage.json    # KV store, accessed via host RPC (not direct fs)
  transcript.jsonl  # append-only log of step events (for resume / audit)
```

Three new host capabilities exposed in the prelude:

### a) Agent-authored library — `writeLib(source)`

The agent can emit a whole TypeScript module to `lib.ts` (full rewrite) for use by subsequent steps:

- **`writeLib(source: string): Promise<void>`** — host writes `source` verbatim to `.rex/sessions/<id>/lib.ts` as a real `.ts` file. Subsequent steps import its exports via `import { foo } from "session:lib"`.

Goes through RPC; the parent owns the file, validates the source through the same `ModuleGuard` AST scan as user code, and rejects writes that import disallowed modules. No partial-update API in the MVP — if the agent wants to add a helper, it rewrites the whole module (it has full prior content via the prompt-listed exports + transcript). This keeps the contract dead simple: one file, one writer, one operation.

The system prompt at every step lists the current `lib.ts` exports (names + signatures, extracted by the parent via AST) and the full source. The agent sees its accumulated toolkit and can extend or refactor it on the next `writeLib` call.

### b) Session storage — `storage`

```ts
storage.get(key: string): Promise<unknown | undefined>
storage.set(key: string, value: unknown): Promise<void>
storage.del(key: string): Promise<void>
storage.keys(): Promise<string[]>
```

Backed by `storage.json` on the host side, accessed only via RPC — sandbox never gets fs access to it. Soft size limit (e.g. 1 MB) to prevent runaway bloat. Listed in the prompt so the agent knows it exists.

### c) Importing the session lib

The import map auto-injects:
```json
{ "imports": { "session:lib": "./.rex/sessions/<id>/lib.ts" } }
```

Permission flags: `--allow-read=.rex/sessions/<id>` so imports resolve. Writes to `lib.ts` go through RPC, **not** through `--allow-write` in the sandbox — the agent never has direct fs write to its own lib (parent mediates and validates).

### Why this shape

- Spawn-per-step survives — still simple, still isolated, no in-process state-reset bug surface.
- Pinning gives the "long-lived feel" without the long-lived process: useful helpers compound across steps.
- Parent-mediated writes mean we can AST-validate every pin and refuse pins that try to escape the allowlist.
- Storage is structured (JSON), separate from code (lib.ts), separate from history (transcript.jsonl) — three clean concerns.
- Trivially resumable: a session can be re-opened by `sessionId` and the agent picks up its pinned lib + storage.

### Prompt addition (§12 extension)

```
Session workspace:
- You may rewrite your reusable helper module with `writeLib(source)`.
  Its exports are importable next step via `import { ... } from "session:lib"`.
  writeLib replaces the entire file — include any prior helpers you want
  to keep.
- You may persist data with `storage.{get,set,del,keys}`.
- Current lib.ts exports: <list of names + signatures, or "(empty)">
- Current lib.ts source:
  <full source, or "(empty)">
- Storage keys: <list, or "(empty)">
```

### Tests added for §16

- `writeLib` writes a real `.ts` file at `.rex/sessions/<id>/lib.ts`; reflect; verify exports importable next step.
- `writeLib` with source that imports a disallowed module → rejected with a clear error fed back to the LLM, file unchanged.
- `writeLib` rewrite preserves no prior content — last write wins (verifies the contract).
- Storage round-trip across steps.
- Session resume: open existing `sessionId`, verify lib.ts + storage.json load, transcript continues.
- Cross-session isolation: two sessions writing the same export name don't collide.

### Risks specific to §14a

- **Lib regression**: agent overwrites lib.ts and forgets to carry forward a helper it still needs. Mitigation: full source + exports listed in the prompt at every step so the model has what it needs to preserve.
- **Cross-session contamination**: must always namespace by `sessionId`; never share `lib.ts` between sessions. Test for this explicitly.
- **Disk growth**: long-lived sessions accumulate. Out-of-MVP, but document a `pruneSession(id)` utility for users.
- **Lib token cost**: surfacing full lib source in every prompt grows with the lib. Acceptable for MVP; a "summarize lib if larger than N" pass is a post-MVP optimization.

## 15. Repo layout (proposed)

```
rex-ai/
  deno.json                 # Deno config, tasks, lint rules
  src/
    agent.ts                # Agent class, loop
    prompt.ts               # PromptBuilder
    extractor.ts            # CodeExtractor
    sandbox.ts              # Sandbox spawner
    prelude.ts              # Prelude template + builder
    rpc.ts                  # Length-prefixed JSON framing
    tools.ts                # ToolRegistry, tool types, zod glue
    permissions.ts          # Config → Deno flags + import map
    module_guard.ts         # AST scan
    session.ts              # SessionStore: lib.ts + storage.json + transcript.jsonl
    types.ts                # Shared discriminated unions
  tests/
    extractor_test.ts
    prompt_test.ts
    permissions_test.ts
    module_guard_test.ts
    sandbox_integration_test.ts
    agent_integration_test.ts  # uses a fake model
  examples/
    github_issues.ts
  docs/
    plans/agent-library-mvp.md  # this file
```

## 16. Test strategy (pre-write so we don't shortchange it)

- **Extractor**: many fixtures (no fence, multiple fences, nested fences, no language tag, prose around it).
- **PromptBuilder**: golden file tests (snapshot the rendered prompt).
- **PermissionCompiler**: table-driven (config → expected flags).
- **ModuleGuard**: positive and negative cases for static + dynamic imports, allowed and disallowed.
- **RPC**: round-trip framing, malformed input, partial reads.
- **Sandbox integration**: spawn real Deno, run code that calls each control fn + each tool path + a deliberate throw + a permission-denied fetch.
- **Agent integration**: in-process `MockModel` that returns a scripted sequence of code blocks; verify reply/abort/reflect/throw/exhausted flows end to end.

## 17. Risks / sharp edges

- **Stdout collision**: LLM code calling `console.log` corrupts RPC framing if we use stdout. Mitigation: dedicated pipe, or override `console` in prelude.
- **Async never-returning control fns**: `reply/abort/reflect` must be marked `Promise<never>` and end in `Deno.exit`. If the LLM forgets to `await` them, code may continue running. Consider also wrapping the LLM code in a top-level async fn that fails if it returns without a control-fn call.
- **Hung sandbox**: a code path that awaits forever. Need a per-step wall-clock timeout.
- **Large state in `reflect`**: if state is multi-megabyte JSON, token budget explodes. Consider a soft size limit with a warning passed back to the LLM.
- **AST parser cost**: parsing every step's code adds latency. Recommend `@typescript-eslint/typescript-estree` or `swc` via wasm; benchmark before final pick.
- **Vercel AI SDK on Deno**: the SDK is published for Node; we need to verify Deno compatibility (npm: specifiers in Deno generally work but worth a smoke test on day 1).
