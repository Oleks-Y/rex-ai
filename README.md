# rex-ai

> **Status: experimental MVP (v0.1).** APIs will change. Built as a research
> exercise in code-action agents on Deno; not production-hardened.

A small TypeScript library for building **code-action agents** — agents
where the LLM writes a TypeScript snippet each step and that snippet runs
inside a permission-restricted Deno subprocess. Inspired by
[smolagents](https://github.com/huggingface/smolagents); built on the
[Vercel AI SDK](https://sdk.vercel.ai/) and Deno's native sandbox.

## Why code-action?

Most agents return a structured tool call per step. A code-action agent
returns a *script*, so one LLM call can chain operations, branch, loop,
parse, transform — without round-tripping per tool. Cheaper, more
expressive, fewer tokens. The cost is that you have to run untrusted
code, which is exactly what Deno's permission flags are for.

## What you get

- An `Agent` class that loops `generate → extract code → run in sandbox →
  observe → repeat` until the script `return`s `reply()`, `abort()`, or
  you hit `maxSteps`.
- A Deno subprocess sandbox with **deny-by-default** permissions that
  you opt into per agent (`net`, `read`, `write`, `run`, `modules`).
- **Parent-side tools** defined with zod schemas — the sandbox calls
  them via RPC, so the LLM-generated code stays unprivileged while your
  tool handlers can do whatever they need.
- **Per-session workspace** at `.rex/sessions/<id>/`: an
  agent-authored `lib.ts` (helpers it can extend across steps), a
  KV `storage` API, and a transcript log.
- An AST module-allowlist (defense-in-depth on top of import maps) so
  the LLM can only import what you've allowed.
- A small CLI runner (`src/cli.ts`) that loads an agent factory file
  and prints each step.

## Requirements

- [Deno](https://deno.com/) 1.45+ (uses `npm:` and `jsr:` specifiers).
- An API key for whichever model you wire up (the examples use
  `npm:@ai-sdk/openai`, so `OPENAI_API_KEY`).

## Quick start

```ts
// my_agent.ts
import { Agent, defineTool } from "jsr:@rex-ai/agent";
import { openai } from "npm:@ai-sdk/openai@2";
import { z } from "npm:zod@4";

const fetchIssues = defineTool({
  name: "fetchIssues",
  description: "Fetch open issues for a GitHub repo. Returns title + number.",
  schema: z.object({
    repo: z.string().describe("owner/name"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  handler: async ({ repo, limit }) => {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=open&per_page=${limit}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const issues = await r.json() as Array<{ number: number; title: string }>;
    return issues.map((i) => ({ number: i.number, title: i.title }));
  },
});

const result = await new Agent({
  model: openai("gpt-5-nano"),
  task: "Summarize the latest open issues in denoland/deno.",
  tools: [fetchIssues],
  permissions: { net: ["api.github.com"] },
  maxSteps: 4,
}).run();

console.log(result);
// → { kind: "reply", message: "..." }
//   | { kind: "abort", error: "..." }
//   | { kind: "exhausted", steps: number }
```

Run it:

```sh
OPENAI_API_KEY=... deno run \
  --allow-read --allow-write --allow-env --allow-sys \
  --allow-run --allow-net \
  my_agent.ts
```

The *parent* needs broad Deno permissions because it spawns subprocesses
and runs your tool handlers. The *sandboxed agent code* only gets what
you list in `permissions` — in this example, network access to
`api.github.com` and nothing else.

## CLI

A tiny runner is included for one-shot usage:

```sh
OPENAI_API_KEY=... deno run -A src/cli.ts \
  --agent examples/email.ts \
  --session inbox \
  -- "Send an email to alice@example.com saying hi."
```

Reusing `--session <id>` continues the same workspace (the agent's
`lib.ts`, `storage`, and transcript persist under `.rex/sessions/<id>/`).
The `--agent` file must default-export a factory:

```ts
// my_factory.ts
import { Agent } from "jsr:@rex-ai/agent";
import type { AgentFactoryInput } from "jsr:@rex-ai/agent/cli";

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    model: /* ... */,
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    tools: [/* ... */],
    permissions: { /* ... */ },
  });
}
```

See `examples/` for working factories.

## Examples

| File | What it shows |
|---|---|
| [`examples/random_number.ts`](examples/random_number.ts) | Minimal agent, zero tools, zero permissions. |
| [`examples/github_issues.ts`](examples/github_issues.ts) | Tool with a zod schema + scoped network permission. |
| [`examples/email.ts`](examples/email.ts) | "Tools = privilege" pattern: zero sandbox permissions, all I/O through a parent-side tool. |

## The control contract (what the LLM writes)

Each step the model emits a single ` ```ts ` block whose top-level
**returns** one of three control values:

```ts
return reply("the answer to the user");
return abort("missing capability X — please grant ...");
return reflect({ /* state to carry into the next step */ });
```

`reply` / `abort` / `reflect` are synchronous value constructors. The
sandbox waits for the body to fully resolve, drains any in-flight tool
calls and log writes, then dispatches the terminal frame to the parent.
This is the safe ordering: a `sendEmail` tool call kicked off without
`await` still finishes before the run ends.

Calling them without `return` also works (the most-recent call wins),
but `return` is the canonical pattern.

## Security model in one paragraph

The Deno subprocess running the LLM's code is started with **only** the
flags compiled from your `permissions` config (everything denied by
default). Tools run in the *parent* process via RPC over stdin/stdout, so
they can do privileged things the sandbox can't. A static AST scan
rejects imports outside your `modules` allowlist before each step. The
sandbox's `console.*` is redirected through RPC frames; raw
`Deno.stdout` writes from generated code would corrupt the channel and
are unsupported. Per-step wall-clock and per-payload size caps protect
against runaway steps; defaults are in `src/types.ts` (`DEFAULT_SIZE_CAPS`).

This is an MVP. Don't expose it to untrusted task input on a host you
care about without a hardening pass.

## Project layout

```
src/
  agent.ts          # Loop: generate → extract → sandbox → observe → repeat
  prompt.ts         # System-prompt builder
  extractor.ts      # Pulls ```ts code blocks from model output
  sandbox.ts        # Spawns the Deno subprocess
  prelude.ts        # Code injected into every sandbox (reply/abort/reflect/RPC stubs)
  rpc.ts            # Length-prefixed JSON framing
  tools.ts          # Tool registry + zod glue
  permissions.ts    # Config → Deno CLI flags + import map
  module_guard.ts   # AST scan for the import allowlist
  session.ts        # .rex/sessions/<id>/ workspace (lib.ts + storage + transcript)
  zod_to_ts.ts      # Renders tool signatures for the prompt
  cli.ts            # The `rex` runner
  types.ts          # Shared discriminated unions
examples/
tests/
  unit/             # extractor, prompt, permissions, module guard, rpc, session, tools
  integration/      # real Deno subprocess + scripted mock model
```

## Running the tests

```sh
deno task test           # full suite (needs broad permissions to spawn subprocesses)
deno task test:unit      # unit only
deno task test:integration
deno task lint
deno task fmt
deno task check
```

## Roadmap-ish (post-MVP)

Things explicitly out of scope today: streaming model output,
agent-as-tool composition, retries / backoff, token-cost accounting,
RAG, memory, persistent sandbox process, Python tools, WASM, FFI.

PRs and issues welcome — but heads up that the API surface is still
moving.

## License

[MIT](LICENSE).
