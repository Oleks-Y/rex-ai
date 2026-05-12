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
import { defineDreamer, type DreamLifecycleEvent } from "../../src/dreamer.ts";

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
