// Unit tests for history.ts — pure logic + on-disk write.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildHistory,
  type ConversationHistory,
  HISTORY_SCHEMA_VERSION,
  renderHistoryMarkdown,
  writeHistoryFile,
} from "../../src/history.ts";
import type { StepRecord } from "../../src/types.ts";

const FIXED_NOW = () => new Date("2026-05-12T15:30:45.123Z");

function step(over: Partial<StepRecord> = {}): StepRecord {
  return {
    index: 1,
    source: "fresh",
    code: "return reply('hi')",
    event: { kind: "reply", message: "hi", logs: [] },
    ...over,
  };
}

// ── builder ──────────────────────────────────────────────────────────────

Deno.test("buildHistory: minimal shape", () => {
  const h = buildHistory({
    sessionId: "abc",
    ephemeral: true,
    task: "say hi",
    steps: [],
    terminal: null,
    now: FIXED_NOW,
  });
  assertEquals(h.version, HISTORY_SCHEMA_VERSION);
  assertEquals(h.sessionId, "abc");
  assertEquals(h.ephemeral, true);
  assertEquals(h.task, "say hi");
  assertEquals(h.steps, []);
  assertEquals(h.terminal, null);
  assertEquals(h.exportedAt, "2026-05-12T15:30:45.123Z");
  assertEquals(h.agentPath, undefined);
});

Deno.test("buildHistory: agentPath stored when provided", () => {
  const h = buildHistory({
    sessionId: "x",
    ephemeral: false,
    task: "t",
    agentPath: "examples/email.ts",
    steps: [],
    terminal: null,
    now: FIXED_NOW,
  });
  assertEquals(h.agentPath, "examples/email.ts");
});

Deno.test("buildHistory: agentPath omitted when undefined (no explicit undefined in JSON)", () => {
  const h = buildHistory({
    sessionId: "x",
    ephemeral: false,
    task: "t",
    steps: [],
    terminal: null,
    now: FIXED_NOW,
  });
  // The property should not appear at all in the JSON form.
  const json = JSON.parse(JSON.stringify(h));
  assertEquals(Object.prototype.hasOwnProperty.call(json, "agentPath"), false);
});

Deno.test("buildHistory: preserves step ordering, sources, and logs", () => {
  const steps: StepRecord[] = [
    step({
      index: 1,
      source: "resumed",
      code: "console.log('a')",
      event: {
        kind: "reflect",
        state: { x: 1 },
        logs: [{ level: "log", args: ["a"] }],
      },
    }),
    step({
      index: 2,
      source: "fresh",
      code: "return reply('done')",
      event: { kind: "reply", message: "done", logs: [] },
    }),
  ];
  const h = buildHistory({
    sessionId: "s",
    ephemeral: false,
    task: "t",
    steps,
    terminal: { kind: "reply", message: "done" },
    now: FIXED_NOW,
  });
  assertEquals(h.steps.length, 2);
  assertEquals(h.steps[0].source, "resumed");
  assertEquals(h.steps[1].source, "fresh");
  assert(h.steps[0].event.kind === "reflect");
  assertEquals(h.steps[0].event.logs.length, 1);
});

Deno.test("buildHistory: now defaults to current time when omitted", () => {
  const before = Date.now();
  const h = buildHistory({
    sessionId: "s",
    ephemeral: true,
    task: "t",
    steps: [],
    terminal: null,
  });
  const after = Date.now();
  const exportedMs = new Date(h.exportedAt).getTime();
  assert(exportedMs >= before && exportedMs <= after);
});

// ── markdown render ──────────────────────────────────────────────────────

Deno.test("renderHistoryMarkdown: front-matter contains task / session / terminal", () => {
  const h = buildHistory({
    sessionId: "abc-123",
    ephemeral: true,
    task: "summarize 5 issues",
    agentPath: "examples/github_issues.ts",
    steps: [],
    terminal: { kind: "reply", message: "5 issues summarized." },
    now: FIXED_NOW,
  });
  const md = renderHistoryMarkdown(h);
  assertStringIncludes(md, "# rex-ai run — abc-123");
  assertStringIncludes(md, "- **Task:** summarize 5 issues");
  assertStringIncludes(md, "- **Agent:** `examples/github_issues.ts`");
  assertStringIncludes(md, "- **Exported:** 2026-05-12T15:30:45.123Z");
  assertStringIncludes(md, "- **Ephemeral:** true");
  assertStringIncludes(md, "REPLY · 5 issues summarized.");
});

Deno.test("renderHistoryMarkdown: terminal = null renders em dash", () => {
  const h = buildHistory({
    sessionId: "s",
    ephemeral: false,
    task: "t",
    steps: [],
    terminal: null,
    now: FIXED_NOW,
  });
  assertStringIncludes(renderHistoryMarkdown(h), "- **Terminal:** —");
});

Deno.test("renderHistoryMarkdown: each event kind has a per-event tail", () => {
  const steps: StepRecord[] = [
    step({
      index: 1,
      event: { kind: "reflect", state: { progress: 1 }, logs: [] },
      code: "return reflect({ progress: 1 })",
    }),
    step({
      index: 2,
      event: { kind: "abort", error: "no caps", logs: [] },
      code: "return abort('no caps')",
    }),
    step({
      index: 3,
      event: {
        kind: "permission_denied",
        permission: "net",
        target: "example.com:443",
        logs: [],
      },
      code: 'await fetch("https://example.com")',
    }),
    step({
      index: 4,
      event: { kind: "throw", error: "ReferenceError: x is not defined", logs: [] },
      code: "x",
    }),
    step({
      index: 5,
      event: { kind: "reply", message: "final", logs: [] },
      code: "return reply('final')",
    }),
  ];
  const md = renderHistoryMarkdown(buildHistory({
    sessionId: "s",
    ephemeral: true,
    task: "t",
    steps,
    terminal: { kind: "reply", message: "final" },
    now: FIXED_NOW,
  }));
  assertStringIncludes(md, "**→ reflect:**");
  assertStringIncludes(md, "**→ abort:** no caps");
  assertStringIncludes(md, "**→ permission_denied:** `net`");
  assertStringIncludes(md, "example.com:443");
  assertStringIncludes(md, "**→ threw:** ReferenceError");
  assertStringIncludes(md, "**→ reply:** final");
});

Deno.test("renderHistoryMarkdown: code rendered inside ts fence", () => {
  const h = buildHistory({
    sessionId: "s",
    ephemeral: true,
    task: "t",
    steps: [step({ code: "return reply('hi')" })],
    terminal: { kind: "reply", message: "hi" },
    now: FIXED_NOW,
  });
  const md = renderHistoryMarkdown(h);
  assertStringIncludes(md, "```ts");
  assertStringIncludes(md, "return reply('hi')");
  assertStringIncludes(md, "```");
});

Deno.test("renderHistoryMarkdown: logs section omitted when empty, present when non-empty", () => {
  const noLogs = renderHistoryMarkdown(buildHistory({
    sessionId: "s",
    ephemeral: true,
    task: "t",
    steps: [step()],
    terminal: null,
    now: FIXED_NOW,
  }));
  assertEquals(noLogs.includes("**Logs:**"), false);

  const withLogs = renderHistoryMarkdown(buildHistory({
    sessionId: "s",
    ephemeral: true,
    task: "t",
    steps: [step({
      event: {
        kind: "reflect",
        state: 1,
        logs: [
          { level: "log", args: ["hello", { x: 1 }] },
          { level: "warn", args: ["watch out"] },
        ],
      },
    })],
    terminal: null,
    now: FIXED_NOW,
  }));
  assertStringIncludes(withLogs, "**Logs:**");
  assertStringIncludes(withLogs, "`[log]` hello");
  assertStringIncludes(withLogs, '{"x":1}');
  assertStringIncludes(withLogs, "`[warn]` watch out");
});

Deno.test("renderHistoryMarkdown: inline-unsafe characters in log args are scrubbed", () => {
  const md = renderHistoryMarkdown(buildHistory({
    sessionId: "s",
    ephemeral: true,
    task: "t",
    steps: [step({
      event: {
        kind: "reflect",
        state: 1,
        logs: [{ level: "log", args: ["a|b\nc"] }],
      },
    })],
    terminal: null,
    now: FIXED_NOW,
  }));
  // Newline collapsed to space, pipe escaped — no raw newline / pipe in
  // the bullet line we emitted.
  assertStringIncludes(md, "`[log]` a\\|b c");
});

// ── file writer ──────────────────────────────────────────────────────────

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rex-history-test-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("writeHistoryFile: default format json, returns absolute path", async () => {
  await withTmpDir(async (dir) => {
    const h = buildHistory({
      sessionId: "ses-1",
      ephemeral: true,
      task: "t",
      steps: [step()],
      terminal: { kind: "reply", message: "hi" },
      now: FIXED_NOW,
    });
    const out = await writeHistoryFile(h, { dir });
    assert(out.json !== undefined);
    assertEquals(out.md, undefined);
    assert(out.json.startsWith("/") || /^[A-Z]:[\\\/]/.test(out.json), "absolute path expected");
    const written = await Deno.readTextFile(out.json);
    const parsed = JSON.parse(written);
    assertEquals(parsed.version, HISTORY_SCHEMA_VERSION);
    assertEquals(parsed.sessionId, "ses-1");
  });
});

Deno.test("writeHistoryFile: format=md produces only markdown", async () => {
  await withTmpDir(async (dir) => {
    const h = buildHistory({
      sessionId: "s",
      ephemeral: true,
      task: "t",
      steps: [],
      terminal: null,
      now: FIXED_NOW,
    });
    const out = await writeHistoryFile(h, { dir, format: "md" });
    assertEquals(out.json, undefined);
    assert(out.md !== undefined);
    const text = await Deno.readTextFile(out.md);
    assertStringIncludes(text, "# rex-ai run — s");
  });
});

Deno.test("writeHistoryFile: format=both produces json + md", async () => {
  await withTmpDir(async (dir) => {
    const h = buildHistory({
      sessionId: "s",
      ephemeral: true,
      task: "t",
      steps: [],
      terminal: null,
      now: FIXED_NOW,
    });
    const out = await writeHistoryFile(h, { dir, format: "both" });
    assert(out.json !== undefined);
    assert(out.md !== undefined);
    // Same base name, different extensions.
    assertEquals(out.json.replace(/\.json$/, ""), out.md.replace(/\.md$/, ""));
  });
});

Deno.test("writeHistoryFile: creates dir when missing", async () => {
  await withTmpDir(async (dir) => {
    const target = join(dir, "nested", "deep");
    const h = buildHistory({
      sessionId: "s",
      ephemeral: true,
      task: "t",
      steps: [],
      terminal: null,
      now: FIXED_NOW,
    });
    const out = await writeHistoryFile(h, { dir: target });
    assert(out.json !== undefined);
    // File should exist at the deep path.
    const stat = await Deno.stat(out.json);
    assert(stat.isFile);
  });
});

Deno.test("writeHistoryFile: baseName override controls file name", async () => {
  await withTmpDir(async (dir) => {
    const h = buildHistory({
      sessionId: "s",
      ephemeral: true,
      task: "t",
      steps: [],
      terminal: null,
      now: FIXED_NOW,
    });
    const out = await writeHistoryFile(h, {
      dir,
      baseName: "my-custom-name",
      format: "both",
    });
    assertStringIncludes(out.json!, "my-custom-name.json");
    assertStringIncludes(out.md!, "my-custom-name.md");
  });
});

Deno.test("writeHistoryFile: default base name has no colons / dots", async () => {
  await withTmpDir(async (dir) => {
    const h: ConversationHistory = {
      version: HISTORY_SCHEMA_VERSION,
      sessionId: "s",
      ephemeral: true,
      exportedAt: "2026-05-12T15:30:45.123Z",
      task: "t",
      steps: [],
      terminal: null,
    };
    const out = await writeHistoryFile(h, { dir });
    assert(out.json !== undefined);
    const base = out.json.split("/").pop()!;
    assertEquals(base.includes(":"), false);
    // Only the .json extension introduces a dot; the basename body
    // should have none.
    const body = base.replace(/\.json$/, "");
    assertEquals(body.includes("."), false);
  });
});
