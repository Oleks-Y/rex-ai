// Guardrails — per-step policy hooks that wrap a sandbox event in an
// independent LLM evaluation and can veto it before it propagates.
//
// Mental model: a guardrail is a tiny critic that watches the agent. Each one
// declares which sandbox event kinds it cares about (`triggers`), provides a
// model + instructions, and on each matching step receives an audit log of
// the conversation so far. If the guardrail returns `{ ok: false, reason }`,
// the event the sandbox produced is replaced by a NON-TERMINAL
// `guardrail_blocked` event tagged with the guardrail name + reason. The
// host sees it on `onStep` and in the transcript; the agent loop pushes it
// to prior history and runs another step so the model can revise. The
// original event's payload is preserved on the blocked event (`original`)
// so observers and the next prompt can see exactly what was rejected.
//
// The audit document mirrors `prompt.ts` priorStepsBlock so the guardrail and
// the agent see the same step shape. Per-step execution logs are truncated to
// a fixed byte budget (default 4 KiB) so a chatty step can't blow up the
// guardrail's input window.

import { generateText } from "ai";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { PriorStep } from "./prompt.ts";
import type {
  GuardrailBlockedOriginal,
  SandboxEvent,
  SandboxLog,
} from "./types.ts";

export type GuardrailTrigger =
  | "reply"
  | "abort"
  | "reflect"
  | "permission_denied"
  | "throw"
  | "any";

export interface GuardrailDefinition {
  /** Stable identifier — appears in audit log heading, the
   *  `guardrail_blocked` event's `guardrail` field, and
   *  `GuardrailEvaluation.guardrail`. */
  name: string;
  /** Event kinds that trigger this guardrail. `"any"` matches every kind. */
  triggers: GuardrailTrigger[];
  /** Model used to evaluate the guardrail. Required when `check` is
   *  omitted; ignored when `check` is provided. */
  model?: LanguageModelV2;
  /** What the guardrail looks for. Becomes the first section of the audit
   *  doc the model is given. Don't include the output-format instructions —
   *  the runner appends those itself. Required when `check` is omitted. */
  instructions?: string;
  /**
   * Deterministic check. When provided, the guardrail does NOT make an
   * LLM call — `check(ctx)` runs directly and produces the verdict.
   * Useful for cheap, repeatable rules (string match, regex, code
   * structure) where an LLM is wasteful. Mutually exclusive with the
   * `model` + `instructions` path: if `check` is set, those are
   * ignored.
   */
  check?: (ctx: GuardrailContext) => GuardrailVerdict | Promise<GuardrailVerdict>;
  /** Per-step logs byte budget in the audit doc. Default 4 KiB. Logs
   *  beyond this are clipped with a `[log truncated — N bytes omitted]`
   *  marker so the guardrail knows there was more. */
  maxLogsBytesPerStep?: number;
  /** Per-event-payload byte budget (reflect state / reply message / abort
   *  error / throw error / permission target). Default 4 KiB. */
  maxEventBytes?: number;
  /** If the guardrail model call throws or its output can't be parsed,
   *  allow the original event through. Default true (fail-open).
   *  Set false to convert eval failures into blocks — appropriate when
   *  the guardrail is enforcing a hard policy and you'd rather abort
   *  than risk letting a policy-violating event through silently. */
  passOnError?: boolean;
}

export type GuardrailVerdict =
  | { ok: true }
  | { ok: false; reason: string };

export interface GuardrailEvaluation {
  /** Name of the guardrail that produced this verdict. */
  guardrail: string;
  /** Verdict returned by the guardrail model (or synthesized by the
   *  failure path when `passOnError` was applied). */
  verdict: GuardrailVerdict;
  /** Set when the model call or output parse failed. Combined with
   *  `verdict.ok === true`, this means the guardrail bailed out
   *  (fail-open); with `verdict.ok === false`, it was converted into a
   *  block (fail-closed). */
  evaluationError?: string;
  /** Raw model text — useful for debugging audit doc shape. */
  rawOutput?: string;
}

export interface GuardrailContext {
  /** The sandbox event being inspected. The guardrail may replace it
   *  with a non-terminal `guardrail_blocked` step by returning
   *  `{ ok: false }`. */
  event: SandboxEvent;
  /** Source code that produced `event`. */
  code: string;
  /** 1-based index of the step within this run. */
  stepIndex: number;
  /** The user task driving the current turn. */
  task: string;
  /** All prior steps available to the model in the current turn. The
   *  current step is NOT in this array — the runner appends it last
   *  under a `CURRENT STEP` heading. */
  priorSteps: PriorStep[];
}

const DEFAULT_LOGS_BYTES = 4 * 1024;
const DEFAULT_EVENT_BYTES = 4 * 1024;

/** Validate + return a guardrail. Use this at the call site for the same
 *  reason `defineTool` exists — it catches misconfiguration at construction
 *  rather than at the first step. */
export function defineGuardrail(g: GuardrailDefinition): GuardrailDefinition {
  if (typeof g.name !== "string" || g.name.length === 0) {
    throw new Error("defineGuardrail: `name` must be a non-empty string");
  }
  if (!Array.isArray(g.triggers) || g.triggers.length === 0) {
    throw new Error(
      `defineGuardrail("${g.name}"): \`triggers\` must be a non-empty array`,
    );
  }
  const valid = new Set<GuardrailTrigger>([
    "reply",
    "abort",
    "reflect",
    "permission_denied",
    "throw",
    "any",
  ]);
  for (const t of g.triggers) {
    if (!valid.has(t)) {
      throw new Error(
        `defineGuardrail("${g.name}"): unknown trigger "${t}". ` +
          `Allowed: reply, abort, reflect, permission_denied, throw, any.`,
      );
    }
  }
  // Two paths: deterministic `check` callback, OR LLM-backed
  // model+instructions. Exactly one path must be configured.
  if (g.check !== undefined) {
    if (typeof g.check !== "function") {
      throw new Error(
        `defineGuardrail("${g.name}"): \`check\` must be a function`,
      );
    }
    // model/instructions are tolerated (so a caller can stub a model
    // for tests) but they are NOT used when `check` is set.
  } else {
    if (!g.model) {
      throw new Error(
        `defineGuardrail("${g.name}"): \`model\` is required (or provide a \`check\` callback)`,
      );
    }
    if (typeof g.instructions !== "string" || g.instructions.length === 0) {
      throw new Error(
        `defineGuardrail("${g.name}"): \`instructions\` must be a non-empty string (or provide a \`check\` callback)`,
      );
    }
  }
  if (g.maxLogsBytesPerStep !== undefined && g.maxLogsBytesPerStep < 0) {
    throw new Error(
      `defineGuardrail("${g.name}"): \`maxLogsBytesPerStep\` must be >= 0`,
    );
  }
  if (g.maxEventBytes !== undefined && g.maxEventBytes < 0) {
    throw new Error(
      `defineGuardrail("${g.name}"): \`maxEventBytes\` must be >= 0`,
    );
  }
  return g;
}

/** Trigger predicate — exported so callers can filter guardrails ahead of
 *  the runner (e.g. for a dry-run preview UI). */
export function matchesTrigger(
  g: GuardrailDefinition,
  ev: SandboxEvent,
): boolean {
  if (g.triggers.includes("any")) return true;
  // SandboxEvent.kind is a strict subset of GuardrailTrigger, so the cast
  // is safe — we're not constructing a kind, just narrowing the set.
  return g.triggers.includes(ev.kind as GuardrailTrigger);
}

export const GuardrailRunner = {
  /**
   * Evaluate every matching guardrail against the current step. Stops at
   * the first blocking verdict (subsequent guardrails are NOT called).
   * The return shape is the chain of evaluations the runner actually
   * performed, in order — useful for observability.
   *
   * If `guardrails` is empty or none match, the returned array is empty
   * and the caller proceeds as before.
   */
  async evaluate(
    guardrails: readonly GuardrailDefinition[],
    ctx: GuardrailContext,
  ): Promise<GuardrailEvaluation[]> {
    if (guardrails.length === 0) return [];
    const matching = guardrails.filter((g) => matchesTrigger(g, ctx.event));
    if (matching.length === 0) return [];

    const out: GuardrailEvaluation[] = [];
    for (const g of matching) {
      const evaluation = await runOne(g, ctx);
      out.push(evaluation);
      if (!evaluation.verdict.ok) break; // first block wins
    }
    return out;
  },

  /** Pick the blocking evaluation from a chain, if any. Trivial helper but
   *  it makes intent in the agent loop obvious. */
  firstBlock(evals: readonly GuardrailEvaluation[]): GuardrailEvaluation | null {
    for (const e of evals) if (!e.verdict.ok) return e;
    return null;
  },

  /** Construct the synthetic `guardrail_blocked` event that replaces the
   *  sandbox's original event when a guardrail blocks. The original
   *  event's logs and payload are preserved so the user (and resume
   *  readers, the next prompt, and observability hooks) can still see
   *  exactly what the sandbox produced.
   *
   *  This is NON-TERMINAL — the agent loop pushes it to prior history
   *  and runs another step so the model can revise. Use `reason` from
   *  the blocking verdict; if the guardrail bailed out (evaluationError
   *  with passOnError=false), the verdict's reason already carries
   *  "guardrail evaluation failed: …". */
  blockedEvent(
    original: SandboxEvent,
    blocking: GuardrailEvaluation,
  ): SandboxEvent {
    const reason = blocking.verdict.ok
      ? "evaluation error"
      : blocking.verdict.reason;
    const payload = stripLogs(original);
    return {
      kind: "guardrail_blocked",
      guardrail: blocking.guardrail,
      reason,
      originalKind: payload.kind,
      original: payload,
      logs: original.logs,
    };
  },
};

/** Strip the `logs` field from a sandbox event to build the `original`
 *  payload preserved on a `guardrail_blocked` event. Guardrails never run
 *  on a `guardrail_blocked` event (the agent loop short-circuits that
 *  case), so the input is always one of the five real sandbox outcomes. */
function stripLogs(ev: SandboxEvent): GuardrailBlockedOriginal {
  switch (ev.kind) {
    case "reply":
      return { kind: "reply", message: ev.message };
    case "abort":
      return { kind: "abort", error: ev.error };
    case "reflect":
      return { kind: "reflect", state: ev.state };
    case "permission_denied":
      return {
        kind: "permission_denied",
        permission: ev.permission,
        target: ev.target,
      };
    case "throw":
      return { kind: "throw", error: ev.error };
    case "guardrail_blocked":
      throw new Error(
        "guardrails are not evaluated on a guardrail_blocked event " +
          "(internal invariant)",
      );
  }
}

async function runOne(
  g: GuardrailDefinition,
  ctx: GuardrailContext,
): Promise<GuardrailEvaluation> {
  // Deterministic-check path — no LLM call, just the callback.
  if (g.check) {
    try {
      const verdict = await g.check(ctx);
      return { guardrail: g.name, verdict };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const passOnError = g.passOnError !== false;
      return {
        guardrail: g.name,
        verdict: passOnError
          ? { ok: true }
          : {
            ok: false,
            reason: `guardrail evaluation failed: ${message}`,
          },
        evaluationError: message,
      };
    }
  }
  // LLM path — build the audit doc and ask the model.
  const audit = buildAuditLog(g, ctx);
  let rawOutput: string | undefined;
  try {
    // `model` is guaranteed by defineGuardrail when `check` is omitted.
    const completion = await generateText({ model: g.model!, prompt: audit });
    rawOutput = completion.text;
    const verdict = parseVerdict(rawOutput);
    return { guardrail: g.name, verdict, rawOutput };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const passOnError = g.passOnError !== false;
    return {
      guardrail: g.name,
      verdict: passOnError
        ? { ok: true }
        : {
          ok: false,
          reason: `guardrail evaluation failed: ${message}`,
        },
      evaluationError: message,
      rawOutput,
    };
  }
}

/** Render the audit document the guardrail model sees. Exported for tests
 *  and for callers who want to preview what a guardrail would receive
 *  (e.g. a dry-run / debug UI). */
export function buildAuditLog(
  g: GuardrailDefinition,
  ctx: GuardrailContext,
): string {
  const logsBudget = g.maxLogsBytesPerStep ?? DEFAULT_LOGS_BYTES;
  const eventBudget = g.maxEventBytes ?? DEFAULT_EVENT_BYTES;

  const lines: string[] = [];
  lines.push(`# Guardrail audit — ${g.name}`);
  lines.push("");
  lines.push("## Instructions");
  lines.push(g.instructions ?? "(deterministic check — no instructions)");
  lines.push("");
  lines.push("## Task");
  lines.push(ctx.task);
  lines.push("");

  if (ctx.priorSteps.length > 0) {
    lines.push("## Prior steps");
    ctx.priorSteps.forEach((step, i) => {
      lines.push("");
      lines.push(`### step ${i + 1}`);
      renderStep(lines, step.code, step.event, logsBudget, eventBudget);
    });
    lines.push("");
  }

  lines.push("## CURRENT STEP (under review)");
  lines.push(`step ${ctx.stepIndex} — event kind: ${ctx.event.kind}`);
  renderStep(lines, ctx.code, ctx.event, logsBudget, eventBudget);
  lines.push("");

  lines.push("## Your task");
  lines.push(
    "Decide whether the CURRENT STEP's event should be allowed to propagate to the user / agent loop.",
  );
  lines.push(
    'Respond with a single JSON object on its own line — no prose, no fences, no other keys:',
  );
  lines.push('  {"ok": true}                                 — allow the event');
  lines.push('  {"ok": false, "reason": "<short reason>"}    — block: the event is replaced by a non-terminal guardrail_blocked step carrying this reason; the agent gets another turn to revise');
  lines.push(
    "Be specific in `reason` — the user will see it. Cite what triggered the block.",
  );
  return lines.join("\n");
}

function renderStep(
  out: string[],
  code: string,
  event: SandboxEvent,
  logsBudget: number,
  eventBudget: number,
): void {
  out.push("Code:");
  out.push("```ts");
  out.push(code);
  out.push("```");
  if (event.logs.length > 0) {
    out.push("Logs:");
    const rendered = renderLogs(event.logs, logsBudget);
    for (const ln of rendered) out.push(`  ${ln}`);
  }
  out.push(renderEvent(event, eventBudget));
}

function renderLogs(logs: readonly SandboxLog[], budget: number): string[] {
  // Render line by line, tracking total bytes. When we hit the budget we
  // emit a truncation marker that tells the guardrail how much was dropped
  // (in entries; bytes don't quite map to what the agent saw).
  //
  // budget === 0 means "no logs rendered at all" (drop everything) — the
  // user explicitly asked for zero bytes. A negative budget is rejected at
  // defineGuardrail time, so this branch is the only edge case.
  if (budget === 0) {
    return logs.length === 0 ? [] : [`[log truncated — ${logs.length} entries omitted]`];
  }
  const lines: string[] = [];
  let used = 0;
  let truncatedAt = -1;
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const line = `[${log.level}] ${log.args.map(safeStr).join(" ")}`;
    const lineBytes = byteLength(line) + 1; // +1 for newline
    if (used + lineBytes > budget) {
      truncatedAt = i;
      break;
    }
    lines.push(line);
    used += lineBytes;
  }
  if (truncatedAt !== -1) {
    const dropped = logs.length - truncatedAt;
    lines.push(`[log truncated — ${dropped} entries omitted]`);
  }
  return lines;
}

function renderEvent(event: SandboxEvent, budget: number): string {
  switch (event.kind) {
    case "reply":
      return `Event: reply — ${clipString(event.message, budget)}`;
    case "abort":
      return `Event: abort — ${clipString(event.error, budget)}`;
    case "reflect":
      return `Event: reflect — state: ${clipString(safeStr(event.state), budget)}`;
    case "permission_denied":
      return `Event: permission_denied — ${event.permission}: ${clipString(event.target, budget)}`;
    case "throw":
      return `Event: throw — ${clipString(event.error, budget)}`;
    case "guardrail_blocked": {
      const orig = renderOriginal(event.original, budget);
      return `Event: guardrail_blocked — ${event.guardrail} blocked ${event.originalKind}: ${clipString(event.reason, budget)}\nOriginal payload: ${orig}`;
    }
  }
}

function renderOriginal(o: GuardrailBlockedOriginal, budget: number): string {
  switch (o.kind) {
    case "reply":
      return `reply — ${clipString(o.message, budget)}`;
    case "abort":
      return `abort — ${clipString(o.error, budget)}`;
    case "reflect":
      return `reflect — state: ${clipString(safeStr(o.state), budget)}`;
    case "permission_denied":
      return `permission_denied — ${o.permission}: ${clipString(o.target, budget)}`;
    case "throw":
      return `throw — ${clipString(o.error, budget)}`;
  }
}

function clipString(s: string, budget: number): string {
  if (budget <= 0) return s;
  if (byteLength(s) <= budget) return s;
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  const clipped = bytes.subarray(0, Math.max(0, budget));
  // Decode with fatal:false to handle a clipped multi-byte boundary
  // gracefully (the dropped tail just becomes a U+FFFD replacement).
  const dec = new TextDecoder("utf-8", { fatal: false });
  return dec.decode(clipped) + `… [clipped ${bytes.length - budget} bytes]`;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Parse the guardrail model's output. Accepts either a bare JSON object or
 *  one embedded in surrounding prose (we extract the first `{...}` block
 *  and try to JSON.parse it). Throws if the output can't be coerced — the
 *  caller treats throws as evaluation failures and applies passOnError. */
export function parseVerdict(text: string): GuardrailVerdict {
  if (typeof text !== "string") {
    throw new Error("guardrail output was not a string");
  }
  const json = extractFirstJsonObject(text);
  if (json === null) {
    throw new Error(
      `guardrail output had no JSON object (got: ${truncate(text, 200)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `guardrail output JSON parse failed: ${(e as Error).message} (got: ${truncate(json, 200)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`guardrail output was not an object (got: ${truncate(json, 200)})`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.ok !== "boolean") {
    throw new Error(
      `guardrail output missing boolean "ok" field (got: ${truncate(json, 200)})`,
    );
  }
  if (obj.ok === true) return { ok: true };
  // ok === false: reason is required (but tolerate missing — use a default
  // so the agent still aborts with a useful-enough message).
  const reason = typeof obj.reason === "string" && obj.reason.length > 0
    ? obj.reason
    : "blocked (no reason provided)";
  return { ok: false, reason };
}

/** Scan `text` for the first balanced `{...}` JSON object and return its
 *  source slice. Handles strings (so braces inside string literals don't
 *  break balancing) and backslash escapes. Returns null if no candidate. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ── Prebuilt guardrail factories ─────────────────────────────────────────
//
// These return `GuardrailDefinition` objects. They're thin wrappers around
// `defineGuardrail` that pin the instructions and trigger set for two
// recurring policies:
//
//   1. reflect-before-reply  — every data-bearing reply() must be backed
//      by a prior reflect step that observed the data.
//   2. reflect-in-callback   — timer callbacks must use reflect(...) to
//      surface results, never reply(...) or abort(...) directly.
//
// Both default to `passOnError: false` (fail-closed) because the caller
// opted into enforcement; a transient model hiccup should NOT silently
// allow a policy-violating event through.

export interface PrebuiltGuardrailOptions {
  /** Model used to evaluate the guardrail. A cheap model is fine —
   *  these checks are deterministic policy reads, not creative work. */
  model: LanguageModelV2;
  /** If the eval call or output parse fails, allow the event.
   *  Default false — enforcement mode. Set true to fail-open. */
  passOnError?: boolean;
  /** Override the default name. Useful when stacking multiple instances
   *  of the same policy (e.g. one strict, one lenient) so the abort
   *  prefix tells them apart. */
  name?: string;
}

const REFLECT_BEFORE_REPLY_INSTRUCTIONS = [
  "You enforce: a reply() that surfaces externally-sourced data must be",
  "preceded by at least one prior step of kind `reflect` whose logs or state",
  "visibly contain that data. Single-step replies (no prior reflect in this",
  "turn) are allowed ONLY when the reply is:",
  "  - a clarifying question to the user,",
  "  - a refusal / capability statement (no data claimed),",
  "  - a pure-knowledge answer (no tool output, file contents, fetched data,",
  "    or session-state values quoted or paraphrased).",
  "",
  "Block (with a SPECIFIC reason) when the reply quotes, summarizes, or",
  "paraphrases values that do not appear in any prior reflect step's logs",
  "or state in this turn. Examples of blocks:",
  "  - reply names a count, ID, list item, price, or status that no prior",
  "    reflect logged.",
  "  - reply summarizes a fetched document with no prior reflect step.",
  "  - reply confirms a side effect (sent, written, committed) without a",
  "    prior reflect that read back the post-state.",
  "",
  "When the reply IS backed by a prior reflect, allow it.",
  "When the reply contains no data at all, allow it.",
].join("\n");

/** Guardrail factory: blocks replies that surface data the agent never
 *  inspected via a prior `reflect` step. Trigger: ["reply"]. */
export function reflectBeforeReplyGuardrail(
  opts: PrebuiltGuardrailOptions,
): GuardrailDefinition {
  return defineGuardrail({
    name: opts.name ?? "reflect-before-reply",
    triggers: ["reply"],
    model: opts.model,
    passOnError: opts.passOnError ?? false,
    instructions: REFLECT_BEFORE_REPLY_INSTRUCTIONS,
  });
}

const REFLECT_IN_CALLBACK_INSTRUCTIONS = [
  "You enforce a code-shape rule about timer callbacks.",
  "",
  "Inspect the CURRENT STEP's code (and any `writeLib(\"...\")` source it",
  "registers). If it schedules a timer callback via `setTimeout(...)`,",
  "`setInterval(...)`, or any equivalent helper, and the callback body",
  "directly invokes `reply(...)` or `abort(...)`, BLOCK.",
  "",
  "The correct pattern inside a callback is `reflect(value)` — the runtime",
  "translates a callback-side reply/abort into a reflect-with-intent on the",
  "next wakeup turn anyway, so writing `reply` or `abort` inside a callback",
  "hides the actual control flow from the author. Force the explicit form.",
  "",
  "Allow:",
  "  - callbacks that call `reflect(...)` (any argument shape).",
  "  - silent callbacks that call NO control fn (predicate-poll pattern).",
  "  - top-level `return reply(...)` / `return abort(...)` outside any",
  "    callback body. The rule applies only to control fns reached from",
  "    INSIDE a timer callback body.",
  "",
  "Block (with a SPECIFIC reason naming the offending callback) when:",
  "  - a setTimeout / setInterval callback body calls reply(...) or abort(...).",
  "  - a writeLib source registers such a callback.",
  "  - any equivalent (aliased control fn, dynamically-built callback) that",
  "    a reader could clearly see surfaces reply/abort from inside a timer.",
].join("\n");

/** Guardrail factory: blocks code that calls reply() or abort() inside a
 *  timer callback. Trigger: ["any"] — runs every step, since the rule is
 *  a code-shape policy independent of the step's outcome. */
export function reflectInCallbackGuardrail(
  opts: PrebuiltGuardrailOptions,
): GuardrailDefinition {
  return defineGuardrail({
    name: opts.name ?? "reflect-in-callback",
    triggers: ["any"],
    model: opts.model,
    passOnError: opts.passOnError ?? false,
    instructions: REFLECT_IN_CALLBACK_INSTRUCTIONS,
  });
}

/**
 * Phrase the sandbox prelude emits as an abort error when the agent's
 * code runs to completion without invoking any control fn. Stable —
 * kept in sync with `src/prelude.ts` / `src/prelude_v2.ts`. Exported so
 * tests can reuse the exact wording.
 */
export const MISSING_CONTROL_FN_PATTERN =
  /agent code finished without calling or returning/i;

export interface RetryOnMissingControlFnOptions {
  /** Override the default name. */
  name?: string;
  /** Default `false`. The check itself can't throw — set to `true` only
   *  if you genuinely want to ignore unexpected errors in the predicate. */
  passOnError?: boolean;
}

/**
 * Deterministic guardrail factory: when the sandbox aborts with the
 * specific "agent code finished without calling or returning reply(),
 * abort(), or reflect()" error, convert it to a `guardrail_blocked`
 * event so the loop keeps going and the model gets another shot.
 *
 * No LLM call — this is a string check on the abort error.
 *
 * Trigger: `["abort"]`. Other event kinds are unaffected, and aborts
 * that DON'T match the missing-control-fn pattern (e.g. user-emitted
 * `return abort("missing API key")`) pass through unchanged, preserving
 * the terminal-abort semantics for genuine refusals.
 */
export function retryOnMissingControlFnGuardrail(
  opts: RetryOnMissingControlFnOptions = {},
): GuardrailDefinition {
  return defineGuardrail({
    name: opts.name ?? "retry-on-missing-control-fn",
    triggers: ["abort"],
    passOnError: opts.passOnError ?? false,
    check: (ctx) => {
      const ev = ctx.event;
      if (ev.kind !== "abort") return { ok: true };
      if (!MISSING_CONTROL_FN_PATTERN.test(ev.error)) return { ok: true };
      return {
        ok: false,
        reason:
          "Your code finished without calling reply(), abort(), or reflect(). " +
          "Always end your code block with `return reply(...)`, `return abort(...)`, " +
          "or `return reflect(...)`. Revise and retry on the next step.",
      };
    },
  });
}
