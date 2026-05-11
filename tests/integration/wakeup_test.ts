// Timer-based wakeup + reflect(promise) integration tests.
//
// Covers the surface that replaced scheduleWakeup:
//   - setTimeout fire → wakeup-driven turn (with timer-state synthetic prior)
//   - setInterval N-tick path
//   - clearTimeout / clearInterval cancellations
//   - reflect(promise) resolve / reject
//   - translated reply / abort intent from inside a callback
//   - silent ticks (callback called no control fn) do NOT wake
//   - reserved-name collisions for tasks / setTimeout / etc.
//
// Tests that need parametric autoWakeOnTimer or interval concurrency
// live in tests/integration/timer_concurrency_test.ts.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent } from "../../src/agent.ts";
import type { AgentEvent } from "../../src/types.ts";

function mockModel(scripts: string[]): { model: LanguageModelV2; prompts: string[] } {
  // Capture the rendered prompt text directly (concatenated user-message
  // text contents) — assertion sites then look for raw substrings without
  // worrying about JSON escaping.
  const prompts: string[] = [];
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: (opts) => {
      prompts.push(extractPromptText(opts.prompt));
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

// deno-lint-ignore no-explicit-any
function extractPromptText(prompt: any): string {
  if (typeof prompt === "string") return prompt;
  const parts: string[] = [];
  for (const msg of prompt ?? []) {
    const c = msg?.content;
    if (typeof c === "string") parts.push(c);
    else if (Array.isArray(c)) {
      for (const seg of c) if (typeof seg?.text === "string") parts.push(seg.text);
    }
  }
  return parts.join("\n");
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

Deno.test("setTimeout: callback that reflects fires a wakeup-driven turn", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      // Step 1: schedule a 50ms timeout that reflects a value.
      `setTimeout(() => reflect({ kicked: true }), 50);
       await reply("scheduled");`,
      // Step 2: wakeup-driven turn — confirm the synthetic state was rendered.
      `await reply("woke");`,
    ]);
    const session = await new Agent({
      model,
      task: "schedule a timeout",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    const events: AgentEvent[] = [];
    const replies: { msg: string; cause: string }[] = [];
    try {
      for await (const ev of session.events) {
        events.push(ev);
        if (ev.kind === "reply") {
          replies.push({ msg: ev.message, cause: ev.cause });
          if (replies.length >= 2) break;
        }
      }
    } finally {
      await session.close();
    }

    assertEquals(replies[0].cause, "user");
    assertEquals(replies[1].cause, "wakeup");

    const sched = events.find((e) => e.kind === "wakeup_scheduled");
    const resolved = events.find((e) => e.kind === "wakeup_resolved");
    if (!sched || sched.kind !== "wakeup_scheduled") throw new Error("missing wakeup_scheduled");
    if (!resolved || resolved.kind !== "wakeup_resolved") throw new Error("missing wakeup_resolved");
    assertEquals(sched.wakeupKind, "timeout");
    assertEquals(sched.id, resolved.id);

    // The wakeup-driven turn's prompt must include the timer's synthetic
    // prior step (state.__from_timer + state.callback_state).
    assertStringIncludes(prompts[1], "__from_timer");
    assertStringIncludes(prompts[1], "callback_state");
    assertStringIncludes(prompts[1], "kicked");
    // Issue 4: the rendered __from_timer.delayMs must match the
    // configured ms argument (50), not elapsed wall-time.
    assertStringIncludes(prompts[1], `"delayMs":50`);
  });
});

Deno.test("setTimeout: silent callback does NOT wake the agent", async () => {
  await withTempRoot(async (root) => {
    // The timeout callback runs (it just resolves a Promise), but
    // because it never calls reflect/reply/abort, no wakeup turn is
    // enqueued. The session sits idle after the user reply until close.
    const { model } = mockModel([
      `await new Promise<void>((resolve) => setTimeout(resolve, 30));
       await reply("done");`,
    ]);
    const session = await new Agent({
      model,
      task: "silent timer",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    let userReply: string | null = null;
    let extraReplyCount = 0;
    let resolvedEvents = 0;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          if (userReply === null) {
            userReply = ev.message;
            // Wait briefly to catch any spurious wakeup turn.
            await new Promise<void>((r) => setTimeout(r, 80));
            break;
          } else {
            extraReplyCount++;
          }
        }
        if (ev.kind === "wakeup_resolved" && ev.payload) resolvedEvents++;
      }
    } finally {
      await session.close();
    }
    assertEquals(userReply, "done");
    assertEquals(extraReplyCount, 0);
    assertEquals(resolvedEvents, 0);
  });
});

Deno.test("setInterval: payload-bearing ticks each fire a wakeup turn", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      // First step: kick off interval that reflects on every tick.
      // 30ms × 3 ticks = ~90ms.
      `let n = 0;
       const id = setInterval(() => {
         n++;
         if (n <= 3) reflect({ tick: n });
         else clearInterval(id);
       }, 30);
       await reply("started");`,
      // The wakeup-driven turns just reply with their tick count.
      `await reply("tick");`,
    ]);
    const session = await new Agent({
      model,
      task: "interval ticks",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    const replies: { cause: string; msg: string }[] = [];
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          replies.push({ cause: ev.cause, msg: ev.message });
          // First user reply + 3 wakeup-driven replies.
          if (replies.length >= 4) break;
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(replies[0].cause, "user");
    assertEquals(replies.slice(1).map((r) => r.cause), ["wakeup", "wakeup", "wakeup"]);
  });
});

Deno.test("clearTimeout: cancellation prevents wakeup turn", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `const id = setTimeout(() => reflect({ should: "not fire" }), 60);
       clearTimeout(id);
       await reply("cancelled");`,
    ]);
    const session = await new Agent({
      model,
      task: "cancel a timeout",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    let userReply: string | null = null;
    let cancelledId: string | null = null;
    let extraReply = 0;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_cancelled") cancelledId = ev.id;
        if (ev.kind === "reply") {
          if (userReply === null) {
            userReply = ev.message;
            // Wait past the would-have-fired moment.
            await new Promise<void>((r) => setTimeout(r, 120));
            break;
          } else {
            extraReply++;
          }
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(userReply, "cancelled");
    if (!cancelledId) throw new Error("expected wakeup_cancelled event");
    assertEquals(extraReply, 0);
  });
});

Deno.test("translated reply: callback reply() is captured as intent, not surfaced to user", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      // Step 1: callback calls reply() — that's translated to reflect.
      `setTimeout(() => reply("from inside callback"), 30);
       await reply("watching");`,
      // Step 2: wakeup-driven turn — the agent decides whether to surface.
      `await reply("seen");`,
    ]);
    const session = await new Agent({
      model,
      task: "translated reply",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    const replies: { cause: string; msg: string }[] = [];
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          replies.push({ cause: ev.cause, msg: ev.message });
          if (replies.length >= 2) break;
        }
      }
    } finally {
      await session.close();
    }
    // The callback's "from inside callback" string must NOT have been
    // sent to the user as a reply — only step-body replies are surfaced.
    assertEquals(replies[0].msg, "watching");
    assertEquals(replies[1].msg, "seen");

    // The wakeup-driven turn's prompt must show the translated intent.
    assertStringIncludes(prompts[1], "translated_intent");
    assertStringIncludes(prompts[1], "from inside callback");
  });
});

Deno.test("translated abort: callback abort() is captured as intent", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      `setTimeout(() => abort("nope"), 30);
       await reply("scheduled abort");`,
      `await reply("seen");`,
    ]);
    const session = await new Agent({
      model,
      task: "translated abort",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    const replies: { cause: string; msg: string }[] = [];
    try {
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          replies.push({ cause: ev.cause, msg: ev.message });
          if (replies.length >= 2) break;
        }
      }
    } finally {
      await session.close();
    }
    // No abort surfaced — the callback's abort() was translated to a
    // reflect with intent { kind: 'abort' }.
    assertEquals(replies.map((r) => r.cause), ["user", "wakeup"]);
    assertStringIncludes(prompts[1], "translated_intent");
    assertStringIncludes(prompts[1], "nope");
    assertStringIncludes(prompts[1], "abort");
  });
});

Deno.test("reflect(promise): runtime awaits before settling; next step sees resolved value", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      // Step 1: return reflect(promise) — runtime awaits, then dispatches reflect.
      `return reflect((async () => { await new Promise(r => setTimeout(r, 30)); return { v: 42 }; })());`,
      // Step 2: prior reflect.state IS the resolved value (no __wakeup wrapper).
      `await reply("got42");`,
    ]);
    const session = await new Agent({
      model,
      task: "reflect promise",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    let secondReply = false;
    let promiseScheduled = false;
    let promiseResolved = false;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_scheduled" && ev.wakeupKind === "promise") promiseScheduled = true;
        if (ev.kind === "wakeup_resolved" && promiseScheduled) promiseResolved = true;
        if (ev.kind === "reply" && ev.message === "got42") {
          secondReply = true;
          break;
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(secondReply, true);
    assertEquals(promiseScheduled, true);
    assertEquals(promiseResolved, true);
    // The second prompt's reflect state must contain the resolved value
    // directly — NOT wrapped in __wakeup.
    assertStringIncludes(prompts[1], "\"v\":42");
  });
});

Deno.test("reflect(promise): rejection surfaces as throw terminal", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      `return reflect((async () => { throw new Error("boom"); })());`,
      // Step 2 sees the throw in priorSteps and replies acknowledging it.
      `await reply("saw throw");`,
    ]);
    const session = await new Agent({
      model,
      task: "reflect promise reject",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    let rejectedSeen = false;
    let secondReply = false;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_rejected") rejectedSeen = true;
        if (ev.kind === "reply" && ev.message === "saw throw") {
          secondReply = true;
          break;
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(rejectedSeen, true);
    assertEquals(secondReply, true);
    // The second prompt should reflect that the prior step threw "boom".
    assertStringIncludes(prompts[1], "boom");
  });
});

Deno.test("reflect(promise): user_message during wait interrupts via cancel_step", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      // Step 1: long reflect(promise) wait. The user message will
      // arrive ~50ms in and cancel via cancel_step. The interrupt
      // exits the inner-step loop (no second model call for this turn).
      `return reflect((async () => { await new Promise(r => setTimeout(r, 5_000)); return "never"; })());`,
      // Step 2 (user_message turn): what the agent says back.
      `await reply("got user msg");`,
    ]);
    const session = await new Agent({
      model,
      task: "first task",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    let kickedOff = false;
    let interruptedSeen = false;
    const replies: string[] = [];
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_scheduled" && ev.wakeupKind === "promise" && !kickedOff) {
          kickedOff = true;
          // Schedule a user message after a short delay.
          setTimeout(() => session.send({ kind: "user_message", content: "stop and tell me" }), 50);
        }
        if (ev.kind === "wakeup_cancelled") interruptedSeen = true;
        if (ev.kind === "reply") {
          replies.push(ev.message);
          if (replies.length >= 1) break;
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(interruptedSeen, true);
    assertEquals(replies[0], "got user msg");
    // The user_message turn's prompt must include the prior interrupt
    // marker so the agent knows what happened.
    const lastPrompt = prompts[prompts.length - 1];
    assertStringIncludes(lastPrompt, "__interrupted_by");
    assertStringIncludes(lastPrompt, "stop and tell me");
  });
});

Deno.test("tasks.list / tasks.cancel reflect live timers", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `const a = setTimeout(() => reflect({ a: true }), 60_000);
       const b = setInterval(() => {}, 60_000);
       const before = JSON.stringify(tasks.list().map((t) => ({ id: t.id, kind: t.kind, status: t.status })));
       const okA = tasks.cancel(a);
       const okBad = tasks.cancel(99999);
       const after = JSON.stringify(tasks.list().map((t) => ({ id: t.id, kind: t.kind, status: t.status })));
       clearInterval(b);
       await reply(JSON.stringify({ before, after, okA, okBad }));`,
    ]);
    const r = await new Agent({
      model,
      task: "tasks api",
      sessionsRoot: root,
      experimental: exp,
    }).run();
    if (r.kind !== "reply") throw new Error("expected reply, got " + JSON.stringify(r));
    const parsed = JSON.parse(r.message);
    assertEquals(parsed.okA, true);
    assertEquals(parsed.okBad, false);
    // Before: two pending entries (timeout + interval). After: only the interval.
    const before = JSON.parse(parsed.before);
    const after = JSON.parse(parsed.after);
    assertEquals(before.length, 2);
    assertEquals(after.length, 1);
    assertEquals(after[0].kind, "interval");
  });
});

Deno.test("user message preempts queued wakeup turns", async () => {
  // Schedule a near-zero wakeup with a payload, then race a user
  // message ahead of it. The new send() must run before the wakeup
  // turn (user preempts wakeup); after the user-driven turn the
  // wakeup turn fires.
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      // Step 1: schedule a near-zero wakeup that reflects (so it's
      // payload-bearing and would enqueue a turn).
      `setTimeout(() => reflect({ tick: true }), 10);
       await reply("scheduled");`,
      // Step 2: user-message-driven turn — must run BEFORE the wakeup.
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
            session.send({ kind: "user_message", content: "second prompt" });
          }
          if (seenReplies.length >= 3) break;
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(seenReplies.map((r) => r.cause), ["user", "user", "wakeup"]);
    assertStringIncludes(prompts[1], "second prompt");
  });
});

Deno.test("overlapping async timer callbacks: each intent attaches to its own wakeup", async () => {
  // Issue 2 regression: two interleaved timer cbs where B (sync, fires
  // at 50ms) lands while A (async, awaits 100ms then replies) is still
  // mid-await. Pre-fix, the per-callback frame was a shared LIFO
  // stack: B's push/pop sandwiched A's pop, so on settle the popped
  // frame did not match the cb that just settled — intents got
  // attached to the wrong wakeup id. With AsyncLocalStorage the frame
  // is bound to each cb's own async scope and the test passes
  // deterministically.
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `setTimeout(async () => {
         await new Promise<void>((r) => setTimeout(r, 100));
         reply("A");
       }, 10);
       setTimeout(() => reply("B"), 50);
       await reply("scheduled");`,
      `await reply("ack");`,
    ]);
    const session = await new Agent({
      model,
      task: "overlapping",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();

    // The first two timeout-kind wakeup_scheduled events come from the
    // outer setTimeouts (in scheduling order: A then B). A third one
    // arrives later from A's nested `setTimeout(r, 100)` — irrelevant.
    const scheduledTimeoutIds: string[] = [];
    const intentTextById = new Map<string, string>();
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_scheduled" && ev.wakeupKind === "timeout") {
          scheduledTimeoutIds.push(ev.id);
        }
        if (ev.kind === "wakeup_resolved" && ev.payload?.intent?.text) {
          intentTextById.set(ev.id, ev.payload.intent.text);
        }
        if (intentTextById.size >= 2) break;
      }
    } finally {
      await session.close();
    }
    if (scheduledTimeoutIds.length < 2) {
      throw new Error(
        "expected at least two timeout schedules, got " + scheduledTimeoutIds.length,
      );
    }
    const aId = scheduledTimeoutIds[0];
    const bId = scheduledTimeoutIds[1];
    assertEquals(intentTextById.get(aId), "A");
    assertEquals(intentTextById.get(bId), "B");
  });
});

Deno.test("reflect(promise): wait can exceed stepTimeoutMs (Issue 1: reflect-aware deadline)", async () => {
  // Pre-fix the parent armed a one-shot stepTimeoutMs deadline that
  // SIGKILLed the sandbox before reflectPromiseTimeoutMs could ever
  // fire. With the deadline re-armed on wakeup_scheduled(promise) to
  // max(stepDeadline, scheduledAt + reflectPromiseTimeoutMs), the
  // promise can outlive the step timeout. Resolves at ~3.5s with
  // stepTimeoutMs=2s, reflectPromiseTimeoutMs=8s.
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      `return reflect((async () => {
         await new Promise<void>((r) => setTimeout(r, 3500));
         return "late but ok";
       })());`,
      `await reply("done");`,
    ]);
    const r = await new Agent({
      model,
      task: "long reflect",
      sessionsRoot: root,
      experimental: exp,
      sizeCaps: { stepTimeoutMs: 2_000, reflectPromiseTimeoutMs: 8_000 },
      maxSteps: 2,
    }).run();
    if (r.kind !== "reply") {
      throw new Error("expected reply, got " + JSON.stringify(r));
    }
    assertEquals(r.message, "done");
    // The second prompt sees the resolved value as the prior step's
    // reflect state.
    assertStringIncludes(prompts[1], "late but ok");
  });
});

Deno.test("reflect(Promise.reject) inside a timer callback surfaces as wakeup_rejected", async () => {
  // Issue 3: rejected thenable in a callback intent. Pre-fix, the
  // callback's reflect() stored the unsettled Promise as state and
  // JSON-serialized it as `{}`, plus Deno's unhandled-rejection killer
  // could fire. With __unwrapCallbackReflect the same race-with-cap
  // helper used at top level handles the rejection: emits
  // `wakeup_rejected` for the inner promise and surfaces the timer's
  // own wakeup_rejected with the error message.
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      `setTimeout(() => reflect(Promise.reject(new Error("cb-boom"))), 30);
       await reply("scheduled");`,
      `await reply("after");`,
    ]);
    const session = await new Agent({
      model,
      task: "reject in cb",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    const rejected: { id: string; error: string }[] = [];
    let secondReply = false;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_rejected") {
          rejected.push({ id: ev.id, error: ev.error });
        }
        if (ev.kind === "reply" && ev.message === "after") {
          secondReply = true;
          break;
        }
      }
    } finally {
      await session.close();
    }
    // Both the inner promise (p_*) and the outer timer (t_*) reject
    // with the same message.
    if (rejected.length < 2) {
      throw new Error(
        "expected two wakeup_rejected (inner promise + outer timer), got " +
          JSON.stringify(rejected),
      );
    }
    for (const r of rejected) assertStringIncludes(r.error, "cb-boom");
    assertEquals(secondReply, true);
    // The wakeup-driven prompt must surface the rejection error.
    assertStringIncludes(prompts[prompts.length - 1], "cb-boom");
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

Deno.test("reserved-name collision: tool named 'setTimeout' is rejected", async () => {
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
          name: "setTimeout",
          description: "would shadow timer wrapper",
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
  // The persistent prelude's internals (__rex, __rpcBuf, __timers,
  // __pendingResolvers, etc.) live in the same module scope as
  // emitted tool stubs. A user tool named __rex would clobber the
  // state hub; one named __rpcBuf would fail to parse.
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
          description: "would shadow state hub",
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
