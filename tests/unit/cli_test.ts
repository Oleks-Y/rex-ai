// Unit tests for src/cli.ts — argument parsing (incl. the new -i/--interactive
// flag) and AgentEvent rendering. The interactive subprocess flow itself is
// exercised end-to-end by the AgentSession integration tests.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { makeColor, parseArgs, renderAgentEvent } from "../../src/cli.ts";
import type { AgentEvent } from "../../src/types.ts";

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

Deno.test("renderAgentEvent: wakeup lifecycle events", () => {
  const sched = renderAgentEvent(
    { kind: "wakeup_scheduled", id: "w_1", reason: "polling", wakeupKind: "delay" },
    c,
  );
  assertStringIncludes(sched!, "wakeup_scheduled w_1");
  assertStringIncludes(sched!, "(delay)");
  assertStringIncludes(sched!, "polling");

  const res = renderAgentEvent({ kind: "wakeup_resolved", id: "w_1" }, c);
  assertStringIncludes(res!, "wakeup_resolved w_1");

  const rej = renderAgentEvent(
    { kind: "wakeup_rejected", id: "w_2", error: "net" },
    c,
  );
  assertStringIncludes(rej!, "wakeup_rejected w_2");
  assertStringIncludes(rej!, "net");

  const can = renderAgentEvent(
    { kind: "wakeup_cancelled", id: "w_3", reason: "shutdown" },
    c,
  );
  assertStringIncludes(can!, "wakeup_cancelled w_3");
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
