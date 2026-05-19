// Timer concurrency + ordering + autoWakeOnTimer parametric tests.
//
// These cover Plan Issues 9, 12, 13:
//   - 9: setInterval ticks during a long-running step are buffered
//        and processed in FIFO order after the step settles.
//   - 12: autoWakeOnTimer ON vs OFF produces diverging behavior with
//        the same script.
//   - 13: per-tick RPC overhead stays within a budget at a 50ms
//        cadence over a few seconds.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent } from "../../src/agent.ts";

function mockModel(scripts: string[]): { model: LanguageModelV2; prompts: string[]; calls: number[] } {
  const prompts: string[] = [];
  const calls: number[] = [];
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: (opts) => {
      prompts.push(extractPromptText(opts.prompt));
      calls.push(Date.now());
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
  return { model, prompts, calls };
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
  const root = await Deno.makeTempDir({ prefix: "rex-timer-conc-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

Deno.test("autoWakeOnTimer OFF (default): silent callbacks do not wake", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      // Cb returns a value but doesn't reflect — silent under OFF.
      `setTimeout(() => 99, 30);
       await reply("scheduled");`,
    ]);
    const session = await new Agent({
      model,
      task: "off",
      sessionsRoot: root,
      experimental: { asyncWakeups: true },
    }).openSession();

    let firstReply: string | null = null;
    let extra = 0;
    let payloadFires = 0;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_resolved" && ev.payload) payloadFires++;
        if (ev.kind === "reply") {
          if (firstReply === null) {
            firstReply = ev.message;
            await new Promise<void>((r) => setTimeout(r, 80));
            break;
          } else {
            extra++;
          }
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(firstReply, "scheduled");
    assertEquals(extra, 0);
    assertEquals(payloadFires, 0);
  });
});

Deno.test("autoWakeOnTimer ON: silent callbacks DO wake (return value as state)", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      `setTimeout(() => "tick value", 30);
       await reply("scheduled");`,
      // Wakeup-driven turn — assert the synthetic state shows callback_state.
      `await reply("woke");`,
    ]);
    const session = await new Agent({
      model,
      task: "on",
      sessionsRoot: root,
      experimental: { asyncWakeups: true, autoWakeOnTimer: true },
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
    assertEquals(replies[0].cause, "user");
    assertEquals(replies[1].cause, "wakeup");
    // The wakeup turn's prompt must include callback_state with the
    // returned value.
    assertStringIncludes(prompts[1], "callback_state");
    assertStringIncludes(prompts[1], "tick value");
  });
});

Deno.test("setInterval ticks during a long step are buffered and processed FIFO", async () => {
  await withTempRoot(async (root) => {
    // Step 1: kick off a 30ms-cadence interval that tags each tick with
    // its sequence number, then deliberately busy-await ~140ms before
    // settling — that lets ~3-4 ticks queue up parent-side. The ticks
    // each call reflect with the seq number; the inner-step loop turns
    // them into wakeup_fired events that should arrive in order.
    const { model } = mockModel([
      `let n = 0;
       const id = setInterval(() => {
         n++;
         if (n <= 4) reflect({ seq: n });
         else clearInterval(id);
       }, 30);
       await new Promise<void>((r) => setTimeout(r, 160));
       await reply("started");`,
      `await reply("tick");`,
    ]);
    const session = await new Agent({
      model,
      task: "interval ordering",
      sessionsRoot: root,
      experimental: { asyncWakeups: true },
    }).openSession();

    const seqsSeen: number[] = [];
    const replies: { cause: string }[] = [];
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_resolved" && ev.payload?.state) {
          // deno-lint-ignore no-explicit-any
          const seq = (ev.payload.state as any).seq;
          if (typeof seq === "number") seqsSeen.push(seq);
        }
        if (ev.kind === "reply") {
          replies.push({ cause: ev.cause });
          // user reply + 4 wakeup-driven replies
          if (replies.length >= 5) break;
        }
      }
    } finally {
      await session.close();
    }
    // Ticks must arrive in 1, 2, 3, 4 order.
    assertEquals(seqsSeen.slice(0, 4), [1, 2, 3, 4]);
    assertEquals(replies[0].cause, "user");
    assertEquals(replies.slice(1).map((r) => r.cause), ["wakeup", "wakeup", "wakeup", "wakeup"]);
  });
});

Deno.test("perf budget: 50ms-cadence loaded interval over ~5s stays within budget (Decision 13)", async () => {
  // Plan Decision 13 — loaded shape (not silent): every tick reflects
  // a payload so the parent-side wakeup mirror, the inbox queue, and
  // the host event channel all do real work per tick. We let it run
  // ~5s (~100 ticks at 50ms cadence), then assert:
  //   - the run completes well under a generous wall-clock cap (no
  //     hang from a drain-loop, GC, or back-pressure deadlock);
  //   - the parent observed roughly the expected tick count, with
  //     enough slack for CI variance;
  //   - the host's wakeup_resolved stream stays in tick order.
  //
  // Catches regressions like the snapshot-once drain-loop fix (without
  // it, a fast interval starves __drainAllPending on shutdown).
  const ITERS = 100;
  const CADENCE_MS = 50;
  const RUN_WALL_MS = ITERS * CADENCE_MS; // ~5s of useful work
  const WALL_BUDGET_MS = 12_000; // ~2.4× the planned run; trips on real regressions
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      `let n = 0;
       const id = setInterval(() => {
         n++;
         if (n >= ${ITERS}) clearInterval(id);
         else reflect({ tick: n });
       }, ${CADENCE_MS});
       await new Promise<void>((r) => setTimeout(r, ${RUN_WALL_MS + 500}));
       await reply("done n=" + n);`,
    ]);
    const start = Date.now();
    const session = await new Agent({
      model,
      task: "perf budget loaded",
      sessionsRoot: root,
      experimental: { asyncWakeups: true },
    }).openSession();

    let lastSeenTick = 0;
    let outOfOrder = 0;
    let payloadFires = 0;
    let userReply: string | null = null;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "wakeup_resolved" && ev.payload?.state) {
          payloadFires++;
          // deno-lint-ignore no-explicit-any
          const t = (ev.payload.state as any).tick;
          if (typeof t === "number") {
            if (t < lastSeenTick) outOfOrder++;
            lastSeenTick = t;
          }
        }
        if (ev.kind === "reply") {
          userReply = ev.message;
          break;
        }
        if (Date.now() - start > WALL_BUDGET_MS) {
          throw new Error(
            `loaded perf test exceeded ${WALL_BUDGET_MS}ms wall-clock budget; perf regression`,
          );
        }
      }
    } finally {
      await session.close();
    }
    const dur = Date.now() - start;
    if (userReply === null) throw new Error("expected a user reply at end of step");
    assertStringIncludes(userReply, "done n=");
    // Payload-bearing ticks: ITERS - 1 (last tick clears, doesn't reflect).
    // Allow 15% under-count to absorb scheduler jitter on a loaded box.
    const expected = ITERS - 1;
    const min = Math.floor(expected * 0.85);
    if (payloadFires < min) {
      throw new Error(`saw ${payloadFires} payload fires, expected at least ${min}`);
    }
    assertEquals(outOfOrder, 0);
    if (dur > WALL_BUDGET_MS) throw new Error(`run took ${dur}ms, over budget`);
  });
});
