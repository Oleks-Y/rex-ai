import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { SessionStore } from "../../src/session.ts";
import { DEFAULT_SIZE_CAPS, SessionLockedError, WriteLibError } from "../../src/types.ts";

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "rex-session-test-" });
  try {
    return await fn(root);
  } finally {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* best-effort */ }
  }
}

Deno.test("bootstrap creates lib.ts / storage.json / transcript.jsonl", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "boot",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      const dir = join(root, "sessions", "boot");
      assertEquals(await Deno.readTextFile(join(dir, "lib.ts")), "export {};\n");
      assertEquals(await Deno.readTextFile(join(dir, "storage.json")), "{}\n");
      assertEquals(await Deno.readTextFile(join(dir, "transcript.jsonl")), "");
    } finally {
      await s.close();
    }
  });
});

Deno.test("ephemeral session is deleted on close", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({ rootDir: root, sizeCaps: DEFAULT_SIZE_CAPS });
    const dir = s.dir;
    await Deno.stat(dir); // exists
    await s.close();
    await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound);
  });
});

Deno.test("writeLib writes a real .ts file and libExports lists named exports", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "lib1",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await s.writeLib(
        [
          "export const PI = 3.14;",
          "export function add(a: number, b: number) { return a + b; }",
          "export class Point { constructor(public x: number, public y: number) {} }",
          "const hidden = 1;",
          "export type Pair = [number, number];",
        ].join("\n"),
        [],
      );
      const src = await s.readLib();
      assertStringIncludes(src, "export const PI");
      const exports = await s.libExports();
      assertEquals(exports, ["PI", "add", "Point", "Pair"]);
    } finally {
      await s.close();
    }
  });
});

Deno.test("writeLib rejects source whose imports aren't in allowlist; file unchanged", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "lib2",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await s.writeLib('export const x = 1;', []);
      const before = await s.readLib();
      await assertRejects(
        () => s.writeLib('import { spawn } from "node:child_process"; export const y = 2;', []),
        WriteLibError,
        "node:child_process",
      );
      const after = await s.readLib();
      assertEquals(before, after);
    } finally {
      await s.close();
    }
  });
});

Deno.test("writeLib rejects source over the size cap", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "lib3",
      rootDir: root,
      sizeCaps: { ...DEFAULT_SIZE_CAPS, libBytes: 64 },
    });
    try {
      await assertRejects(
        () => s.writeLib(`export const blob = "${"x".repeat(200)}";`, []),
        WriteLibError,
        "too large",
      );
    } finally {
      await s.close();
    }
  });
});

Deno.test("writeLib full-replace: prior content not preserved", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "lib4",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await s.writeLib("export const a = 1;", []);
      await s.writeLib("export const b = 2;", []);
      const exports = await s.libExports();
      assertEquals(exports, ["b"]);
    } finally {
      await s.close();
    }
  });
});

Deno.test("storage round-trips and persists across reopen", async () => {
  await withTempRoot(async (root) => {
    const s1 = await SessionStore.open({
      sessionId: "store1",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    await s1.storageSet("count", 42);
    await s1.storageSet("nested", { a: [1, 2, 3] });
    assertEquals(s1.storageGet("count"), 42);
    assertEquals(s1.storageKeys().sort(), ["count", "nested"]);
    await s1.close();

    // Reopen and verify the values are still there.
    const s2 = await SessionStore.open({
      sessionId: "store1",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      assertEquals(s2.storageGet("count"), 42);
      assertEquals(s2.storageGet("nested"), { a: [1, 2, 3] });
    } finally {
      await s2.close();
    }
  });
});

Deno.test("storageSet enforces total quota", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "quota",
      rootDir: root,
      sizeCaps: { ...DEFAULT_SIZE_CAPS, storageBytes: 64 },
    });
    try {
      await assertRejects(
        () => s.storageSet("big", "x".repeat(1000)),
        Error,
        "quota exceeded",
      );
    } finally {
      await s.close();
    }
  });
});

Deno.test("storageSet rejects non-serializable values", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "ser",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await assertRejects(
        () => s.storageSet("x", 1n as unknown as number),
        Error,
        "not JSON-serializable",
      );
    } finally {
      await s.close();
    }
  });
});

Deno.test("storageDel removes a key, preserves others", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "del",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await s.storageSet("a", 1);
      await s.storageSet("b", 2);
      await s.storageDel("a");
      assertEquals(s.storageKeys().sort(), ["b"]);
      assertEquals(s.storageGet("a"), undefined);
    } finally {
      await s.close();
    }
  });
});

Deno.test("appendTranscript appends one JSONL line per call", async () => {
  await withTempRoot(async (root) => {
    const s = await SessionStore.open({
      sessionId: "tx",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await s.appendTranscript({ step: 1, kind: "reply", message: "hi" });
      await s.appendTranscript({ step: 2, kind: "reflect", state: { n: 1 } });
      const text = await Deno.readTextFile(s.transcriptPath);
      const lines = text.trim().split("\n");
      assertEquals(lines.length, 2);
      assertEquals(JSON.parse(lines[0]), { step: 1, kind: "reply", message: "hi" });
      assertEquals(JSON.parse(lines[1]), { step: 2, kind: "reflect", state: { n: 1 } });
    } finally {
      await s.close();
    }
  });
});

Deno.test("session resume: sessionId inherits state, history starts fresh", async () => {
  await withTempRoot(async (root) => {
    const s1 = await SessionStore.open({
      sessionId: "resume",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    await s1.writeLib("export const greet = () => 'hi';", []);
    await s1.storageSet("k", "v");
    await s1.close();

    const s2 = await SessionStore.open({
      sessionId: "resume",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      assertEquals(await s2.libExports(), ["greet"]);
      assertEquals(s2.storageGet("k"), "v");
    } finally {
      await s2.close();
    }
  });
});

Deno.test(".lock blocks a second concurrent open", async () => {
  await withTempRoot(async (root) => {
    const s1 = await SessionStore.open({
      sessionId: "lock",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await assertRejects(
        () =>
          SessionStore.open({
            sessionId: "lock",
            rootDir: root,
            sizeCaps: DEFAULT_SIZE_CAPS,
          }),
        SessionLockedError,
      );
    } finally {
      await s1.close();
    }
  });
});

Deno.test("stale .lock (dead PID) is cleared", async () => {
  await withTempRoot(async (root) => {
    const dir = join(root, "sessions", "stale");
    await Deno.mkdir(dir, { recursive: true });
    // Plant a lock from PID 1 with an obviously bogus timestamp. PID 1 is
    // alive (init), so this would NOT be stale — we need a PID that
    // definitely doesn't exist. Use a giant unlikely PID.
    const fakePid = 0x7fffffff;
    await Deno.writeTextFile(
      join(dir, ".lock"),
      JSON.stringify({ pid: fakePid, ts: 0 }),
    );
    const s = await SessionStore.open({
      sessionId: "stale",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    await s.close();
  });
});

Deno.test("cross-session isolation: two sessions don't share lib/storage", async () => {
  await withTempRoot(async (root) => {
    const a = await SessionStore.open({
      sessionId: "A",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    const b = await SessionStore.open({
      sessionId: "B",
      rootDir: root,
      sizeCaps: DEFAULT_SIZE_CAPS,
    });
    try {
      await a.writeLib("export const x = 'A';", []);
      await b.writeLib("export const x = 'B';", []);
      await a.storageSet("k", 1);
      await b.storageSet("k", 2);
      assertEquals(await a.libExports(), ["x"]);
      assertEquals(await b.libExports(), ["x"]);
      assertStringIncludes(await a.readLib(), "'A'");
      assertStringIncludes(await b.readLib(), "'B'");
      assertEquals(a.storageGet("k"), 1);
      assertEquals(b.storageGet("k"), 2);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
