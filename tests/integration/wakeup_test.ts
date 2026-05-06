// scheduleWakeup + tasks API integration tests.
//
// Covers: scheduleWakeup.delay end-to-end (schedule → fire → wakeup-driven
// turn → reply), thunk form, tasks.get across steps, cancel, rejected
// thunk surfaces wakeup_rejected, parent-side mirror reflects status.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent } from "../../src/agent.ts";
import type { AgentEvent } from "../../src/types.ts";

function mockModel(scripts: string[]): { model: LanguageModelV2; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: (opts) => {
      prompts.push(JSON.stringify(opts.prompt));
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
    doStream: () => {
      throw new Error("not implemented");
    },
  };
  return { model, prompts };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "rex-wakeup-test-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

const exp = { asyncWakeups: true } as const;

Deno.test("scheduleWakeup.delay: scheduled → fires → wakeup-driven turn replies", async () => {
  await withTempRoot(async (root) => {
    // Step 1: schedule a 50ms delay, reply "kicked off".
    // Step 2 (wakeup-driven): the synthetic reflect carries the
    //   wakeup id; the agent looks it up via tasks.get and replies.
    const { model } = mockModel([
      `const h = scheduleWakeup.delay(50, { reason: "tick" });
       await reply("kicked off " + h.id);`,
      `const ids = (tasks.list() as any).map((t: any) => t.id + ":" + t.status).join(",");
       await reply("woke: " + ids);`,
    ]);
    const session = await new Agent({
      model,
      task: "schedule a delay",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    const events: AgentEvent[] = [];
    const replies: { msg: string; turn: number; cause: string }[] = [];
    try {
      for await (const ev of session.events) {
        events.push(ev);
        if (ev.kind === "reply") {
          replies.push({ msg: ev.message, turn: ev.turn, cause: ev.cause });
          if (replies.length >= 2) break;
        }
      }
    } finally {
      await session.close();
    }

    // First reply: user-driven, "kicked off".
    assertEquals(replies[0].cause, "user");
    assertStringIncludes(replies[0].msg, "kicked off");

    // Second reply: wakeup-driven, mentions the resolved task.
    assertEquals(replies[1].cause, "wakeup");
    assertStringIncludes(replies[1].msg, "resolved");

    // Lifecycle events: wakeup_scheduled then wakeup_resolved.
    const lifecycle = events.filter((e) =>
      e.kind === "wakeup_scheduled" || e.kind === "wakeup_resolved" ||
      e.kind === "wakeup_rejected" || e.kind === "wakeup_cancelled"
    );
    const sched = lifecycle.find((e) => e.kind === "wakeup_scheduled");
    const resolved = lifecycle.find((e) => e.kind === "wakeup_resolved");
    if (!sched || sched.kind !== "wakeup_scheduled") {
      throw new Error("missing wakeup_scheduled event");
    }
    if (!resolved || resolved.kind !== "wakeup_resolved") {
      throw new Error("missing wakeup_resolved event");
    }
    assertEquals(sched.wakeupKind, "delay");
    assertEquals(sched.id, resolved.id);
  });
});

Deno.test("scheduleWakeup thunk form: tasks.get across steps + await done", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      // Step 1: schedule a thunk that resolves with a value, reply
      // with the task id so the next turn can look it up.
      `const h = scheduleWakeup<number>(
         async () => {
           await new Promise((r) => setTimeout(r, 30));
           return 42;
         },
         { reason: "compute 42" },
       );
       await reply(h.id);`,
      // Step 2 (wakeup-driven): retrieve the handle via tasks.get,
      // await its done promise, and reply with the value.
      `const all = tasks.list() as any[];
       const last = all[all.length - 1];
       const v = await last.done;
       await reply("v=" + v + " status=" + last.status);`,
    ]);
    const session = await new Agent({
      model,
      task: "thunk wakeup",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    const replies: string[] = [];
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          replies.push(ev.message);
          if (replies.length >= 2) break;
        }
      }
    } finally {
      await session.close();
    }
    // Second reply must show v=42 and status=resolved.
    assertStringIncludes(replies[1], "v=42");
    assertStringIncludes(replies[1], "status=resolved");
  });
});

Deno.test("scheduleWakeup: rejected thunk fires wakeup_rejected", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `scheduleWakeup(
         async () => { throw new Error("boom"); },
         { reason: "will fail" },
       );
       await reply("scheduled");`,
      // Wakeup-driven turn after rejection. Just reply "saw it" so we
      // close out the test.
      `await reply("saw rejection");`,
    ]);
    const session = await new Agent({
      model,
      task: "rejected thunk",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    let rejected: { id: string; error: string } | null = null;
    let secondReply = false;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_rejected") {
          rejected = { id: ev.id, error: ev.error };
        }
        if (ev.kind === "reply" && ev.cause === "wakeup") {
          secondReply = true;
          break;
        }
      }
    } finally {
      await session.close();
    }
    if (!rejected) throw new Error("expected wakeup_rejected event");
    assertStringIncludes(rejected.error, "boom");
    assertEquals(secondReply, true);
  });
});

Deno.test("scheduleWakeup: cancel via tasks.cancel transitions to cancelled", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      // Schedule a long delay, cancel it, reply with status.
      `const h = scheduleWakeup.delay(60_000, { reason: "long" });
       const ok = tasks.cancel(h.id, "no longer needed");
       const after = tasks.get(h.id);
       await reply("ok=" + ok + " status=" + after?.status);`,
      // Wakeup-driven follow-up acknowledging the cancellation.
      `await reply("done");`,
    ]);
    const session = await new Agent({
      model,
      task: "cancel a wakeup",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    const seen = { firstReply: "" as string, cancelledId: "" as string };
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply" && ev.cause === "user") {
          seen.firstReply = ev.message;
        }
        if (ev.kind === "wakeup_cancelled") {
          seen.cancelledId = ev.id;
        }
        if (ev.kind === "reply" && ev.cause === "wakeup") break;
      }
    } finally {
      await session.close();
    }
    assertStringIncludes(seen.firstReply, "ok=true");
    assertStringIncludes(seen.firstReply, "status=cancelled");
    if (!seen.cancelledId) throw new Error("expected wakeup_cancelled event");
  });
});

Deno.test("user message preempts queued wakeup_fired", async () => {
  // Start a delay long enough that we can race a user message ahead
  // of the wakeup. Reply on first user step; on the second user step
  // assert the prompt's `task` line carries the new content. After
  // the user-driven turn, the wakeup turn runs and produces a third
  // reply.
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      // Step 1: schedule a near-zero wakeup, then reply.
      `scheduleWakeup.delay(10, { reason: "tick" });
       await reply("scheduled");`,
      // Step 2: user-message-driven turn (must run BEFORE wakeup).
      `await reply("user-second");`,
      // Step 3: wakeup-driven turn.
      `await reply("wakeup-third");`,
    ]);
    const session = await new Agent({
      model,
      task: "first",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    const seenReplies: { msg: string; cause: string }[] = [];
    let sentSecond = false;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          seenReplies.push({ msg: ev.message, cause: ev.cause });
          if (!sentSecond) {
            sentSecond = true;
            // Inject a user message immediately. The wakeup may
            // already be queued; this must run BEFORE it.
            session.send({ kind: "user_message", content: "second prompt" });
          }
          if (seenReplies.length >= 3) break;
        }
      }
    } finally {
      await session.close();
    }
    // Order must be: user, user (the new send), wakeup.
    assertEquals(seenReplies.map((r) => r.cause), ["user", "user", "wakeup"]);
    // The second user prompt must reflect the second send's content.
    assertStringIncludes(prompts[1], "second prompt");
  });
});

Deno.test("reserved-name collision: tool named 'tasks' is rejected", async () => {
  const { model } = mockModel([]);
  const { defineTool } = await import("../../src/tools.ts");
  const { z } = await import("zod");
  let caught: Error | null = null;
  try {
    new Agent({
      model,
      task: "x",
      tools: [
        defineTool({
          name: "tasks",
          description: "shadows tasks global",
          schema: z.object({}),
          handler: () => null,
        }),
      ],
    });
  } catch (e) {
    caught = e as Error;
  }
  assertStringIncludes(caught!.message, "reserved");
});

Deno.test("reserved-name collision: tool with '__' prefix is rejected", async () => {
  // The persistent prelude's internals (__rex, __rpcBuf, __rpcReader,
  // __pendingResolvers, etc.) live in the same module scope as
  // emitted tool stubs. A user tool named __rex would clobber the
  // task registry; one named __rpcBuf would fail to parse.
  const { model } = mockModel([]);
  const { defineTool } = await import("../../src/tools.ts");
  const { z } = await import("zod");
  let caught: Error | null = null;
  try {
    new Agent({
      model,
      task: "x",
      tools: [
        defineTool({
          name: "__rex",
          description: "would shadow task registry",
          schema: z.object({}),
          handler: () => null,
        }),
      ],
    });
  } catch (e) {
    caught = e as Error;
  }
  assertStringIncludes(caught!.message, "reserved");
  assertStringIncludes(caught!.message, "__");
});

Deno.test("reserved-name collision: tool named 'scheduleWakeup' is rejected", async () => {
  const { model } = mockModel([]);
  const { defineTool } = await import("../../src/tools.ts");
  const { z } = await import("zod");
  let caught: Error | null = null;
  try {
    new Agent({
      model,
      task: "x",
      tools: [
        defineTool({
          name: "scheduleWakeup",
          description: "shadows scheduleWakeup global",
          schema: z.object({}),
          handler: () => null,
        }),
      ],
    });
  } catch (e) {
    caught = e as Error;
  }
  assertStringIncludes(caught!.message, "reserved");
});

Deno.test("tasks API edge cases: pending(), get(missing), cancel-of-terminal", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `// One immediate, one long. Resolve the immediate, then check both.
       const a = scheduleWakeup.delay(0, { reason: "fast" });
       const b = scheduleWakeup.delay(60_000, { reason: "slow" });
       // Wait briefly so 'a' has resolved before we inspect.
       await new Promise((r) => setTimeout(r, 30));
       const pending = (tasks.pending() as any[]).map((t: any) => t.id);
       const missing = tasks.get("does-not-exist");
       // Cancel an already-resolved task — should return false.
       const reCancel = tasks.cancel(a.id, "too late");
       await reply(JSON.stringify({
         pendingCount: pending.length,
         pendingHasB: pending.includes(b.id),
         missingIsNull: missing === null,
         reCancelFalse: reCancel === false,
       }));`,
      // Wakeup-driven turn for 'a' resolution; just reply something.
      `await reply("ok");`,
    ]);
    const session = await new Agent({
      model,
      task: "edge cases",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    let firstMsg = "";
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply" && ev.cause === "user") {
          firstMsg = ev.message;
          break;
        }
      }
    } finally {
      await session.close();
    }
    const parsed = JSON.parse(firstMsg);
    assertEquals(parsed.pendingCount, 1);
    assertEquals(parsed.pendingHasB, true);
    assertEquals(parsed.missingIsNull, true);
    assertEquals(parsed.reCancelFalse, true);
  });
});

Deno.test("scheduleWakeup: synthetic reflect in next turn carries wakeup id + status", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      `scheduleWakeup.delay(20, { reason: "watch" });
       await reply("waiting");`,
      `await reply("done");`,
    ]);
    const session = await new Agent({
      model,
      task: "synthetic reflect",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    let secondReplySeen = false;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply" && ev.cause === "wakeup") {
          secondReplySeen = true;
          break;
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(secondReplySeen, true);
    // The second prompt must include the synthetic reflect's __wakeup
    // marker so the model can see what fired.
    assertStringIncludes(prompts[1], "__wakeup");
    assertStringIncludes(prompts[1], "resolved");
  });
});
