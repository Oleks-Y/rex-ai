// AgentSession integration tests — duplex event-stream surface,
// behind `experimental.asyncWakeups: true`.
//
// Step 3 covers: events emit on terminal turns, multi-turn via send(),
// step events emitted during a turn, close() ends iteration cleanly,
// openSession refuses without the flag, Agent.run wraps openSession
// when the flag is on (parity with step 2 results).

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
  const root = await Deno.makeTempDir({ prefix: "rex-agent-session-test-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

const exp = { asyncWakeups: true } as const;

Deno.test("openSession requires asyncWakeups flag", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("hi");']);
    const agent = new Agent({ model, task: "x", sessionsRoot: root });
    let caught: Error | null = null;
    try {
      await agent.openSession();
    } catch (e) {
      caught = e as Error;
    }
    assertStringIncludes(caught!.message, "experimental.asyncWakeups");
  });
});

Deno.test("openSession: first turn emits step + reply, then close", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      'await reflect({ s: 1 });',
      'await reply("done");',
    ]);
    const session = await new Agent({
      model,
      task: "two-step",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    const events: AgentEvent[] = [];
    try {
      for await (const ev of session.events) {
        events.push(ev);
        if (ev.kind === "reply") break;
      }
    } finally {
      await session.close();
    }
    // Expect: step (reflect), step (reply), reply.
    const stepEvents = events.filter((e) => e.kind === "step");
    assertEquals(stepEvents.length, 2);
    const replies = events.filter((e) => e.kind === "reply");
    assertEquals(replies.length, 1);
    if (replies[0].kind === "reply") {
      assertEquals(replies[0].message, "done");
      assertEquals(replies[0].turn, 1);
      assertEquals(replies[0].cause, "user");
    }
  });
});

Deno.test("openSession: multi-turn — send() drives a second turn after reply", async () => {
  await withTempRoot(async (root) => {
    const { model, prompts } = mockModel([
      'await reply("first");',
      'await reply("second");',
    ]);
    const session = await new Agent({
      model,
      task: "first prompt",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    const replies: { msg: string; turn: number }[] = [];
    try {
      let turnsSeen = 0;
      for await (const ev of session.events) {
        if (ev.kind === "reply") {
          replies.push({ msg: ev.message, turn: ev.turn });
          turnsSeen++;
          if (turnsSeen === 1) {
            // After the first reply, send the second user message.
            session.send({ kind: "user_message", content: "second prompt" });
          } else {
            break;
          }
        }
      }
    } finally {
      await session.close();
    }
    assertEquals(replies, [
      { msg: "first", turn: 1 },
      { msg: "second", turn: 2 },
    ]);
    // The second prompt should reflect the new user_message content.
    assertStringIncludes(prompts[1], "second prompt");
  });
});

Deno.test("openSession: close() ends iteration with session_closed", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("hi");']);
    const session = await new Agent({
      model,
      task: "hi",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    const events: AgentEvent[] = [];
    // Consume in the background while we close.
    const consumer = (async () => {
      for await (const ev of session.events) events.push(ev);
    })();
    // Wait for the first reply, then close.
    while (!events.some((e) => e.kind === "reply")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await session.close();
    await consumer;
    const last = events[events.length - 1];
    assertEquals(last.kind, "session_closed");
  });
});

Deno.test("Agent.run() with asyncWakeups uses session loop and returns RunResult", async () => {
  // Parity check: with the flag on, Agent.run still produces the
  // expected RunResult shape — same as step-2 path, but routed through
  // openSession / event stream / first-terminal extraction.
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      'await reflect({ s: 1 });',
      'await reply("ok");',
    ]);
    const r = await new Agent({
      model,
      task: "two-step",
      sessionsRoot: root,
      experimental: exp,
    }).run();
    assertEquals(r, { kind: "reply", message: "ok" });
  });
});

Deno.test("openSession: send() after close is a no-op", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("ok");']);
    const session = await new Agent({
      model,
      task: "x",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    // Drain to first reply.
    for await (const ev of session.events) {
      if (ev.kind === "reply") break;
    }
    await session.close();
    // Should not throw.
    session.send({ kind: "user_message", content: "ignored" });
  });
});

Deno.test("openSession: events are buffered for a delayed consumer", async () => {
  // Open session, let the first turn complete in the background, THEN
  // start iterating. AsyncQueue must replay buffered events before
  // emitting `done`.
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("buffered");']);
    const session = await new Agent({
      model,
      task: "x",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    // Give the worker a beat to produce step + reply before we start
    // consuming. Polling on a sentinel rather than fixed sleep keeps
    // the test fast in practice.
    await new Promise((r) => setTimeout(r, 50));
    await session.close();
    const seen: AgentEvent[] = [];
    for await (const ev of session.events) seen.push(ev);
    const kinds = seen.map((e) => e.kind);
    // Must include at least: step, reply, session_closed.
    if (!kinds.includes("step")) throw new Error("missing step event");
    if (!kinds.includes("reply")) throw new Error("missing reply event");
    assertEquals(seen[seen.length - 1].kind, "session_closed");
  });
});

Deno.test("openSession: double close is idempotent", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("ok");']);
    const session = await new Agent({
      model,
      task: "x",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    for await (const ev of session.events) {
      if (ev.kind === "reply") break;
    }
    // Two close()s back-to-back must not throw and must both resolve.
    const a = session.close();
    const b = session.close();
    await Promise.all([a, b]);
    // Drain.
    for await (const _ of session.events) { /* */ }
  });
});

Deno.test("openSession: extractor failure abort uses correct turn number", async () => {
  // Model returns no code fence on the FIRST turn → NoCodeBlockError
  // bubbles through the worker. Must surface as abort with turn: 1
  // (not turn: 2 from a stray double-increment).
  await withTempRoot(async (root) => {
    const model: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "rex-mock",
      modelId: "rex-mock-1",
      supportedUrls: {},
      doGenerate: () =>
        Promise.resolve({
          finishReason: "stop",
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          // No ts/typescript fence anywhere → extractor throws.
          content: [{ type: "text", text: "no fence here, just words" }],
          warnings: [],
        }),
      doStream: () => {
        throw new Error("not implemented");
      },
    };
    const session = await new Agent({
      model,
      task: "x",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    let abort: { turn: number; error: string } | null = null;
    try {
      for await (const ev of session.events) {
        if (ev.kind === "abort") {
          abort = { turn: ev.turn, error: ev.error };
          break;
        }
      }
    } finally {
      await session.close();
      for await (const _ of session.events) { /* */ }
    }
    assertEquals(abort?.turn, 1);
    assertStringIncludes(abort!.error, "agent loop error");
  });
});

Deno.test("openSession: malformed send payload throws synchronously", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel(['await reply("ok");']);
    const session = await new Agent({
      model,
      task: "x",
      sessionsRoot: root,
      experimental: exp,
    }).openSession();
    try {
      let caught: Error | null = null;
      try {
        // deno-lint-ignore no-explicit-any
        session.send({ kind: "wrong", content: "x" } as any);
      } catch (e) {
        caught = e as Error;
      }
      assertStringIncludes(caught!.message, "user_message");
    } finally {
      await session.close();
      // Drain so the test doesn't leak the consumer.
      for await (const _ of session.events) { /* */ }
    }
  });
});
