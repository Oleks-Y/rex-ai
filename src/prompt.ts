// PromptBuilder — renders the system prompt + per-step transcript that the
// agent sends to the LLM.
//
// Per §12 + §14a:
//   - Always include the code-action contract + the three control fns.
//   - List tools with name + signature (zod-to-ts) + description.
//   - Render the granted permissions explicitly.
//   - Surface session lib exports + full source + storage keys (so the
//     model knows what helpers and KV state it already has).
//   - Append prior steps (full transcript per §8 option B): each prior
//     step's code, log lines, terminal event, and any error.
//
// The output is a single string used as the system + user message body; the
// Agent decides how to slot it into the message history.

import type { ToolDescription } from "./tools.ts";
import type { PermissionsConfig, SandboxEvent } from "./types.ts";
import { zodToTs } from "./zod_to_ts.ts";

export interface PriorStep {
  code: string;
  event: SandboxEvent;
}

export interface SessionSnapshot {
  /** Names of currently exported symbols from `session:lib`. */
  libExports: string[];
  /** Current `lib.ts` source. Empty (or "export {};") when unused. */
  libSource: string;
  /** Currently-set storage keys. */
  storageKeys: string[];
}

export interface PromptInput {
  task: string;
  tools: ToolDescription[];
  permissions: PermissionsConfig | undefined;
  session: SessionSnapshot;
  priorSteps: PriorStep[];
  /** When true, render documentation for the persistent-session-only
   *  `scheduleWakeup` and `tasks` globals. Off by default (per-step
   *  path doesn't expose them). */
  wakeupsEnabled?: boolean;
}

export const PromptBuilder = {
  /** Render the full prompt body (system + state + transcript + task). */
  build(input: PromptInput): string {
    return [
      headerBlock(),
      input.wakeupsEnabled === true ? wakeupsBlock() : "",
      permissionsBlock(input.permissions),
      toolsBlock(input.tools),
      sessionBlock(input.session),
      priorStepsBlock(input.priorSteps),
      taskBlock(input.task),
    ].filter((s) => s.length > 0).join("\n\n");
  },
};

// ── blocks ────────────────────────────────────────────────────────────────

function headerBlock(): string {
  return [
    "You are a code-action agent. You produce TypeScript code that runs in a",
    "Deno sandbox. You DO NOT return tool calls. You return a single ```ts",
    "block.",
    "",
    "Your code MUST end by RETURNING exactly one of these control values:",
    "  - return reply(message: string)   — final answer to the user",
    "  - return abort(error: string)     — refuse / fail when capability is missing",
    "  - return reflect(state: unknown)  — pause and request another generation step",
    "",
    "These are synchronous value constructors, not async actions. Prefer the",
    "`return` form — it makes it obvious that nothing else runs after. (As a",
    "fallback, calling them without `return` also works: the most-recent call",
    "wins. But `return` is the canonical pattern.)",
    "",
    "Hard rules — these come up surprisingly often:",
    "  - reply, abort, reflect, writeLib, storage, and your tools are ALREADY",
    "    in scope. Do NOT redeclare them with `declare function`, `function`,",
    "    `const`, or `let`. Do NOT look them up via `globalThis`.",
    "  - Do NOT wrap your body in a top-level async IIFE — your code is",
    "    already inside one. Just write statements at the top level and",
    "    `return reply(...)` at the end.",
    "  - Always `await` tool calls (e.g. `await sendEmail({...})`). A",
    "    fire-and-forget tool call still executes parent-side, so don't call",
    "    a side-effecting tool unless you really mean to.",
    "",
    "Calling a tool with arguments that fail validation throws a ToolError",
    "carrying the specific zod issues. Catch and recover, or `return abort()`.",
    "",
    "A disallowed fetch / read / write / import surfaces as a permission_denied",
    "event on the next step rather than a thrown exception you can catch.",
    "",
    "How to work effectively across steps:",
    "",
    "  - There is NO user between steps. reflect() does not pause for human",
    "    input — it hands the state back to YOU (the same model) for another",
    "    generation. The user only ever sees the string you pass to reply()",
    "    or abort(); reflect state and console.logs are model-internal. So:",
    "      * Don't write \"please provide X\" inside reflect() and expect a",
    "        reply — you'll just see your own question on the next step and",
    "        loop until maxSteps is hit.",
    "      * If you need information from the user, call reply() with the",
    "        question (this ends the run; the user will start a new run with",
    "        the answer) OR abort() declaring exactly what's missing.",
    "      * If a required capability or tool isn't available, abort() —",
    "        don't reflect() hoping the situation changes. It won't.",
    "",
    "  - Verify before you reply, but don't fabricate steps. Before calling",
    "    reply() with data, you must have actually INSPECTED that data — i.e.",
    "    the relevant fields appear in a prior step's logs or reflect state",
    "    you can read in this step's transcript. Acceptable to reply() in one",
    "    step ONLY when there is no data to inspect: refusing the task,",
    "    asking the user a clarifying question, or answering a pure-knowledge",
    "    question that uses no tools. Otherwise: gather → reflect with logs →",
    "    review on the next step → reply.",
    "",
    "  - Steps are cheap. Prefer two careful steps over one guess. When you",
    "    don't know the exact shape of a tool's output, a file's contents, or",
    "    a piece of session state, do a small READ step first: log the relevant",
    "    slice with console.log, `return reflect(...)` with just the keys you",
    "    care about, then act on the next step with the real shape in hand.",
    "",
    "  - Verify side effects. After any tool call that writes, sends, or",
    "    mutates external state, verify with a follow-up read on the next step",
    "    before calling reply(). \"I called sendEmail and it didn't throw\" is",
    "    weaker evidence than \"I called sendEmail, then listed drafts and saw",
    "    the message I sent.\"",
    "",
    "  - Use console.log liberally. Anything you log is captured and replayed",
    "    verbatim in the NEXT step's transcript under \"Logs from this step\",",
    "    so it's your primary tool for inspecting data you don't yet understand —",
    "    much better than guessing field names. Logs have a per-step byte budget;",
    "    if you see a \"[log truncated]\" marker, log a smaller slice next time",
    "    (one record, selected fields) rather than dumping the whole payload.",
    "",
    "  - Use writeLib for anything you'll reuse. If you wrote a parser or",
    "    formatter inline and you'll need it again, move it into lib.ts so the",
    "    next step can `import { ... } from \"session:lib\"` instead of",
    "    redefining it.",
    "",
    "  - Don't one-shot. If the task involves unknown data, branching logic, or",
    "    multiple tools, plan to take several reflect() steps. Returning reply()",
    "    too early — before you've confirmed the result is correct — is a common",
    "    failure mode worth resisting.",
    "",
    "  - Iterate, don't retry blindly. If a step failed, the prior-steps",
    "    transcript tells you why. Change approach based on the error; do not",
    "    resubmit the same code.",
    "",
    "  - Abort decisively when the task can't be completed honestly. abort()",
    "    is the right call — preferred over a vague reply() — when:",
    "      * a required capability is missing from the permissions grant (a",
    "        permission_denied event you can't route around);",
    "      * a required tool isn't registered (no way to fetch / send / read",
    "        what the task asks for);",
    "      * you've tried two distinct approaches and both failed for reasons",
    "        the transcript makes clear are not retry-able;",
    "      * the task is ambiguous or contradictory in a way that any answer",
    "        would be a guess.",
    "    abort() is NOT for one-off transient errors (network blip, malformed",
    "    response on a single call) — those should turn into another reflect()",
    "    step with a different tactic. The error string in abort() is your",
    "    only message to the user, so make it specific: what was missing, what",
    "    you tried, and what would unblock you (e.g. \"need fs.read for",
    "    /etc/hosts but only net.fetch is granted\"). A good abort() is more",
    "    useful than a hallucinated reply().",
  ].join("\n");
}

function permissionsBlock(p: PermissionsConfig | undefined): string {
  const net = p?.net?.length ? p.net.join(", ") : "(none)";
  const read = p?.read?.length ? p.read.join(", ") : "(none beyond session workspace)";
  const write = p?.write?.length ? p.write.join(", ") : "(none)";
  const run = p?.run ? "yes" : "no";
  const modules = p?.modules?.length ? p.modules.join(", ") : "(none beyond session:lib)";
  return [
    "Permissions granted to your sandbox:",
    `  - network:    ${net}`,
    `  - file read:  ${read}`,
    `  - file write: ${write}`,
    `  - subprocess: ${run}`,
    `  - modules:    ${modules}`,
    "",
    "If you need a capability not listed, call abort() with a clear explanation.",
  ].join("\n");
}

function wakeupsBlock(): string {
  return [
    "Async wakeups (persistent-session mode):",
    "",
    "Two extra globals are available alongside reply/abort/reflect:",
    "",
    "  scheduleWakeup<T>(thunk: () => Promise<T> | T, opts?: { reason?: string }): TaskHandle<T>",
    "  scheduleWakeup.delay(ms: number, opts?: { reason?: string }): TaskHandle<void>",
    "",
    "  tasks.list(): TaskHandle[]            — every scheduled wakeup, any status",
    "  tasks.pending(): TaskHandle[]         — only pending ones",
    "  tasks.get(id: string): TaskHandle | null",
    "  tasks.cancel(id: string, reason?: string): boolean",
    "",
    "TaskHandle = { id, status: 'pending' | 'resolved' | 'rejected' | 'cancelled',",
    "               reason, wakeupKind, done: Promise<T>, cancel(reason?: string) }",
    "",
    "What scheduleWakeup is for:",
    "  - Kick off a long-running operation, return reply() to the user, then be",
    "    woken up later when the operation resolves and continue the conversation.",
    "  - The TaskHandle and its `done` promise SURVIVE across steps. In a later",
    "    step you can `await tasks.get(id).done` to retrieve the value.",
    "",
    "Wakeup-driven turns (READ CAREFULLY — these are NOT user requests):",
    "  - When a wakeup fires, the next prompt has a synthetic prior step:",
    "      { kind: 'reflect', state: { __wakeup: { id, status, detail } } }",
    "    There is NO `state` global at runtime — that object lives only in the",
    "    PRIOR-STEPS history above. Read it from there. Do not write",
    "    `state.__wakeup` in your code; it will throw `state is not defined`.",
    "    Find the wakeup id by inspecting the most recent synthetic step in",
    "    'Prior steps:' and then call `tasks.get('<that id>')`.",
    "  - A wakeup-driven turn is a CONTINUATION, not a re-initialization. Do",
    "    NOT re-run the original setup code. Do NOT call reply() with your",
    "    original confirmation message again. The user already received that.",
    "    Either: (a) handle the wakeup and reply with new info, (b) reflect()",
    "    if there's nothing user-visible to say yet, or (c) schedule the next",
    "    iteration of a recurring job and reflect().",
    "  - For recurring jobs, write the body inside the thunk you pass to",
    "    scheduleWakeup. The thunk runs in-sandbox each interval; it can call",
    "    storage.set / scheduleWakeup.delay etc. on its own. When it resolves",
    "    you get a wakeup turn; usually you just reflect() (no new user reply).",
    "",
    "Pattern (typical one-shot):",
    "  // step N — schedule + reply",
    "  const h = scheduleWakeup(() => longTool({...}), { reason: 'fetching X' });",
    "  return reply('Working on it — I will follow up.');",
    "",
    "  // step N+K — wakeup-driven turn (synthetic __wakeup in prior steps)",
    "  const t = tasks.get('w_3');",
    "  if (t?.status === 'resolved') {",
    "    const value = await t.done;",
    "    return reply('Result: ' + JSON.stringify(value));",
    "  }",
    "",
    "Pattern (recurring job, e.g. 'every 30s'):",
    "  // initial step — schedule a self-rescheduling thunk and reply once",
    "  const tick = async () => {",
    "    const batch = makeBatch();",
    "    const prior = (await storage.get('batches')) as unknown[] ?? [];",
    "    await storage.set('batches', [...(prior as unknown[]), batch]);",
    "    scheduleWakeup.delay(30_000, { reason: 'next tick' });",
    "  };",
    "  scheduleWakeup(tick, { reason: 'first tick' });",
    "  return reply('Recurring job started.');",
    "",
    "  // wakeup-driven turn — usually just reflect, do NOT re-set-up the job:",
    "  return reflect({ note: 'tick completed' });",
    "",
    "Don't await the handle's done promise SYNCHRONOUSLY in the scheduling step",
    "unless you want that step to block until it resolves — that defeats the",
    "purpose. Reply first, then look up the value in the wakeup-driven turn.",
  ].join("\n");
}

function toolsBlock(tools: ToolDescription[]): string {
  if (tools.length === 0) {
    return "Tools: (none registered).";
  }
  const lines: string[] = ["Tools available (callable as async functions):"];
  for (const t of tools) {
    const sig = t.tsSignature ?? renderSignature(t);
    lines.push(`  - ${t.name}${sig}`);
    if (t.description) lines.push(`      ${t.description}`);
  }
  return lines.join("\n");
}

function renderSignature(t: ToolDescription): string {
  // Args type from zod schema. Result is unknown (we don't know what the
  // handler returns at the type level — the description should explain it).
  const args = zodToTs(t.schema);
  return `(args: ${args}): Promise<unknown>`;
}

function sessionBlock(s: SessionSnapshot): string {
  const exports = s.libExports.length === 0 ? "(empty)" : s.libExports.join(", ");
  const src = s.libSource.trim() === "" || s.libSource.trim() === "export {};"
    ? "(empty)"
    : s.libSource.trimEnd();
  const storage = s.storageKeys.length === 0 ? "(empty)" : s.storageKeys.join(", ");
  return [
    "Session workspace:",
    "  - You may rewrite your reusable helper module with `writeLib(source)`.",
    '    Its exports are importable next step via `import { ... } from "session:lib"`.',
    "    writeLib replaces the entire file — include any prior helpers you want to keep.",
    "  - You may persist data with `storage`. ALL FOUR METHODS ARE ASYNC and",
    "    return Promises — you MUST `await` them:",
    "      storage.get(key: string): Promise<unknown | undefined>",
    "      storage.set(key: string, value: unknown): Promise<void>",
    "      storage.del(key: string): Promise<void>",
    "      storage.keys(): Promise<string[]>",
    "    Forgetting `await` will hand you a Promise object and operations like",
    "    `.push` or `.length` on it will throw at runtime.",
    `  - Current lib.ts exports: ${exports}`,
    "  - Current lib.ts source:",
    indent(src, 6),
    `  - Storage keys: ${storage}`,
  ].join("\n");
}

function priorStepsBlock(steps: PriorStep[]): string {
  if (steps.length === 0) return "";
  const lines: string[] = ["Prior steps:"];
  steps.forEach((step, i) => {
    lines.push("");
    lines.push(`--- step ${i + 1} ---`);
    lines.push("Your code was:");
    lines.push("```ts");
    lines.push(step.code);
    lines.push("```");
    if (step.event.logs.length > 0) {
      lines.push("Logs from this step:");
      for (const log of step.event.logs) {
        lines.push(`  [${log.level}] ${log.args.map((a) => safeStr(a)).join(" ")}`);
      }
    }
    lines.push(eventSummary(step.event));
  });
  return lines.join("\n");
}

function eventSummary(ev: SandboxEvent): string {
  switch (ev.kind) {
    case "reflect":
      return `Result: reflect — state passed forward: ${safeStr(ev.state)}`;
    case "permission_denied":
      return [
        `Result: permission_denied — ${ev.permission} access to "${ev.target}" was blocked.`,
        `That capability is NOT in your grant; retrying the same call will fail the same way.`,
        `Either pick a different approach that uses what IS granted, or \`return abort(...)\` with a clear explanation of what's missing.`,
      ].join("\n");
    case "throw":
      return [
        `Result: threw an error — ${ev.error}`,
        `The previous tactic FAILED. Do not retry the same code; either change approach or \`return abort(...)\`.`,
      ].join("\n");
    case "reply":
      // Multi-turn interactive sessions push terminal replies into
      // priorSteps so the model sees what it told the user last turn.
      return `Result: reply — message sent to user: ${safeStr(ev.message)}`;
    case "abort":
      return `Result: abort — ${safeStr(ev.error)}`;
  }
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text.split("\n").map((l) => pad + l).join("\n");
}

function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function taskBlock(task: string): string {
  return `Task: ${task}`;
}
