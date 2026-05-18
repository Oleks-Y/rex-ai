// Unit tests for the Tracer + formatter. No subprocess involvement —
// these check event ordering, persistence, env-var fallback, error
// containment, and the debug formatter shape.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { formatTraceEvent, Tracer } from "../../src/trace.ts";
import type { TraceEvent } from "../../src/types.ts";

Deno.test("emit: fills ts and seq monotonically", async () => {
  const events: TraceEvent[] = [];
  const tracer = Tracer.fromOptions({
    onTrace: (e) => {
      events.push(e);
    },
    debug: false,
  });
  await tracer.emit({ type: "step_started", index: 1 });
  await tracer.emit({ type: "step_started", index: 2 });
  await tracer.emit({ type: "step_started", index: 3 });
  await tracer.close();

  assertEquals(events.length, 3);
  assertEquals(events[0].seq, 0);
  assertEquals(events[1].seq, 1);
  assertEquals(events[2].seq, 2);
  assert(events[0].ts <= events[1].ts);
  assert(events[1].ts <= events[2].ts);
});

Deno.test("emit: debug formatter writes to debugWrite when enabled", async () => {
  const lines: string[] = [];
  const tracer = Tracer.fromOptions({
    debug: true,
    debugWrite: (l) => lines.push(l),
  });
  await tracer.emit({ type: "step_started", index: 1 });
  await tracer.emit({
    type: "tool_call_finished",
    index: 1,
    callId: "c1",
    name: "fetchIssues",
    ok: true,
    resultBytes: 1284,
    durationMs: 42,
  });
  await tracer.close();

  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0], "step_started");
  assertStringIncludes(lines[0], "index=1");
  assertStringIncludes(lines[1], "tool_call_finished");
  assertStringIncludes(lines[1], "name=fetchIssues");
  assertStringIncludes(lines[1], "ok=true");
  assertStringIncludes(lines[1], "durationMs=42");
});

Deno.test("emit: debug off → debugWrite not called", async () => {
  const lines: string[] = [];
  const tracer = Tracer.fromOptions({
    debug: false,
    debugWrite: (l) => lines.push(l),
  });
  await tracer.emit({ type: "step_started", index: 1 });
  await tracer.close();
  assertEquals(lines.length, 0);
});

Deno.test("REX_DEBUG env var: truthy values turn debug on", async () => {
  for (const raw of ["1", "true", "yes", "on", "anything"]) {
    const lines: string[] = [];
    const tracer = Tracer.fromOptions({
      envGet: (n) => (n === "REX_DEBUG" ? raw : undefined),
      debugWrite: (l) => lines.push(l),
    });
    await tracer.emit({ type: "step_started", index: 1 });
    await tracer.close();
    assertEquals(lines.length, 1, `expected debug ON for REX_DEBUG="${raw}"`);
  }
});

Deno.test("REX_DEBUG env var: falsy values keep debug off", async () => {
  for (const raw of ["", "0", "false", "no", "off"]) {
    const lines: string[] = [];
    const tracer = Tracer.fromOptions({
      envGet: (n) => (n === "REX_DEBUG" ? raw : undefined),
      debugWrite: (l) => lines.push(l),
    });
    await tracer.emit({ type: "step_started", index: 1 });
    await tracer.close();
    assertEquals(lines.length, 0, `expected debug OFF for REX_DEBUG="${raw}"`);
  }
});

Deno.test("explicit debug=false overrides env var", async () => {
  const lines: string[] = [];
  const tracer = Tracer.fromOptions({
    debug: false,
    envGet: () => "1",
    debugWrite: (l) => lines.push(l),
  });
  await tracer.emit({ type: "step_started", index: 1 });
  await tracer.close();
  assertEquals(lines.length, 0);
});

Deno.test("persistTrace: writes JSONL to <sessionDir>/trace.jsonl", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rex-trace-test-" });
  try {
    const tracer = Tracer.fromOptions({
      debug: false,
      persistTrace: true,
      sessionDir: tmp,
    });
    await tracer.emit({ type: "step_started", index: 1 });
    await tracer.emit({
      type: "tool_call_started",
      index: 1,
      callId: "c1",
      name: "foo",
      argsBytes: 12,
    });
    await tracer.close();

    const content = await Deno.readTextFile(join(tmp, "trace.jsonl"));
    const lines = content.trim().split("\n");
    assertEquals(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assertEquals(first.type, "step_started");
    assertEquals(first.seq, 0);
    assertEquals(second.type, "tool_call_started");
    assertEquals(second.seq, 1);
    assertEquals(second.name, "foo");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("persistTrace without sessionDir: warns once and skips", async () => {
  const lines: string[] = [];
  const tracer = Tracer.fromOptions({
    debug: true,
    persistTrace: true,
    debugWrite: (l) => lines.push(l),
  });
  await tracer.emit({ type: "step_started", index: 1 });
  await tracer.close();
  // First line is the warning, second is the formatted event.
  assert(lines.some((l) => l.includes("persistTrace requested but no sessionId")));
});

Deno.test("onTrace error is swallowed and reported once", async () => {
  const debugLines: string[] = [];
  let calls = 0;
  const tracer = Tracer.fromOptions({
    debug: true,
    debugWrite: (l) => debugLines.push(l),
    onTrace: () => {
      calls++;
      throw new Error("boom");
    },
  });
  await tracer.emit({ type: "step_started", index: 1 });
  await tracer.emit({ type: "step_started", index: 2 });
  await tracer.emit({ type: "step_started", index: 3 });
  await tracer.close();

  assertEquals(calls, 3, "onTrace was called for every event despite throwing");
  const errReports = debugLines.filter((l) => l.includes("onTrace threw"));
  assertEquals(errReports.length, 1, "first error reported, subsequent silenced");
});

Deno.test("close: emits after close are no-ops", async () => {
  const events: TraceEvent[] = [];
  const tracer = Tracer.fromOptions({
    onTrace: (e) => {
      events.push(e);
    },
    debug: false,
  });
  await tracer.emit({ type: "step_started", index: 1 });
  await tracer.close();
  await tracer.emit({ type: "step_started", index: 2 });
  assertEquals(events.length, 1);
});

Deno.test("formatTraceEvent: shape is grep-friendly", () => {
  const line = formatTraceEvent({
    ts: 123,
    seq: 7,
    type: "tool_call_finished",
    index: 2,
    callId: "abc",
    name: "fetchIssues",
    ok: true,
    resultBytes: 1024,
    durationMs: 42,
  });
  // [rex   123ms #007 tool_call_finished] index=2 callId=abc name=fetchIssues ok=true resultBytes=1024 durationMs=42
  assertStringIncludes(line, "[rex");
  assertStringIncludes(line, "123ms");
  assertStringIncludes(line, "#007");
  assertStringIncludes(line, "tool_call_finished");
  assertStringIncludes(line, "name=fetchIssues");
  assertStringIncludes(line, "ok=true");
});

Deno.test("formatTraceEvent: omits undefined fields", () => {
  const line = formatTraceEvent({
    ts: 0,
    seq: 0,
    type: "tool_call_finished",
    index: 1,
    callId: "x",
    name: "t",
    ok: true,
    resultBytes: 5,
    durationMs: 1,
  });
  assert(!line.includes("error="), "no error= field when undefined");
});

Deno.test("formatTraceEvent: quotes strings with spaces", () => {
  const line = formatTraceEvent({
    ts: 0,
    seq: 0,
    type: "run_started",
    task: "do the thing now",
    maxSteps: 3,
    sessionId: null,
  });
  assertStringIncludes(line, `task="do the thing now"`);
});

Deno.test("isActive: reflects whether anyone is listening", async () => {
  const noop = Tracer.fromOptions({ debug: false });
  assert(!noop.isActive);
  await noop.close();

  const debugOn = Tracer.fromOptions({ debug: true, debugWrite: () => {} });
  assert(debugOn.isActive);
  await debugOn.close();

  const cb = Tracer.fromOptions({ debug: false, onTrace: () => {} });
  assert(cb.isActive);
  await cb.close();
});
