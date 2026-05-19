// Dreamer integration tests — real Deno subprocess sandboxes + scripted
// mock models. Exercises the cross-cutting contract:
//
//   - the dreamer's sandbox can read the parent dir (its readonly mount)
//   - the dreamer's sandbox CANNOT write to the parent dir
//   - dream.jsonl accumulates one line per lifecycle transition
//   - `awaitDreamsOnClose: true` blocks Agent.run until dreams drain
//
// These tests share the same mock-model + temp-root harness as the
// existing agent_session integration tests.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent } from "../../src/agent.ts";
import {
  defineDreamer,
  DreamPool,
  type DreamLifecycleEvent,
  type DreamPayload,
} from "../../src/dreamer.ts";
import { SessionStore } from "../../src/session.ts";
import { DEFAULT_SIZE_CAPS, type SandboxEvent } from "../../src/types.ts";

/** Build a mock model that returns each script entry in order, wrapped
 *  in a ts fence. After the scripts run out, the last script repeats
 *  forever (so an over-stepping run terminates predictably). */
function mockModel(scripts: string[]): { model: LanguageModelV2 } {
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: (_opts) => {
      const next = scripts[i] ?? scripts[scripts.length - 1];
      i++;
      const text = "```ts\n" + next + "\n```";
      return Promise.resolve({
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        content: [{ type: "text", text }],
        warnings: [],
      });
    },
    doStream: () => { throw new Error("not implemented"); },
  };
  return { model };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "rex-dreamer-int-" });
  try { return await fn(root); } finally {
    try { await Deno.remove(root, { recursive: true }); } catch { /* */ }
  }
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await Deno.readTextFile(path);
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}

Deno.test("dreamer fires on parent reply, writes dream.jsonl + reaches reply", async () => {
  await withTempRoot(async (root) => {
    // Parent does one reflect then one reply.
    const parent = mockModel([
      'await reflect({ note: "thinking" });',
      'await reply("here is the answer");',
    ]);
    // Dreamer is given the standing task, then sees a synthetic
    // user_message per fire. It just replies with a short summary.
    const dreamer = mockModel([
      'await reply("noted parent activity");',
      // For any subsequent fires (turn_end could also queue):
      'await reply("acknowledged");',
    ]);

    const events: DreamLifecycleEvent[] = [];
    const agent = new Agent({
      model: parent.model,
      task: "say hi",
      sessionId: "p1",
      sessionsRoot: root,
      maxSteps: 4,
      dreamers: [
        defineDreamer({
          name: "watcher",
          triggers: ["reply"],
          model: dreamer.model,
          task: "Watch the agent's replies.",
          maxStepsPerFire: 2,
        }),
      ],
      onDream: (ev) => events.push(ev),
      awaitDreamsOnClose: true,
    });

    const result = await agent.run();
    assertEquals(result.kind, "reply");

    // dream.jsonl exists and has at least fired + started + finished.
    const dreamJsonlPath = join(root, "sessions", "p1", "dreams", "watcher", "dream.jsonl");
    const rows = await readJsonl(dreamJsonlPath);
    // 1 reply-triggered fire → fired + started + finished (3 rows).
    const kinds = rows.map((r) => r.kind);
    assertEquals(kinds.includes("fired"), true);
    assertEquals(kinds.includes("started"), true);
    assertEquals(kinds.includes("finished"), true);

    // onDream callback got everything dream.jsonl got.
    const onDreamKinds = events.map((e) => e.kind);
    assertEquals(onDreamKinds.includes("fired"), true);
    assertEquals(onDreamKinds.includes("finished"), true);

    // The dreamer's own transcript.jsonl should exist too (real Agent
    // wrote at least the reply step there).
    const dreamerTranscript = join(
      root,
      "sessions",
      "p1",
      "dreams",
      "watcher",
      "transcript.jsonl",
    );
    const transcriptText = await Deno.readTextFile(dreamerTranscript);
    // At least one transcript line.
    assertEquals(transcriptText.split("\n").filter((l) => l.length > 0).length >= 1, true);
  });
});

Deno.test("dreamer can read parent dir; cannot write parent dir", async () => {
  await withTempRoot(async (root) => {
    const parent = mockModel(['await reply("done");']);

    // The dreamer's code tries two filesystem operations: a read (should
    // succeed) and a write (should fail with permission_denied). The
    // last step replies with the verdict.
    //
    // We pre-write a file in the parent dir BEFORE the parent runs so
    // the dreamer has something concrete to find on its readonly mount.
    const parentDir = join(root, "sessions", "p1");
    await Deno.mkdir(parentDir, { recursive: true });
    await Deno.writeTextFile(join(parentDir, "transcript.jsonl"), "");

    const dreamer = mockModel([
      // step 1: try to read the parent's transcript.jsonl
      `const txt = await Deno.readTextFile("${join(parentDir, "transcript.jsonl")}");
       await reflect({ readOk: true, bytes: txt.length });`,
      // step 2: try to write to it (should hit permission_denied → terminal)
      `await Deno.writeTextFile("${join(parentDir, "transcript.jsonl")}", "hacked");
       await reply("should not reach here");`,
    ]);

    let finishedEvent: DreamLifecycleEvent | null = null;
    const agent = new Agent({
      model: parent.model,
      task: "say hi",
      sessionId: "p1",
      sessionsRoot: root,
      maxSteps: 2,
      dreamers: [
        defineDreamer({
          name: "spy",
          triggers: ["reply"],
          model: dreamer.model,
          task: "Inspect the parent's transcript.",
          maxStepsPerFire: 3,
        }),
      ],
      onDream: (ev) => {
        if (ev.kind === "finished") finishedEvent = ev;
      },
      awaitDreamsOnClose: true,
    });
    await agent.run();

    // The dreamer's run should NOT have replied "should not reach here"
    // (the write should have been denied). It either aborted (perm
    // denied) or exhausted; either is OK — the contract is "no write".
    if (finishedEvent !== null) {
      const ev = finishedEvent as DreamLifecycleEvent;
      if (ev.kind === "finished") {
        if (ev.ok) {
          assertEquals(
            ev.reply === "should not reach here",
            false,
            "dreamer reply should not have completed after a denied write",
          );
        }
      }
    }

    // Critical check: the parent's transcript.jsonl was NOT clobbered.
    const finalText = await Deno.readTextFile(join(parentDir, "transcript.jsonl"));
    assertEquals(finalText.includes("hacked"), false);
  });
});

Deno.test("multiple dreamers each get their own directory + dream.jsonl", async () => {
  await withTempRoot(async (root) => {
    const parent = mockModel(['await reply("hi");']);
    const dreamerA = mockModel(['await reply("a");']);
    const dreamerB = mockModel(['await reply("b");']);
    const agent = new Agent({
      model: parent.model,
      task: "go",
      sessionId: "p2",
      sessionsRoot: root,
      maxSteps: 2,
      dreamers: [
        defineDreamer({ name: "watcher-a", triggers: ["reply"], model: dreamerA.model, task: "A", maxStepsPerFire: 1 }),
        defineDreamer({ name: "watcher-b", triggers: ["reply"], model: dreamerB.model, task: "B", maxStepsPerFire: 1 }),
      ],
      awaitDreamsOnClose: true,
    });
    await agent.run();

    const aRows = await readJsonl(join(root, "sessions", "p2", "dreams", "watcher-a", "dream.jsonl"));
    const bRows = await readJsonl(join(root, "sessions", "p2", "dreams", "watcher-b", "dream.jsonl"));
    // Both fired at least once.
    assertEquals(aRows.some((r) => r.kind === "fired"), true);
    assertEquals(bRows.some((r) => r.kind === "fired"), true);
    // The dreamers are isolated — A's rows reference "watcher-a", etc.
    for (const r of aRows) assertEquals(r.dreamer, "watcher-a");
    for (const r of bRows) assertEquals(r.dreamer, "watcher-b");
  });
});

Deno.test("duplicate dreamer names → DreamPool.open throws", async () => {
  await withTempRoot(async (root) => {
    const parent = mockModel(['await reply("x");']);
    const dreamer = mockModel(['await reply("y");']);
    const agent = new Agent({
      model: parent.model,
      task: "go",
      sessionId: "dup",
      sessionsRoot: root,
      maxSteps: 1,
      dreamers: [
        defineDreamer({ name: "same", triggers: ["reply"], model: dreamer.model, task: "x" }),
        defineDreamer({ name: "same", triggers: ["reply"], model: dreamer.model, task: "x" }),
      ],
    });
    let caught: Error | null = null;
    try { await agent.run(); } catch (e) { caught = e as Error; }
    assertStringIncludes(caught!.message, "duplicate dreamer name");
  });
});

// ── DreamPool/DreamWorker direct-dispatch tests ────────────────────────
//
// These exercise the worker's close/drain/timeout semantics by driving
// DreamPool.dispatch directly, bypassing the parent Agent's hot path.
// Synthetic payloads only carry what the worker actually reads —
// renderPayloadAsUserMessage formats them, the dreamer's mock model
// scripts the reply.

function mkSyntheticPayload(label: string): DreamPayload {
  const ev: SandboxEvent = { kind: "reply", message: label, logs: [] };
  return {
    event: ev,
    llmCompletion: `// ${label}`,
    code: `// ${label}`,
    stepIndex: 1,
    task: "parent task",
    userInputs: [{ kind: "task", content: "parent task", turn: 1 }],
    turn: 1,
  };
}

async function openParentSession(root: string, id: string): Promise<SessionStore> {
  return await SessionStore.open({
    sessionId: id,
    rootDir: root,
    sizeCaps: DEFAULT_SIZE_CAPS,
  });
}

Deno.test("fix #1 — standing-task drain: first fire reflects payload, not standing task", async () => {
  await withTempRoot(async (root) => {
    // Dreamer script[0] is the standing task's reply. script[1..] are
    // for each subsequent fire. If we DIDN'T drain the standing task,
    // the first fire would consume script[0] and the second fire would
    // consume script[1]. With the drain in place, the first fire
    // consumes script[1] ("fire-1-reply") and lifecycle events confirm
    // that exactly one payload-driven `finished` corresponds to the one
    // payload we dispatched.
    const dreamer = mockModel([
      'await reply("standing-task-reply");',
      'await reply("fire-1-reply");',
      'await reply("fire-2-reply");',
    ]);

    const parentSession = await openParentSession(root, "drain-test");
    const events: DreamLifecycleEvent[] = [];
    const pool = await DreamPool.open({
      parentSession,
      dreamers: [
        defineDreamer({
          name: "watcher",
          triggers: ["reply"],
          model: dreamer.model,
          task: "Watch.",
          maxStepsPerFire: 2,
        }),
      ],
      onDream: (ev) => events.push(ev),
    });

    pool.dispatch(mkSyntheticPayload("fire-1"));
    await pool.close({ awaitDrain: true });

    // Exactly one fired/started/finished triple — the standing-task
    // terminal must have been drained silently (no lifecycle emission).
    const fired = events.filter((e) => e.kind === "fired");
    const started = events.filter((e) => e.kind === "started");
    const finished = events.filter((e) => e.kind === "finished");
    assertEquals(fired.length, 1, "exactly one fired event");
    assertEquals(started.length, 1, "exactly one started event");
    assertEquals(finished.length, 1, "exactly one finished event");

    // The fire's reply must be from script[1], not script[0]. (If the
    // standing-task drain were missing, the first fire's `finished.reply`
    // would be "standing-task-reply".)
    const fin = finished[0];
    if (fin.kind !== "finished") throw new Error("typing");
    assertEquals(fin.ok, true, `expected ok finish, got: ${fin.error}`);
    assertEquals(
      fin.reply,
      "fire-1-reply",
      "first fire must see script[1], not the standing-task reply",
    );
  });
});

Deno.test("fix #2 — awaitDrain:true drains every queued fire even when close races enqueue", async () => {
  await withTempRoot(async (root) => {
    const dreamer = mockModel([
      'await reply("standing");', // drained silently
      'await reply("a");',
      'await reply("b");',
      'await reply("c");',
    ]);

    const parentSession = await openParentSession(root, "drain-multi");
    const events: DreamLifecycleEvent[] = [];
    const pool = await DreamPool.open({
      parentSession,
      dreamers: [
        defineDreamer({
          name: "watcher",
          triggers: ["reply"],
          model: dreamer.model,
          task: "Watch.",
          maxStepsPerFire: 2,
        }),
      ],
      onDream: (ev) => events.push(ev),
    });

    // Enqueue three fires immediately, then close with awaitDrain:true.
    // Without fix #2, close set `#closed=true` before the drain loop
    // had a chance to pull the queued items, leaving them stranded.
    pool.dispatch(mkSyntheticPayload("a"));
    pool.dispatch(mkSyntheticPayload("b"));
    pool.dispatch(mkSyntheticPayload("c"));
    await pool.close({ awaitDrain: true });

    const finished = events.filter((e) => e.kind === "finished");
    assertEquals(
      finished.length,
      3,
      `awaitDrain:true must finish every queued fire (got ${finished.length})`,
    );
    const replies = finished.map((f) => (f.kind === "finished" ? f.reply : ""));
    assertEquals(replies, ["a", "b", "c"]);
  });
});

Deno.test({
  name: "fix #3 — awaitDrain:false returns within fast-close grace despite a slow in-sandbox step",
  // The fast-close path intentionally orphans `session.close()` so a
  // wedged dreamer can't block the parent from exiting. The dreamer's
  // sandbox SIGKILLs its subprocess after its own 2s grace, but that
  // happens *after* this test returns. The orphaned cleanup is what
  // we're TESTING — the leaks are by design here.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  await withTempRoot(async (root) => {
    // Standing task is a fast reply. The fire's code hangs INSIDE the
    // sandbox (via a long setTimeout). This shape is cancellable —
    // sandbox.close() force-kills the subprocess after its own 2s
    // grace, so leaks are bounded. (A wedged model.doGenerate would
    // also be observable via fast-close grace, but it can't be killed
    // without AbortSignal plumbing — a separate fix.)
    const slowModel = mockModel([
      'await reply("standing");',
      // 30s in-sandbox hang
      'await new Promise((r) => setTimeout(r, 30_000)); await reply("late");',
    ]);

    const parentSession = await openParentSession(root, "fast-close");
    const events: DreamLifecycleEvent[] = [];
    const pool = await DreamPool.open({
      parentSession,
      dreamers: [
        defineDreamer({
          name: "watcher",
          triggers: ["reply"],
          model: slowModel.model,
          task: "Watch.",
          maxStepsPerFire: 2,
          fireTimeoutMs: 60_000, // generous — we're testing close grace, not fire timeout
        }),
      ],
      onDream: (ev) => events.push(ev),
    });

    pool.dispatch(mkSyntheticPayload("hangs"));
    // Give the fire a moment to start.
    await new Promise((r) => setTimeout(r, 200));

    const t0 = performance.now();
    await pool.close({ awaitDrain: false });
    const elapsed = performance.now() - t0;
    // Fast-close grace is 2s in DreamWorker; allow generous headroom.
    if (elapsed > 5_000) {
      throw new Error(
        `awaitDrain:false took ${elapsed.toFixed(0)}ms — grace not enforced`,
      );
    }

    // A `dropped:cancelled_on_parent_close` should have been emitted
    // for the in-flight payload that we abandoned.
    const droppedActive = events.filter((e) =>
      e.kind === "dropped" && e.reason === "cancelled_on_parent_close"
    );
    assertEquals(
      droppedActive.length >= 1,
      true,
      "expected at least one 'cancelled_on_parent_close' dropped event for the abandoned fire",
    );
  });
  },
});

Deno.test({
  name: "fix #4 — fire timeout emits dropped:fire_timeout + finished:ok=false; outbox waiter doesn't leak",
  // The timeout path orphans the wedged session's close (worker is
  // stuck on the in-sandbox hang; sandbox SIGKILLs after its own 2s
  // grace, but that lands after this test returns). Disabling
  // sanitizers documents that the leak is the design's correct
  // behavior — preventing the parent from being held hostage by a
  // wedged dreamer.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  await withTempRoot(async (root) => {
    // Standing task replies fast. Fire's code hangs IN-SANDBOX (so
    // sandbox.close() can SIGKILL it). fireTimeoutMs=500 forces the
    // timeout path. Assert the lifecycle contract:
    //   - one `dropped: fire_timeout` for the fire
    //   - one `finished` with ok:false
    //   - no late "STALE" reply attributed to any fire
    // (Full lock-recovery — reopening the dreamer session under the
    // same name after timeout — requires AbortSignal-plumbed model
    // cancellation; out of scope for this PR.)
    const flakyModel = mockModel([
      'await reply("standing");',
      'await new Promise((r) => setTimeout(r, 5_000)); await reply("STALE");',
    ]);

    const parentSession = await openParentSession(root, "timeout-recover");
    const events: DreamLifecycleEvent[] = [];
    const pool = await DreamPool.open({
      parentSession,
      dreamers: [
        defineDreamer({
          name: "watcher",
          triggers: ["reply"],
          model: flakyModel.model,
          task: "Watch.",
          maxStepsPerFire: 2,
          fireTimeoutMs: 500, // tight — forces timeout path on the hang
        }),
      ],
      onDream: (ev) => events.push(ev),
    });

    pool.dispatch(mkSyntheticPayload("first"));
    // Wait long enough for the timeout path to fire (just over
    // fireTimeoutMs).
    await new Promise((r) => setTimeout(r, 1_200));
    await pool.close({ awaitDrain: false });

    const finished = events.filter((e) => e.kind === "finished");
    const dropped = events.filter((e) => e.kind === "dropped");
    assertEquals(
      dropped.some((d) => d.kind === "dropped" && d.reason === "fire_timeout"),
      true,
      "expected fire_timeout dropped event",
    );
    assertEquals(
      finished.length >= 1,
      true,
      "expected at least one finished event for the timed-out fire",
    );
    // No fire should be attributed the late STALE resolution.
    const replies = finished.map((f) =>
      f.kind === "finished" ? (f.ok ? f.reply : "") : ""
    );
    assertEquals(
      replies.includes("STALE"),
      false,
      "fire timeout must not attribute the late in-sandbox result to any fire",
    );
  });
  },
});

Deno.test("dreamer with permissions.write inside parent dir → throws on open", async () => {
  await withTempRoot(async (root) => {
    const parent = mockModel(['await reply("x");']);
    const dreamer = mockModel(['await reply("y");']);
    const parentDir = join(root, "sessions", "bad");
    const agent = new Agent({
      model: parent.model,
      task: "go",
      sessionId: "bad",
      sessionsRoot: root,
      maxSteps: 1,
      dreamers: [
        defineDreamer({
          name: "evil",
          triggers: ["reply"],
          model: dreamer.model,
          task: "x",
          permissions: { write: [parentDir] }, // attempt parent-dir write
        }),
      ],
    });
    let caught: Error | null = null;
    try { await agent.run(); } catch (e) { caught = e as Error; }
    assertStringIncludes(caught!.message, "parent session dir");
  });
});
