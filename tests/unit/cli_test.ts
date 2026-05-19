// Unit tests for src/cli.ts — argument parsing (incl. the new -i/--interactive
// flag) and AgentEvent rendering. The interactive subprocess flow itself is
// exercised end-to-end by the AgentSession integration tests.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DEFAULT_CAPS,
  makeColor,
  parseArgs,
  renderAgentEvent,
  renderStep,
  truncLines,
  truncStr,
  VERBOSE_CAPS,
  WakeupTracker,
} from "../../src/cli.ts";
import type { AgentEvent, StepRecord } from "../../src/types.ts";

const c = makeColor(false); // strip ANSI for stable assertions

Deno.test("parseArgs: -i sets interactive", () => {
  const a = parseArgs(["-i", "--agent", "x.ts", "--", "do it"]);
  assertEquals(a.interactive, true);
  assertEquals(a.agent, "x.ts");
  assertEquals(a.task, "do it");
});

Deno.test("parseArgs: --interactive sets interactive", () => {
  const a = parseArgs(["--interactive", "--agent", "x.ts", "--", "go"]);
  assertEquals(a.interactive, true);
  assertEquals(a.task, "go");
});

Deno.test("parseArgs: interactive defaults false", () => {
  const a = parseArgs(["--agent", "x.ts", "--", "go"]);
  assertEquals(a.interactive, false);
});

Deno.test("parseArgs: interactive coexists with --session and --no-color", () => {
  const a = parseArgs([
    "--interactive",
    "--agent",
    "x.ts",
    "--session",
    "s1",
    "--no-color",
    "--",
    "task here",
  ]);
  assertEquals(a.interactive, true);
  assertEquals(a.session, "s1");
  assertEquals(a.color, false);
  assertEquals(a.task, "task here");
});

// ── history flags ─────────────────────────────────────────────────────────

Deno.test("parseArgs: history defaults (save on, dir=.rex/history, format=json)", () => {
  const a = parseArgs(["--agent", "x.ts", "--", "t"]);
  assertEquals(a.saveHistory, true);
  assertEquals(a.historyDir, ".rex/history");
  assertEquals(a.historyFormat, "json");
});

Deno.test("parseArgs: --no-save-history disables auto-save", () => {
  const a = parseArgs(["--agent", "x.ts", "--no-save-history", "--", "t"]);
  assertEquals(a.saveHistory, false);
  // Other history defaults remain intact (so the user can flip the
  // switch back on without losing their dir / format choices).
  assertEquals(a.historyDir, ".rex/history");
  assertEquals(a.historyFormat, "json");
});

Deno.test("parseArgs: --history-dir <path> sets directory", () => {
  const a = parseArgs([
    "--agent",
    "x.ts",
    "--history-dir",
    "/tmp/archive",
    "--",
    "t",
  ]);
  assertEquals(a.historyDir, "/tmp/archive");
});

Deno.test("parseArgs: --history-dir=path equals-form sets directory", () => {
  const a = parseArgs(["--agent", "x.ts", "--history-dir=/tmp/eq", "--", "t"]);
  assertEquals(a.historyDir, "/tmp/eq");
});

Deno.test("parseArgs: --history-format accepts json / md / both", () => {
  for (const fmt of ["json", "md", "both"] as const) {
    const a = parseArgs([
      "--agent",
      "x.ts",
      "--history-format",
      fmt,
      "--",
      "t",
    ]);
    assertEquals(a.historyFormat, fmt);
  }
});

Deno.test("parseArgs: --history-format=md equals-form accepted", () => {
  const a = parseArgs(["--agent", "x.ts", "--history-format=md", "--", "t"]);
  assertEquals(a.historyFormat, "md");
});

Deno.test("parseArgs: --history-format with unknown value throws", () => {
  let err: unknown;
  try {
    parseArgs(["--agent", "x.ts", "--history-format", "xml", "--", "t"]);
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error);
  assertStringIncludes((err as Error).message, "json|md|both");
});

Deno.test("renderAgentEvent: reply", () => {
  const out = renderAgentEvent(
    { kind: "reply", message: "hi", turn: 1, cause: "user" },
    c,
  );
  assert(out !== null);
  assertStringIncludes(out!, "REPLY");
  assertStringIncludes(out!, "(turn 1, user)");
  assertStringIncludes(out!, "hi");
});

Deno.test("renderAgentEvent: abort and exhausted", () => {
  const a = renderAgentEvent(
    { kind: "abort", error: "boom", turn: 2, cause: "wakeup" },
    c,
  );
  assertStringIncludes(a!, "ABORT");
  assertStringIncludes(a!, "(turn 2, wakeup)");
  assertStringIncludes(a!, "boom");
  const e = renderAgentEvent(
    { kind: "exhausted", steps: 5, turn: 3, cause: "user" },
    c,
  );
  assertStringIncludes(e!, "EXHAUSTED");
  assertStringIncludes(e!, "5 steps");
});

Deno.test("renderAgentEvent: wakeup_scheduled shows kind, period, reason", () => {
  // timeout — "in Xs"
  const t = renderAgentEvent(
    { kind: "wakeup_scheduled", id: "w_1", reason: "polling", wakeupKind: "timeout", delayMs: 5_000 },
    c,
  );
  assertStringIncludes(t!, "scheduled");
  assertStringIncludes(t!, "w_1");
  assertStringIncludes(t!, "timeout");
  assertStringIncludes(t!, "in 5.0s");
  assertStringIncludes(t!, "polling");

  // interval — "every Xms"
  const i = renderAgentEvent(
    { kind: "wakeup_scheduled", id: "w_2", reason: "feed", wakeupKind: "interval", delayMs: 250 },
    c,
  );
  assertStringIncludes(i!, "interval");
  assertStringIncludes(i!, "every 250ms");
  assertStringIncludes(i!, "feed");

  // promise — no period, just a note
  const p = renderAgentEvent(
    { kind: "wakeup_scheduled", id: "w_3", reason: "fetch", wakeupKind: "promise" },
    c,
  );
  assertStringIncludes(p!, "promise");
  assertStringIncludes(p!, "fetch");
});

Deno.test("renderAgentEvent: wakeup_resolved with tracker shows elapsed + fire count", () => {
  const tracker = new WakeupTracker();
  tracker.apply({
    kind: "wakeup_scheduled",
    id: "w_1",
    reason: "feed",
    wakeupKind: "interval",
    delayMs: 30_000,
  });
  // First tick.
  tracker.apply({ kind: "wakeup_resolved", id: "w_1" });
  const r1 = renderAgentEvent({ kind: "wakeup_resolved", id: "w_1" }, c, DEFAULT_CAPS, undefined, tracker);
  // Note: tracker.apply BEFORE renderAgentEvent already incremented
  // fireCount to 2 (this test applied once before render too).
  assertStringIncludes(r1!, "w_1");
  assertStringIncludes(r1!, "interval");
  assertStringIncludes(r1!, "every 30s");
  assertStringIncludes(r1!, "fired");
});

Deno.test("renderAgentEvent: wakeup_resolved with intent payload shows the message", () => {
  const tracker = new WakeupTracker();
  tracker.apply({
    kind: "wakeup_scheduled",
    id: "w_5",
    reason: "alarm",
    wakeupKind: "timeout",
    delayMs: 1_000,
  });
  const r = renderAgentEvent(
    {
      kind: "wakeup_resolved",
      id: "w_5",
      payload: { intent: { kind: "reply", text: "ALERT fired" } },
    },
    c,
    DEFAULT_CAPS,
    undefined,
    tracker,
  );
  assertStringIncludes(r!, "would reply");
  assertStringIncludes(r!, "ALERT fired");
});

Deno.test("renderAgentEvent: wakeup_resolved with state payload shows the JSON", () => {
  const tracker = new WakeupTracker();
  tracker.apply({
    kind: "wakeup_scheduled",
    id: "w_6",
    reason: "poll",
    wakeupKind: "interval",
    delayMs: 1_000,
  });
  const r = renderAgentEvent(
    { kind: "wakeup_resolved", id: "w_6", payload: { state: { ok: true, n: 3 } } },
    c,
    DEFAULT_CAPS,
    undefined,
    tracker,
  );
  assertStringIncludes(r!, "→ state:");
  assertStringIncludes(r!, '"ok":true');
});

Deno.test("renderAgentEvent: wakeup_resolved with no payload says silent", () => {
  const r = renderAgentEvent({ kind: "wakeup_resolved", id: "w_z" }, c);
  assertStringIncludes(r!, "silent");
});

Deno.test("renderAgentEvent: wakeup_rejected / wakeup_cancelled — with tracker shows elapsed", () => {
  const tracker = new WakeupTracker();
  tracker.apply({ kind: "wakeup_scheduled", id: "w_2", reason: "r", wakeupKind: "timeout", delayMs: 100 });
  const rej = renderAgentEvent(
    { kind: "wakeup_rejected", id: "w_2", error: "net" },
    c,
    DEFAULT_CAPS,
    undefined,
    tracker,
  );
  assertStringIncludes(rej!, "rejected");
  assertStringIncludes(rej!, "w_2");
  assertStringIncludes(rej!, "after");
  assertStringIncludes(rej!, "net");

  tracker.apply({ kind: "wakeup_scheduled", id: "w_3", reason: "r", wakeupKind: "interval", delayMs: 100 });
  const can = renderAgentEvent(
    { kind: "wakeup_cancelled", id: "w_3", reason: "shutdown" },
    c,
    DEFAULT_CAPS,
    undefined,
    tracker,
  );
  assertStringIncludes(can!, "cancelled");
  assertStringIncludes(can!, "w_3");
  assertStringIncludes(can!, "shutdown");
});

Deno.test("renderAgentEvent: session_closed", () => {
  const out = renderAgentEvent(
    { kind: "session_closed", reason: "closed by host" },
    c,
  );
  assertStringIncludes(out!, "session closed");
});

Deno.test("renderAgentEvent: step delegates to renderStep formatting", () => {
  const ev: AgentEvent = {
    kind: "step",
    index: 1,
    source: "fresh",
    code: 'await reply("hi")',
    event: { kind: "reply", message: "hi", logs: [] },
  };
  const out = renderAgentEvent(ev, c);
  assert(out !== null);
  assertStringIncludes(out!, "Step 1");
  assertStringIncludes(out!, 'await reply("hi")');
  assertStringIncludes(out!, "→ reply: hi");
});

// ── truncation helpers ────────────────────────────────────────────────────

Deno.test("truncStr: keeps short strings intact", () => {
  assertEquals(truncStr("hello", 10), "hello");
});

Deno.test("truncStr: truncates with a char count footer", () => {
  const out = truncStr("a".repeat(50), 10);
  assertStringIncludes(out, "aaaaaaaaaa");
  assertStringIncludes(out, "(+40 chars)");
});

Deno.test("truncStr: Infinity disables truncation", () => {
  const big = "x".repeat(1000);
  assertEquals(truncStr(big, Infinity), big);
});

Deno.test("truncLines: keeps short blocks intact", () => {
  const out = truncLines("a\nb\nc", 10);
  assertEquals(out.text, "a\nb\nc");
  assertEquals(out.hidden, 0);
});

Deno.test("truncLines: trims and reports hidden line count", () => {
  const out = truncLines("a\nb\nc\nd\ne", 3);
  assertEquals(out.text, "a\nb\nc");
  assertEquals(out.hidden, 2);
});

// ── renderStep caps ───────────────────────────────────────────────────────

Deno.test("renderStep: truncates a huge log arg", () => {
  const step: StepRecord = {
    index: 2,
    source: "fresh",
    code: "console.log(big)",
    event: {
      kind: "reflect",
      state: { ok: true },
      logs: [{ level: "log", args: ["x".repeat(2000)] }],
    },
  };
  const out = renderStep(step, c, DEFAULT_CAPS);
  // 200 'x' chars + the truncation footer; the full 2000 must not appear.
  assertStringIncludes(out, "(+1800 chars)");
  assert(!out.includes("x".repeat(500)), "huge raw arg must not be present");
});

Deno.test("renderStep: caps log count per step with a '+K more' footer", () => {
  const logs = Array.from({ length: 15 }, (_, i) => ({
    level: "log" as const,
    args: [`line ${i}`],
  }));
  const step: StepRecord = {
    index: 3,
    source: "fresh",
    code: "x = 1",
    event: { kind: "reflect", state: 1, logs },
  };
  const out = renderStep(step, c, DEFAULT_CAPS);
  assertStringIncludes(out, "line 0");
  assertStringIncludes(out, "line 9");
  assertStringIncludes(out, "(+5 more logs)");
  assert(!out.includes("line 14"), "logs past the cap must be hidden");
});

Deno.test("renderStep: collapses long code blocks", () => {
  const code = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
  const step: StepRecord = {
    index: 4,
    source: "fresh",
    code,
    event: { kind: "reflect", state: 1, logs: [] },
  };
  const out = renderStep(step, c, DEFAULT_CAPS);
  assertStringIncludes(out, "line0");
  assertStringIncludes(out, "line19");
  assertStringIncludes(out, "(+20 more lines)");
  assert(!out.includes("line39"), "lines past the cap must be hidden");
});

Deno.test("renderStep: truncates large reflect.state JSON", () => {
  const step: StepRecord = {
    index: 5,
    source: "fresh",
    code: "reflect(big)",
    event: {
      kind: "reflect",
      state: { payload: "y".repeat(2000) },
      logs: [],
    },
  };
  const out = renderStep(step, c, DEFAULT_CAPS);
  assertStringIncludes(out, "(+");
  assertStringIncludes(out, "chars)");
  assert(!out.includes("y".repeat(800)), "huge state must be truncated");
});

Deno.test("renderStep: --verbose caps preserve full content", () => {
  const code = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
  const step: StepRecord = {
    index: 6,
    source: "fresh",
    code,
    event: {
      kind: "reflect",
      state: 1,
      logs: [{ level: "log", args: ["z".repeat(2000)] }],
    },
  };
  const out = renderStep(step, c, VERBOSE_CAPS);
  assertStringIncludes(out, "line39");
  assertStringIncludes(out, "z".repeat(2000));
  assert(!out.includes("(+"), "verbose mode must not emit truncation footers");
});

Deno.test("renderStep: shows duration when provided", () => {
  const step: StepRecord = {
    index: 7,
    source: "fresh",
    code: "noop()",
    event: { kind: "reflect", state: 1, logs: [] },
  };
  const out = renderStep(step, c, DEFAULT_CAPS, 1234);
  assertStringIncludes(out, "1.2s");
});

// ── WakeupTracker ─────────────────────────────────────────────────────────

Deno.test("WakeupTracker: tracks pending → resolved (timeout)", () => {
  const t = new WakeupTracker();
  t.apply({ kind: "wakeup_scheduled", id: "w_1", reason: "poll", wakeupKind: "timeout" });
  t.apply({ kind: "wakeup_scheduled", id: "w_2", reason: "feed", wakeupKind: "interval" });
  assertEquals(t.size(), 2);
  const before = t.render(c, 200);
  assert(before !== null);
  assertStringIncludes(before!, "2 pending");
  assertStringIncludes(before!, "poll");
  assertStringIncludes(before!, "feed");

  // Timeout fires once → pending count drops by 1; meta retained.
  t.apply({ kind: "wakeup_resolved", id: "w_1" });
  assertEquals(t.size(), 1);
  const after = t.render(c, 200);
  assert(after !== null);
  assertStringIncludes(after!, "1 pending");
  assert(!after!.includes("poll"));
  // Meta retained for the resolved entry — renderer can still look it up.
  const m = t.getMeta("w_1");
  assert(m !== undefined);
  assertEquals(m!.status, "resolved");
  assertEquals(m!.fireCount, 1);
});

Deno.test("WakeupTracker: intervals stay pending across fires, fireCount bumps", () => {
  const t = new WakeupTracker();
  t.apply({
    kind: "wakeup_scheduled",
    id: "iv",
    reason: "tick",
    wakeupKind: "interval",
    delayMs: 100,
  });
  assertEquals(t.size(), 1);
  for (let i = 0; i < 3; i++) t.apply({ kind: "wakeup_resolved", id: "iv" });
  // Three resolves, all pending — that's an interval.
  assertEquals(t.size(), 1);
  const m = t.getMeta("iv");
  assertEquals(m!.status, "pending");
  assertEquals(m!.fireCount, 3);
  assertEquals(m!.delayMs, 100);
});

Deno.test("WakeupTracker: drops from pending on rejected / cancelled / session_closed", () => {
  const t = new WakeupTracker();
  t.apply({ kind: "wakeup_scheduled", id: "a", reason: "r1", wakeupKind: "timeout" });
  t.apply({ kind: "wakeup_scheduled", id: "b", reason: "r2", wakeupKind: "promise" });
  t.apply({ kind: "wakeup_rejected", id: "a", error: "x" });
  assertEquals(t.size(), 1);
  // Meta retained — status flipped.
  assertEquals(t.getMeta("a")!.status, "rejected");
  t.apply({ kind: "wakeup_cancelled", id: "b", reason: "shutdown" });
  assertEquals(t.size(), 0);
  assertEquals(t.getMeta("b")!.status, "cancelled");
  assertEquals(t.render(c, 80), null);

  // session_closed nukes the meta map entirely (host is exiting).
  t.apply({ kind: "wakeup_scheduled", id: "c", reason: "r3", wakeupKind: "interval" });
  t.apply({ kind: "session_closed", reason: "bye" });
  assertEquals(t.size(), 0);
  assertEquals(t.getMeta("c"), undefined);
  assertEquals(t.getMeta("a"), undefined);
});

Deno.test("WakeupTracker: footer truncates with '+N more' under tight width", () => {
  const t = new WakeupTracker();
  for (let i = 0; i < 6; i++) {
    t.apply({
      kind: "wakeup_scheduled",
      id: `w_${i}`,
      reason: `task-name-${i}`,
      wakeupKind: "timeout",
    });
  }
  const out = t.render(c, 40);
  assert(out !== null);
  assertStringIncludes(out!, "6 pending");
  assertStringIncludes(out!, "+");
  assertStringIncludes(out!, "more");
});
