// Unit tests for the dreamer module — types, validation, and trigger
// matching. The runtime (DreamPool / DreamWorker) is exercised in
// integration tests once it lands.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import {
  applyBackpressure,
  defineDreamer,
  DreamJsonlWriter,
  dreamerMatches,
  dreamerTriggerKind,
  type DreamerDefinition,
  type DreamLifecycleEvent,
  type DreamPayload,
  renderPayloadAsUserMessage,
} from "../../src/dreamer.ts";
import type { SandboxEvent } from "../../src/types.ts";

/** Minimal model stub — defineDreamer only checks truthiness; no calls. */
const STUB_MODEL = {
  specificationVersion: "v2",
  provider: "rex-mock",
  modelId: "rex-mock",
  supportedUrls: {},
  // deno-lint-ignore no-explicit-any
} as unknown as LanguageModelV2;

const VALID: DreamerDefinition = {
  name: "ticket-writer",
  triggers: ["reply"],
  model: STUB_MODEL,
  task: "Watch the agent's replies for unresolved issues.",
};

function withName(name: string): DreamerDefinition {
  return { ...VALID, name };
}

Deno.test("defineDreamer accepts a minimal valid definition", () => {
  const d = defineDreamer(VALID);
  assertEquals(d.name, "ticket-writer");
  assertEquals(d.triggers, ["reply"]);
});

Deno.test("defineDreamer rejects empty name", () => {
  assertThrows(
    () => defineDreamer(withName("")),
    Error,
    "non-empty string",
  );
});

Deno.test("defineDreamer rejects unsafe names", () => {
  // path-traversal style + slashes + leading dot + whitespace
  for (const n of ["..", "../x", "foo/bar", ".hidden", "foo bar", "/abs"]) {
    assertThrows(() => defineDreamer(withName(n)), Error, "filesystem-safe");
  }
});

Deno.test("defineDreamer accepts dashes, underscores, dots after first char", () => {
  for (const n of ["foo", "foo-bar", "foo_bar", "foo.bar", "f1", "F1-x_y.z"]) {
    defineDreamer(withName(n));
  }
});

Deno.test("defineDreamer rejects empty triggers array", () => {
  assertThrows(
    () => defineDreamer({ ...VALID, triggers: [] }),
    Error,
    "non-empty array",
  );
});

Deno.test("defineDreamer rejects unknown trigger", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => defineDreamer({ ...VALID, triggers: ["nope" as any] }),
    Error,
    `unknown trigger "nope"`,
  );
});

Deno.test("defineDreamer accepts dreamer-only triggers", () => {
  defineDreamer({ ...VALID, triggers: ["user_message"] });
  defineDreamer({ ...VALID, triggers: ["turn_end"] });
  defineDreamer({ ...VALID, triggers: ["reply", "user_message", "turn_end"] });
});

Deno.test("defineDreamer rejects missing model", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => defineDreamer({ ...VALID, model: undefined as any }),
    Error,
    "model",
  );
});

Deno.test("defineDreamer rejects empty task", () => {
  assertThrows(
    () => defineDreamer({ ...VALID, task: "" }),
    Error,
    "task",
  );
});

Deno.test("defineDreamer rejects non-positive maxStepsPerFire", () => {
  assertThrows(
    () => defineDreamer({ ...VALID, maxStepsPerFire: 0 }),
    Error,
    "positive integer",
  );
  assertThrows(
    () => defineDreamer({ ...VALID, maxStepsPerFire: -1 }),
    Error,
    "positive integer",
  );
  assertThrows(
    () => defineDreamer({ ...VALID, maxStepsPerFire: 1.5 }),
    Error,
    "positive integer",
  );
});

Deno.test("defineDreamer rejects unknown backpressure", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => defineDreamer({ ...VALID, backpressure: "burn" as any }),
    Error,
    "unknown backpressure",
  );
});

Deno.test("defineDreamer accepts all valid backpressure policies", () => {
  for (const bp of ["queue", "drop_newest", "drop_oldest", "coalesce"] as const) {
    defineDreamer({ ...VALID, backpressure: bp });
  }
});

Deno.test("defineDreamer rejects non-positive fireTimeoutMs / maxQueueDepth", () => {
  assertThrows(() => defineDreamer({ ...VALID, fireTimeoutMs: 0 }), Error, "positive integer");
  assertThrows(() => defineDreamer({ ...VALID, maxQueueDepth: 0 }), Error, "positive integer");
});

// ── dreamerMatches ─────────────────────────────────────────────────────

function payloadForEvent(ev: SandboxEvent): DreamPayload {
  return {
    event: ev,
    llmCompletion: "",
    code: "",
    stepIndex: 1,
    task: "t",
    userInputs: [{ kind: "task", content: "t", turn: 1 }],
    turn: 1,
  };
}

const REPLY_PAYLOAD = payloadForEvent({
  kind: "reply",
  message: "ok",
  logs: [],
});

const REFLECT_PAYLOAD = payloadForEvent({
  kind: "reflect",
  state: { x: 1 },
  logs: [],
});

Deno.test("dreamerMatches: explicit trigger matches event.kind", () => {
  assertEquals(dreamerMatches({ ...VALID, triggers: ["reply"] }, REPLY_PAYLOAD), true);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["reflect"] }, REPLY_PAYLOAD), false);
});

Deno.test('dreamerMatches: "any" matches every sandbox event', () => {
  assertEquals(dreamerMatches({ ...VALID, triggers: ["any"] }, REPLY_PAYLOAD), true);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["any"] }, REFLECT_PAYLOAD), true);
});

Deno.test('dreamerMatches: "any" does NOT match synthetic triggers', () => {
  // Critical invariant: a dreamer subscribed to "any" should not be
  // surprised by conversation-level triggers it didn't ask for.
  const p: DreamPayload = {
    ...REPLY_PAYLOAD,
    syntheticTrigger: "user_message",
  };
  assertEquals(dreamerMatches({ ...VALID, triggers: ["any"] }, p), false);
});

Deno.test("dreamerMatches: synthetic triggers require explicit subscription", () => {
  const userMsg: DreamPayload = { ...REPLY_PAYLOAD, syntheticTrigger: "user_message" };
  const turnEnd: DreamPayload = { ...REPLY_PAYLOAD, syntheticTrigger: "turn_end" };
  assertEquals(dreamerMatches({ ...VALID, triggers: ["user_message"] }, userMsg), true);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["user_message"] }, turnEnd), false);
  assertEquals(dreamerMatches({ ...VALID, triggers: ["turn_end"] }, turnEnd), true);
});

// ── dreamerTriggerKind ─────────────────────────────────────────────────

Deno.test("dreamerTriggerKind: sandbox event returns event.kind", () => {
  assertEquals(dreamerTriggerKind(REPLY_PAYLOAD), "reply");
  assertEquals(dreamerTriggerKind(REFLECT_PAYLOAD), "reflect");
});

Deno.test("dreamerTriggerKind: synthetic trigger takes precedence", () => {
  const p: DreamPayload = { ...REPLY_PAYLOAD, syntheticTrigger: "user_message" };
  assertEquals(dreamerTriggerKind(p), "user_message");
});

// ── applyBackpressure ─────────────────────────────────────────────────
//
// Pure-function tests; no Agent, no sandbox. Reasoning about the queue
// in isolation is the whole reason we extracted this.

interface PolicyHarness {
  queue: DreamPayload[];
  ids: WeakMap<DreamPayload, string>;
  events: DreamLifecycleEvent[];
  nextId: number;
  /** Emulates `DreamWorker.enqueue`'s id assignment + emit fanout. */
  enqueue(payload: DreamPayload, opts?: { running?: boolean }): void;
}

function harness(def: DreamerDefinition): PolicyHarness {
  const h: PolicyHarness = {
    queue: [],
    ids: new WeakMap<DreamPayload, string>(),
    events: [],
    nextId: 1,
    enqueue(payload, opts) {
      const id = `${def.name}#${h.nextId++}`;
      h.ids.set(payload, id);
      applyBackpressure({
        payload,
        payloadId: id,
        queue: h.queue,
        payloadIds: h.ids,
        running: opts?.running ?? false,
        def,
        emit: (ev) => h.events.push(ev),
      });
    },
  };
  return h;
}

function mkPayload(label: string, kind: SandboxEvent["kind"] = "reply"): DreamPayload {
  const ev: SandboxEvent = kind === "reply"
    ? { kind: "reply", message: label, logs: [] }
    : { kind: "reflect", state: { label }, logs: [] };
  return {
    event: ev,
    llmCompletion: `completion-${label}`,
    code: `// ${label}`,
    stepIndex: 1,
    task: "t",
    userInputs: [{ kind: "task", content: "t", turn: 1 }],
    turn: 1,
  };
}

Deno.test("backpressure: queue policy buffers fires under cap (cap counts running)", () => {
  // cap=3, running=true → 1 in-flight + up to 2 queued without eviction.
  const h = harness({ ...VALID, backpressure: "queue", maxQueueDepth: 3 });
  h.enqueue(mkPayload("a"), { running: true });
  h.enqueue(mkPayload("b"), { running: true });
  // queueDepth on the third = 2 (queue) + 1 (running) = 3 ≥ cap → evicts.
  // Use only 2 enqueues to stay under the cap.
  assertEquals(h.queue.length, 2);
  assertEquals(h.events.filter((e) => e.kind === "fired").length, 2);
  assertEquals(h.events.filter((e) => e.kind === "dropped").length, 0);
});

Deno.test("backpressure: queue policy not-running can fill to cap", () => {
  // running=false → cap=3 means up to 3 in the queue without eviction.
  const h = harness({ ...VALID, backpressure: "queue", maxQueueDepth: 3 });
  h.enqueue(mkPayload("a"), { running: false });
  h.enqueue(mkPayload("b"), { running: false });
  h.enqueue(mkPayload("c"), { running: false });
  assertEquals(h.queue.length, 3);
  assertEquals(h.events.filter((e) => e.kind === "dropped").length, 0);
});

Deno.test("backpressure: queue full → drop_oldest fallback emits dropped", () => {
  const h = harness({ ...VALID, backpressure: "queue", maxQueueDepth: 2 });
  const a = mkPayload("a"); const b = mkPayload("b"); const c = mkPayload("c");
  h.enqueue(a, { running: false });
  h.enqueue(b, { running: false });
  h.enqueue(c, { running: false });   // queueDepth was 2 ≥ cap 2 → evict oldest
  assertEquals(h.queue.length, 2);
  assertEquals(h.queue[0], b);
  assertEquals(h.queue[1], c);
  const dropped = h.events.filter((e) => e.kind === "dropped");
  assertEquals(dropped.length, 1);
  assertEquals((dropped[0] as { reason: string }).reason, "queue_full");
});

Deno.test("backpressure: drop_newest rejects fires while busy or queued", () => {
  const h = harness({ ...VALID, backpressure: "drop_newest" });
  h.enqueue(mkPayload("a"), { running: false }); // accepted
  h.enqueue(mkPayload("b"), { running: true });  // rejected — busy
  h.enqueue(mkPayload("c"), { running: true });  // rejected — busy
  assertEquals(h.queue.length, 1);
  const dropped = h.events.filter((e) => e.kind === "dropped");
  assertEquals(dropped.length, 2);
  for (const d of dropped) assertEquals((d as { reason: string }).reason, "drop_newest");
});

Deno.test("backpressure: drop_oldest evicts the head when a new fire arrives", () => {
  const h = harness({ ...VALID, backpressure: "drop_oldest" });
  const a = mkPayload("a"); const b = mkPayload("b"); const c = mkPayload("c");
  h.enqueue(a, { running: true });
  h.enqueue(b, { running: true });   // evicts a
  h.enqueue(c, { running: true });   // evicts b
  assertEquals(h.queue.length, 1);
  assertEquals(h.queue[0], c);
  assertEquals(h.events.filter((e) => e.kind === "dropped").length, 2);
});

Deno.test("backpressure: coalesce merges same-kind queued fires", () => {
  const h = harness({ ...VALID, backpressure: "coalesce" });
  h.enqueue(mkPayload("a", "reply"), { running: true });
  h.enqueue(mkPayload("b", "reply"), { running: true });   // coalesced
  h.enqueue(mkPayload("c", "reply"), { running: true });   // coalesced
  // Single merged payload remains.
  assertEquals(h.queue.length, 1);
  // 3 fired, 2 dropped(coalesced).
  assertEquals(h.events.filter((e) => e.kind === "fired").length, 3);
  const dropped = h.events.filter((e) => e.kind === "dropped");
  assertEquals(dropped.length, 2);
  for (const d of dropped) assertEquals((d as { reason: string }).reason, "coalesced");
});

Deno.test("backpressure: coalesce does NOT merge different-kind fires", () => {
  const h = harness({ ...VALID, backpressure: "coalesce" });
  h.enqueue(mkPayload("a", "reply"), { running: true });
  h.enqueue(mkPayload("b", "reflect"), { running: true });
  h.enqueue(mkPayload("c", "reply"), { running: true });
  // reply, reflect, reply — different kinds so three queue entries.
  assertEquals(h.queue.length, 3);
  assertEquals(h.events.filter((e) => e.kind === "fired").length, 3);
  assertEquals(h.events.filter((e) => e.kind === "dropped").length, 0);
});

Deno.test("applyBackpressure: always emits `fired` for the incoming payload", () => {
  const h = harness({ ...VALID, backpressure: "drop_newest" });
  h.enqueue(mkPayload("a"), { running: true });   // dropped — but still fired
  assertEquals(h.events.filter((e) => e.kind === "fired").length, 1);
});

// ── renderPayloadAsUserMessage ────────────────────────────────────────

Deno.test("renderPayloadAsUserMessage: includes trigger, step, code, event, logs", () => {
  const payload: DreamPayload = {
    event: { kind: "reply", message: "Sent!", logs: [{ level: "log", args: ["called", "tool"] }] },
    llmCompletion: "I'll call the email tool…",
    code: "await sendEmail(); return reply('Sent!');",
    stepIndex: 4,
    task: "Email Alice",
    userInputs: [{ kind: "task", content: "Email Alice", turn: 1 }],
    turn: 1,
  };
  const out = renderPayloadAsUserMessage(payload);
  assertStringIncludes(out, "trigger: reply");
  assertStringIncludes(out, "Parent step index: 4");
  assertStringIncludes(out, "I'll call the email tool");
  assertStringIncludes(out, "await sendEmail()");
  assertStringIncludes(out, "Sent!");
  assertStringIncludes(out, "Email Alice");
  assertStringIncludes(out, "[log]");
});

Deno.test("renderPayloadAsUserMessage: uses synthetic trigger in the heading", () => {
  const payload: DreamPayload = {
    event: { kind: "reply", message: "", logs: [] },
    llmCompletion: "",
    code: "",
    stepIndex: 1,
    task: "t",
    userInputs: [{ kind: "task", content: "t", turn: 1 }],
    turn: 1,
    syntheticTrigger: "user_message",
  };
  assertStringIncludes(renderPayloadAsUserMessage(payload), "trigger: user_message");
});

Deno.test("renderPayloadAsUserMessage: collapses code-free / completion-free fires", () => {
  const payload: DreamPayload = {
    event: { kind: "reply", message: "x", logs: [] },
    llmCompletion: "",
    code: "",
    stepIndex: 1,
    task: "t",
    userInputs: [],
    turn: 1,
  };
  const out = renderPayloadAsUserMessage(payload);
  // No "Parent LLM completion (raw)" header when empty.
  assertEquals(out.includes("Parent LLM completion (raw)"), false);
  assertEquals(out.includes("Parent code (extracted)"), false);
});

// ── coalesce userInput merging ─────────────────────────────────────────

// ── DreamJsonlWriter ─────────────────────────────────────────────────

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rex-dream-writer-" });
  try { return await fn(dir); } finally {
    try { await Deno.remove(dir, { recursive: true }); } catch { /* */ }
  }
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await Deno.readTextFile(path);
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

Deno.test("DreamJsonlWriter: appends one JSON line per lifecycle event", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "dream.jsonl");
    const w = new DreamJsonlWriter(path);
    w.append({ kind: "fired", dreamer: "d1", triggerKind: "reply", stepIndex: 1, payloadId: "d1#1" });
    w.append({ kind: "started", dreamer: "d1", payloadId: "d1#1" });
    w.append({
      kind: "finished",
      dreamer: "d1",
      payloadId: "d1#1",
      ok: true,
      reply: "ok",
      durationMs: 12,
      steps: 1,
    });
    await w.close();

    const rows = await readJsonl(path) as Array<Record<string, unknown>>;
    assertEquals(rows.length, 3);
    assertEquals(rows[0].kind, "fired");
    assertEquals(rows[1].kind, "started");
    assertEquals(rows[2].kind, "finished");
    // Every row has an ISO timestamp.
    for (const r of rows) assertEquals(typeof r.ts, "string");
    assertEquals(rows[2].reply, "ok");
  });
});

Deno.test("DreamJsonlWriter: preserves write order under concurrent appends", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "dream.jsonl");
    const w = new DreamJsonlWriter(path);
    for (let i = 0; i < 50; i++) {
      w.append({
        kind: "fired",
        dreamer: "d",
        triggerKind: "reply",
        stepIndex: i,
        payloadId: `d#${i}`,
      });
    }
    await w.close();
    const rows = await readJsonl(path) as Array<Record<string, unknown>>;
    assertEquals(rows.length, 50);
    for (let i = 0; i < 50; i++) {
      assertEquals(rows[i].stepIndex, i);
    }
  });
});

Deno.test("DreamJsonlWriter: append after close is a no-op", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "dream.jsonl");
    const w = new DreamJsonlWriter(path);
    w.append({ kind: "fired", dreamer: "d", triggerKind: "reply", stepIndex: 1, payloadId: "d#1" });
    await w.close();
    w.append({ kind: "started", dreamer: "d", payloadId: "d#1" });
    const rows = await readJsonl(path);
    assertEquals(rows.length, 1);
  });
});

Deno.test("coalesce: merged payload preserves union of userInputs (dedup)", () => {
  const h = harness({ ...VALID, backpressure: "coalesce" });
  const a: DreamPayload = {
    ...mkPayload("a", "reply"),
    userInputs: [
      { kind: "task", content: "t1", turn: 1 },
      { kind: "message", content: "m1", turn: 1 },
    ],
  };
  const b: DreamPayload = {
    ...mkPayload("b", "reply"),
    userInputs: [
      { kind: "message", content: "m1", turn: 1 }, // dup
      { kind: "message", content: "m2", turn: 1 },
    ],
  };
  h.enqueue(a, { running: true });
  h.enqueue(b, { running: true });   // coalesced into a
  assertEquals(h.queue.length, 1);
  assertEquals(h.queue[0].userInputs.length, 3); // t1, m1 (deduped), m2
  const contents = h.queue[0].userInputs.map((u) => u.content);
  assertEquals(contents, ["t1", "m1", "m2"]);
});
