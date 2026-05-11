// Decision 16: when the persistent subprocess exits unexpectedly mid
// step (OOM, panic, signal, or — as exercised here — an explicit
// Deno.exit from a timer callback), the parent must surface a clean
// throw terminal and the AgentSession events stream must NOT hang.
//
// We don't have an easy way to provoke a real OOM from a unit test
// that's both fast and portable, so we drive the same code path by
// having a setTimeout callback call Deno.exit(7). The pump observes
// EOF on stdout and fails the in-flight collector with
// `unexpectedExitMessage()`; subsequent runStep calls short-circuit
// because #closed is set; the agent loop exhausts cleanly.

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent } from "../../src/agent.ts";

function mockModel(scripts: string[]): { model: LanguageModelV2 } {
  let i = 0;
  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "rex-mock",
    modelId: "rex-mock-1",
    supportedUrls: {},
    doGenerate: () => {
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
  return { model };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "rex-oom-test-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* */ }
  }
}

Deno.test("subprocess unexpectedly exits mid-step: throw surfaces, session does not hang", async () => {
  await withTempRoot(async (root) => {
    const { model } = mockModel([
      // Provoke unexpected subprocess exit at ~30ms. The body deliberately
      // never returns — Deno.exit terminates the runtime, so the parent's
      // pump observes EOF on stdout while the active collector is still
      // waiting for a terminal.
      `setTimeout(() => Deno.exit(7), 30);
       await new Promise<void>(() => {});`,
    ]);
    const session = await new Agent({
      model,
      task: "die",
      sessionsRoot: root,
      experimental: { asyncWakeups: true },
      maxSteps: 2,
    }).openSession();

    let firstThrow: { error: string } | null = null;
    let terminalKind: string | null = null;
    const start = Date.now();
    const HARD_BUDGET_MS = 8_000;

    try {
      for await (const ev of session.events) {
        if (ev.kind === "step" && ev.event.kind === "throw") {
          firstThrow ??= { error: ev.event.error };
        }
        if (ev.kind === "abort" || ev.kind === "exhausted" || ev.kind === "reply") {
          terminalKind = ev.kind;
          break;
        }
        if (Date.now() - start > HARD_BUDGET_MS) {
          throw new Error(
            `session did not produce a terminal ${HARD_BUDGET_MS}ms after subprocess exit (hang)`,
          );
        }
      }
    } finally {
      await session.close();
    }

    if (!firstThrow) {
      throw new Error("expected a 'step' event with event.kind:'throw' from the dead subprocess");
    }
    // The unexpected-exit message includes "exit" and the captured
    // exit code / stderr; we only assert the substring 'exit' so the
    // test isn't tied to the exact reason format.
    assertStringIncludes(firstThrow.error.toLowerCase(), "exit");
    // Loop should exhaust (or abort) — never silently complete with a
    // reply when the sandbox died.
    if (terminalKind !== "exhausted" && terminalKind !== "abort") {
      throw new Error(
        `expected terminal exhausted/abort after subprocess exit, got: ${terminalKind}`,
      );
    }
    // Honor the Decision 16 promise: clean exit within budget.
    assertEquals(Date.now() - start < HARD_BUDGET_MS, true);
  });
});
