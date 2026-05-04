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
    run: false,                   // no subprocesses
    modules: ["std/encoding"],    // import allowlist (see §6)
  },
  sessionId: "abc123",            // persistent workspace across steps (see §14a)
  maxSteps: 8,
});

const result = await agent.run();
// → { kind: "reply", message: string }
//   | { kind: "abort", error: string }
//   | { kind: "exhausted", steps: number }
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
4.   code = CodeExtractor.extract(completion.text)        // throws on missing fence
5.   event = await Sandbox.run(code, prelude, permissions)
6.   switch event.kind:
7.     case "reply":             return { kind: "reply",  message: event.message }
8.     case "abort":             return { kind: "abort",  error: event.error }
9.     case "reflect":
10.      messages.push(assistantTurn(code), reflectionTurn(event.state, event.logs))
11.      step++
12.    case "permission_denied":  // Deno.errors.PermissionDenied caught by prelude
13.      messages.push(assistantTurn(code), permissionDeniedTurn(event))
14.      step++
15.    case "throw":              // any other uncaught exception in sandbox
16.      messages.push(assistantTurn(code), errorTurn(event.error, event.logs))
17.      step++
18. return { kind: "exhausted", steps: step }
```

Key invariant: the sandbox **must** terminate via one of the three control fns. Any other exit gets categorized:
- `Deno.errors.PermissionDenied` → `permission_denied` event (structured: which permission, which target).
- All other uncaught throws → `throw` event.
- Process killed (timeout, OOM, exit code != 0 with no control message) → `throw` event with a synthetic error message.

In every non-terminal case the LLM gets a chance to self-correct on the next step.

## 5. Sandbox protocol (parent ↔ child)

**Single channel**: stdin/stdout carry framed JSON RPC, nothing else. Real stdout passthrough is gone — `console.{log,warn,error}` are overridden in the prelude to emit `log` events. The parent reconstructs a per-step `logs[]` array from these events.

Framing: each frame is `length\n` (decimal byte count) followed by the JSON payload. Robust to partial reads.

**Child → Parent**:
```json
{ "type": "reply",  "message": "..." }
{ "type": "abort",  "error": "..." }
{ "type": "reflect","state": <json> }
{ "type": "tool_call", "id": "u1", "name": "fetchIssues", "args": {...} }
{ "type": "log", "level": "info"|"warn"|"error", "args": [...] }
{ "type": "permission_denied", "permission": "net"|"read"|"write"|..., "target": "..." }
{ "type": "storage_get" | "storage_set" | "storage_del" | "storage_keys", "id": "...", ... }
{ "type": "write_lib", "id": "...", "source": "..." }
```

**Parent → Child** (responses to the request-style messages above):
```json
{ "type": "tool_result",    "id": "u1", "ok": true,  "value": ... }
{ "type": "tool_result",    "id": "u1", "ok": false, "error": "..." }
{ "type": "storage_result", "id": "...", "ok": true, "value": ... }
{ "type": "write_lib_result","id": "...", "ok": true }
{ "type": "write_lib_result","id": "...", "ok": false, "error": "..." }
```

JSON serialization rules (host and sandbox both): values are passed through `JSON.stringify`. `undefined` becomes "missing key"; `Date` becomes ISO string (caller's responsibility); `BigInt` and `Function` are rejected with a clear error. Tool authors are expected to return JSON-safe values.

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
| `permissions.read: string[]` | `--allow-read=path1,path2` (auto-includes `.rex/sessions/<id>` for `session:lib`) |
| `permissions.write: string[]` | `--allow-write=path1,path2` |
| `permissions.run: boolean` | `--allow-run` (boolean, MVP doesn't allowlist binaries) |
| `permissions.modules: string[]` | import map + AST scan (see §6) |

Default: deny everything. User opts in per category.

`env` is **out of MVP**: tools execute in the parent process, so the sandbox rarely needs `Deno.env`. Dropping it shrinks the trust surface. Easy to add later if a use case appears.

## 10. Code extraction strategy

LLM output options:
- **A. Markdown fenced block**: prompt instructs the model to wrap code in ` ```ts ... ``` `. Extractor pulls the first/last block. Standard, robust, model-agnostic.
- **B. Vercel AI SDK structured output** (`generateObject` with a schema like `{ code: string }`): cleaner but couples us to one provider's tool/JSON-mode quirks and can be flaky for long code on some models.
- **C. Both, with fallback**: try structured first, fall back to markdown.

Recommendation: **A** for MVP. Markdown is universal; structured can be added later as an optimization.

**Fence leniency:** accept ` ```ts ` and ` ```typescript `. Reject everything else — no fence, wrong language tag, or no code block at all → throw a clear `NoCodeBlockError`. Surfacing this back to the LLM as a step error is post-MVP; for now it's a hard fail of `agent.run()`.

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
  // size-cap enforced parent-side; rejected reflects come back as a tool-style error
  await __rpc.send({ type: "reflect", state });
  Deno.exit(0);
}
async function writeLib(source: string): Promise<void> {
  const r = await __rpc.call("write_lib", { source });
  if (!r.ok) throw new WriteLibError(r.error);
}
const storage = {
  get:  (k: string) => __rpc.call("storage_get",  { key: k }).then(unwrap),
  set:  (k: string, v: unknown) => __rpc.call("storage_set",  { key: k, value: v }).then(unwrap),
  del:  (k: string) => __rpc.call("storage_del",  { key: k }).then(unwrap),
  keys: ()          => __rpc.call("storage_keys", {}).then(unwrap),
};
// One stub per registered tool — args validated parent-side with zod:
async function fetchIssues(args: {...}): Promise<...> {
  const r = await __rpc.call("tool_call", { name: "fetchIssues", args });
  if (!r.ok) throw new ToolError(r.error);   // includes zod issues if validation failed
  return r.value;
}
// Forward all console levels through RPC; no real stdout passthrough.
for (const level of ["log","info","warn","error","debug"] as const) {
  console[level] = (...a) => __rpc.sendNoWait({ type: "log", level, args: a });
}
// Catch PermissionDenied from the LLM body and surface it as a typed event.
try {
  // LLM-generated code appended below, wrapped in an async IIFE
  await (async () => {
    /* <<<LLM CODE>>> */
  })();
  // If we get here, the LLM forgot to call a control function.
  await __rpc.send({ type: "abort", error: "agent code returned without calling reply/abort/reflect" });
  Deno.exit(0);
} catch (e) {
  if (e instanceof Deno.errors.PermissionDenied) {
    await __rpc.send({ type: "permission_denied", permission: classify(e), target: extractTarget(e) });
  } else {
    await __rpc.send({ type: "throw", error: String(e?.stack ?? e) });
  }
  Deno.exit(0);
}
```

## 12. System prompt skeleton

```
You are a code-action agent. You produce TypeScript code that runs in a Deno
sandbox. You DO NOT return tool calls. You return a single ```ts block.

You have three control functions; your code MUST exit through exactly one of them:
- reply(message: string)  — final answer to the user
- abort(error: string)    — refuse or fail because of missing capability/permission
- reflect(state: unknown) — pause and request another generation step with state

Calling a tool with arguments that fail validation throws a ToolError with the
specific zod issues. Catch and recover, or call abort() if unrecoverable.

Permissions granted to your sandbox:
- network: api.github.com
- file read: ./cache
- file write: (none)
- modules:  std/encoding

If you need a capability not listed above, call abort() with a clear explanation.
A disallowed fetch / read / write will surface as a permission_denied event on
the next step rather than a thrown exception you can catch.

Tools available (callable as async functions):
- fetchIssues(args: { repo: string; limit?: number }): Promise<Issue[]>
  Fetch open GitHub issues for a repo.

Task: <user task>

Prior steps: <transcript of prior code + logs + state + errors, if any>
```

Tool signatures are rendered from each tool's zod schema via `zod-to-ts` (chosen for the small subset MVP needs: object / string / number / boolean / array / optional / enum / union of literals). Tool author is the source of truth — if the rendered TS doesn't match what they want the LLM to see, they can override with an explicit `tsSignature` field on the tool definition.

## 13. MVP scope (what's IN, what's OUT)

**Day-0 gate (before any other code):** smoke-test Vercel AI SDK on Deno — minimal `npm:ai` import + one `generateText` call. If it doesn't work cleanly, that gets resolved before scaffolding starts.

**IN:**
1. `Agent` class with `.run()` returning a discriminated union result.
2. Vercel AI SDK integration (`generateText`).
3. Markdown code-block extraction (accepts `ts` and `typescript`; hard-fails otherwise).
4. Deno subprocess sandbox with permission compilation.
5. Three control functions (`reply`, `abort`, `reflect`) + reserved-name enforcement.
6. Tool RPC (parent-side execution, zod schema validation, `ToolError` on failure).
7. Module allowlist via import map + AST scan, regenerated per step.
8. Per-step transcript replay (option B from §8) with size caps (§17).
9. `writeLib` + `storage` + session bootstrap + `.lock` concurrency guard.
10. Structured `permission_denied` event (separate from `throw`).
11. `maxSteps` cap with `exhausted` result.
12. Tests: unit (extractor, prompt, perm-compiler, module-guard, RPC framing) + integration (real Deno subprocess, mock LLM).

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
4. ✅ Sandbox lifecycle — **Spawn-per-step + persistent per-session workspace** (§14a).
5. ✅ Code extraction — **Markdown fenced ts/typescript block; hard-fail on missing fence** (§10).
6. ✅ Imports in generated code — **Allowed, restricted to module allowlist + session:lib**.
7. ✅ RPC channel — **stdin/stdout only; console redirected via RPC log events** (§5, §11).
8. ✅ Permission-denied surfacing — **structured `permission_denied` event** (§4, §11).
9. ✅ `env` permission — **dropped from MVP** (§9).
10. ✅ Reserved tool names — **`reply` / `abort` / `reflect` / `writeLib` / `storage` / `console`** (§17).
11. ✅ Tool signature rendering — **`zod-to-ts` with optional `tsSignature` override** (§12).
12. ✅ Tool arg validation failure — **stub throws `ToolError` carrying zod issues** (§11, §12).
13. ✅ Size caps — **defaults in §17, all configurable on `Agent`**.
14. ✅ Session resume / concurrency — **state inherits, history doesn't; `.lock` file enforces single writer** (§14a).

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

A per-session import map lives at `.rex/sessions/<id>/import_map.json` and is **regenerated at the start of every step** (the user's allowlist may change between calls). The parent passes it via `--import-map=<path>`. It contains the user's allowed module mappings plus:
```json
{ "imports": { "session:lib": "./lib.ts" } }
```

Permission flags: `.rex/sessions/<id>` is auto-added to `--allow-read` so imports resolve. Writes to `lib.ts` go through RPC, **not** through `--allow-write` in the sandbox — the agent never has direct fs write to its own lib (parent mediates and validates).

**Bootstrapping**: `SessionStore.init()` (called by `Agent` before step 1) creates `.rex/sessions/<id>/lib.ts` with `export {};` if it doesn't exist, plus an empty `storage.json` and `transcript.jsonl`. This guarantees `import { ... } from "session:lib"` resolves cleanly even on a brand-new session.

### Resume + concurrency contract

- **Resume**: calling `new Agent({ sessionId: "X", task: ... }).run()` with an existing `sessionId` inherits `lib.ts` + `storage.json` from disk. The in-memory `messages` array starts fresh (does **not** replay `transcript.jsonl` into the prompt). Independent runs share **state**, not **history**.
- **Concurrency**: a `.lock` file in the session directory is taken when `run()` starts and released on exit. A second concurrent run with the same `sessionId` is rejected with `SessionLockedError`. Stale locks are cleared if the holder PID is gone.
- **Sessionless mode**: omitting `sessionId` auto-generates an ephemeral one and deletes the workspace on `run()` exit (so you can use the library without thinking about persistence).

### Why this shape

- Spawn-per-step survives — still simple, still isolated, no in-process state-reset bug surface.
- Agent-authored helpers give the "long-lived feel" without a long-lived process: useful helpers compound across steps.
- Parent-mediated writes mean we can AST-validate every `writeLib` and refuse code that tries to escape the allowlist.
- Storage is structured (JSON), separate from code (lib.ts), separate from history (transcript.jsonl) — three clean concerns.
- Trivially resumable: a session can be re-opened by `sessionId` and the agent picks up its helpers + storage.

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

- **Extractor**: ts fence, typescript fence, multiple fences (last wins), nested fences, no fence (hard fail), wrong language tag (hard fail), prose around block.
- **PromptBuilder**: golden file tests (snapshot the rendered prompt for: no tools, multiple tools, with prior steps, with current lib.ts, with storage keys).
- **PermissionCompiler**: table-driven (config → expected flags + import-map content).
- **ModuleGuard**: static + dynamic imports, allowed + disallowed, also for `writeLib` source.
- **RPC**: round-trip framing, malformed input, partial reads, oversize frame rejection.
- **Reserved-name guard**: `Agent` rejects a tool named `reply` / `abort` / `reflect` / `writeLib` / `storage` / `console`.
- **Sandbox integration**: spawn real Deno, run code that calls each control fn + each tool path + a deliberate throw + a permission-denied fetch (verify `permission_denied` event) + a non-control-fn return (verify auto-abort) + per-step timeout.
- **Size caps**: logs over 64 KB truncate; reflect over 256 KB rejected; tool result over 256 KB throws `ToolResultTooLargeError`; writeLib over 64 KB rejected; storage quota.
- **Session lifecycle**: bootstrap creates `lib.ts` / `storage.json` / `transcript.jsonl`; resume inherits state; sessionless mode cleans up; `.lock` blocks concurrent runs and clears stale locks.
- **writeLib**: writes a real `.ts` file; disallowed import in source → rejected, file unchanged; rewrite is full-replace.
- **Cross-session isolation**: two sessions writing the same export name don't collide.
- **Agent integration**: in-process `MockModel` that returns a scripted sequence of code blocks; verify reply / abort / reflect / permission_denied / throw / exhausted flows end to end.

## 17. Risks / sharp edges + size caps

**Size caps (defaults; configurable on `Agent`):**

| Limit | Default | On exceed |
|---|---|---|
| Logs per step (total bytes) | 64 KB | Truncate, append `…[truncated]` marker, surface to LLM |
| `reflect` state JSON | 256 KB | Reject the reflect; feed back `state too large` error |
| Single tool result JSON | 256 KB | Reject; tool stub throws `ToolResultTooLargeError` |
| `lib.ts` source | 64 KB | `writeLib` rejects; surfaces as `WriteLibError` |
| `storage.json` total | 1 MB | `storage.set` rejects with quota error |
| Per-step wall-clock | 60 s | Kill sandbox; emit `throw` event with timeout reason |

**Other sharp edges:**

- **RPC framing integrity**: with stdin/stdout being the only channel, any direct `Deno.stdout.write` from LLM code would corrupt frames. Mitigation: prelude redirects `console.*`; we also document that direct `Deno.stdout` writes are unsupported (and should be caught by the AST guard if we want extra safety post-MVP).
- **Async never-returning control fns**: `reply/abort/reflect` are `Promise<never>` and end in `Deno.exit`. The prelude wraps the LLM body so that if execution returns without calling one of them, the parent gets a synthesized `abort` event. No silent hangs from forgotten `await`s.
- **AST parser pick**: TBD between `@typescript-eslint/typescript-estree` and `swc` wasm. Benchmark before final pick; not a plan blocker.
- **Vercel AI SDK on Deno**: covered by the day-0 gate in §13.
- **Reserved tool names**: `reply`, `abort`, `reflect`, `writeLib`, `storage`, `console` are reserved. `Agent` constructor rejects user tools that collide.
- **Disk growth on long-lived sessions**: out of MVP, but `pruneSession(id)` and `listSessions()` utilities are noted for v0.2.
