// Unit tests for IORecorder — the storage layer for the extended
// transcript (docs/plans/extended-transcript.md). Focus areas:
//   - blobs are content-addressed + sharded + deduped
//   - per-body truncation marks BlobRef.truncated
//   - per-step body budget caps bodyRef on excess events (metadata-only)
//   - header redaction is case-insensitive and bounded to the listed names
//   - io.jsonl is append-only with stable {ts, stepIndex, seq, ...event} shape
//   - flushStep returns the in-memory event array for StepRecord.io
//   - empty-step / second flush are no-ops

import { assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { IORecorder, blobRelPath } from "../../src/io_record.ts";
import { DEFAULT_SIZE_CAPS, IO_REDACTED_VALUE, type SizeCaps } from "../../src/types.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rex-iorec-" });
  try { return await fn(dir); } finally {
    try { await Deno.remove(dir, { recursive: true }); } catch { /* */ }
  }
}

function caps(over: Partial<SizeCaps> = {}): SizeCaps {
  return { ...DEFAULT_SIZE_CAPS, ...over };
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await Deno.readTextFile(path);
    return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}

Deno.test("recordToolCall: writes blobs + io.jsonl line with sha-addressed ref", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    await rec.recordToolCall({
      callId: "c1",
      name: "fetch_user",
      argsJson: JSON.stringify({ id: 42 }),
      result: { ok: true, valueJson: JSON.stringify({ name: "Ada" }) },
      durationMs: 7,
    });
    const flushed = await rec.flushStep(1);
    assertEquals(flushed.length, 1);
    const ev = flushed[0];
    if (ev.kind !== "tool_call") throw new Error("kind");
    assertEquals(ev.name, "fetch_user");
    assertEquals(ev.argsBytes, 9); // {"id":42}
    if (!ev.result.ok) throw new Error("expected ok");

    // Blob files exist at the sharded path.
    const argsBlob = join(dir, ev.argsRef!.path);
    const valueBlob = join(dir, ev.result.valueRef!.path);
    assertEquals(await Deno.readTextFile(argsBlob), '{"id":42}');
    assertEquals(await Deno.readTextFile(valueBlob), '{"name":"Ada"}');

    // io.jsonl has the matching record.
    const rows = await readJsonl(join(dir, "io.jsonl"));
    assertEquals(rows.length, 1);
    assertEquals(rows[0].stepIndex, 1);
    assertEquals(rows[0].seq, 0);
    assertEquals(rows[0].kind, "tool_call");
  });
});

Deno.test("blob dedup: two callsites with same body share one file", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    const same = JSON.stringify({ payload: "duplicate" });
    await rec.recordToolCall({
      callId: "a", name: "t", argsJson: same,
      result: { ok: true, valueJson: same }, durationMs: 1,
    });
    await rec.recordToolCall({
      callId: "b", name: "t", argsJson: same,
      result: { ok: true, valueJson: same }, durationMs: 1,
    });
    const events = await rec.flushStep(1);
    assertEquals(events.length, 2);
    // All four BlobRefs (2 args + 2 values) must resolve to the same path.
    const refs = events.flatMap((e) => {
      if (e.kind !== "tool_call") return [];
      if (!e.result.ok) return [];
      return [e.argsRef!.path, e.result.valueRef!.path];
    });
    assertEquals(new Set(refs).size, 1, "all four refs must share one blob path");
    // And only one physical file exists.
    const blobsRoot = join(dir, "blobs");
    let fileCount = 0;
    for await (const ent of walkFiles(blobsRoot)) {
      if (ent.isFile) fileCount++;
    }
    assertEquals(fileCount, 1);
  });
});

Deno.test("ioBodyBytes cap: oversized body is truncated; BlobRef.truncated = true; sha hashes the prefix", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps({ ioBodyBytes: 16 }) });
    rec.beginStep(1);
    const big = "x".repeat(100);
    await rec.recordToolCall({
      callId: "c", name: "t", argsJson: big,
      result: { ok: true, valueJson: "" }, durationMs: 1,
    });
    const [ev] = await rec.flushStep(1);
    if (ev.kind !== "tool_call") throw new Error("kind");
    assertEquals(ev.argsBytes, 100);
    assertEquals(ev.argsRef!.truncated, true);
    const onDisk = await Deno.readFile(join(dir, ev.argsRef!.path));
    assertEquals(onDisk.byteLength, 16);
    // sha is computed over the truncated bytes (reproducibility).
    assertEquals(ev.argsRef!.sha256, await sha256OfString("x".repeat(16)));
  });
});

Deno.test("ioStepTotalBytes cap: events past the budget record metadata only (bodyRef omitted)", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({
      sessionDir: dir,
      caps: caps({ ioBodyBytes: 100, ioStepTotalBytes: 100 }),
    });
    rec.beginStep(1);
    // First call uses the whole budget.
    await rec.recordToolCall({
      callId: "a", name: "t", argsJson: "a".repeat(100),
      result: { ok: true, valueJson: "" }, durationMs: 1,
    });
    // Second call should record metadata only.
    await rec.recordToolCall({
      callId: "b", name: "t", argsJson: "b".repeat(100),
      result: { ok: true, valueJson: "" }, durationMs: 1,
    });
    const events = await rec.flushStep(1);
    assertEquals(events.length, 2);
    if (events[0].kind !== "tool_call" || events[1].kind !== "tool_call") {
      throw new Error("kind");
    }
    assertNotEquals(events[0].argsRef, undefined, "first event must have a blob");
    assertEquals(events[1].argsRef, undefined, "second event must be metadata-only");
    assertEquals(events[1].argsBytes, 100, "argsBytes still records the original size");
  });
});

Deno.test("header redaction: case-insensitive name match; values for unlisted headers untouched", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({
      sessionDir: dir,
      caps: caps({ ioRedactHeaders: ["Authorization", "X-API-Key"] }),
    });
    rec.beginStep(1);
    await rec.recordFetch({
      callId: "c",
      request: {
        url: "https://api.example/x",
        method: "GET",
        headers: {
          "authorization": "Bearer secret123",
          "X-Api-Key": "k-deadbeef",
          "user-agent": "rex/1.0",
        },
      },
      response: {
        status: 200,
        headers: { "set-cookie": "sid=abc", "content-type": "text/plain" },
        body: new TextEncoder().encode("ok"),
        contentType: "text/plain",
      },
      durationMs: 1,
    });
    const [ev] = await rec.flushStep(1);
    if (ev.kind !== "fetch" || "error" in ev.response) throw new Error("kind");
    assertEquals(ev.request.headers["authorization"], IO_REDACTED_VALUE);
    assertEquals(ev.request.headers["X-Api-Key"], IO_REDACTED_VALUE);
    assertEquals(ev.request.headers["user-agent"], "rex/1.0");
    // set-cookie is NOT in the configured list for this test (we
    // overrode the default), so it passes through.
    assertEquals(ev.response.headers["set-cookie"], "sid=abc");
  });
});

Deno.test("recordFetch with error response: no blob written, error string preserved", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    await rec.recordFetch({
      callId: "c",
      request: { url: "https://x", method: "GET", headers: {} },
      response: { error: "network timeout" },
      durationMs: 50,
    });
    const [ev] = await rec.flushStep(1);
    if (ev.kind !== "fetch") throw new Error("kind");
    if (!("error" in ev.response)) throw new Error("expected error");
    assertEquals(ev.response.error, "network timeout");
    // No blobs directory needed since nothing was hashed.
    let any = false;
    for await (const _ of walkFiles(join(dir, "blobs"))) any = true;
    assertEquals(any, false);
  });
});

Deno.test("recordFsRead: dispatches per api kind; readDir + stat skip blob", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    await rec.recordFsRead({
      path: "/etc/x", api: "readDir", entries: 3, durationMs: 1,
    });
    await rec.recordFsRead({
      path: "/etc/y", api: "stat", stat: { size: 100 }, durationMs: 1,
    });
    await rec.recordFsRead({
      path: "/etc/z", api: "readTextFile",
      body: new TextEncoder().encode("hello"), durationMs: 1,
    });
    await rec.recordFsRead({
      path: "/etc/missing", api: "readTextFile",
      error: "ENOENT", durationMs: 1,
    });
    const events = await rec.flushStep(1);
    assertEquals(events.length, 4);
    const [a, b, c, d] = events.map((e) => e.kind === "fs_read" ? e : null);
    if (!a || !b || !c || !d) throw new Error("kind");
    if (a.result.ok === false || b.result.ok === false || c.result.ok === false) {
      throw new Error("expected ok");
    }
    if ("entries" in a.result) assertEquals(a.result.entries, 3);
    else throw new Error("readDir shape");
    if ("stat" in b.result) assertEquals(b.result.stat, { size: 100 });
    else throw new Error("stat shape");
    if ("bytes" in c.result) {
      assertEquals(c.result.bytes, 5);
      assertNotEquals(c.result.bodyRef, undefined);
    } else throw new Error("readTextFile shape");
    if (d.result.ok === false) {
      assertEquals(d.result.error, "ENOENT");
    } else throw new Error("expected error");
  });
});

Deno.test("recordWriteLib: ok path writes sourceRef; rejection records error + no blob", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    await rec.recordWriteLib({ ok: true, source: "export const x = 1;\n" });
    await rec.recordWriteLib({ ok: false, error: "lib too big" });
    const events = await rec.flushStep(1);
    assertEquals(events.length, 2);
    const [ok, err] = events;
    if (ok.kind !== "write_lib" || err.kind !== "write_lib") throw new Error("kind");
    assertEquals(ok.ok, true);
    assertNotEquals(ok.sourceRef, undefined);
    assertEquals(ok.sourceBytes, 20);
    assertEquals(err.ok, false);
    assertEquals(err.error, "lib too big");
    assertEquals(err.sourceRef, undefined);
  });
});

Deno.test("flushStep: writes one JSON line per event with stable {ts, stepIndex, seq} prefix", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(7);
    await rec.recordToolCall({
      callId: "a", name: "t", argsJson: "{}",
      result: { ok: true, valueJson: "{}" }, durationMs: 1,
    });
    await rec.recordToolCall({
      callId: "b", name: "t", argsJson: "{}",
      result: { ok: true, valueJson: "{}" }, durationMs: 1,
    });
    await rec.flushStep(7);
    const rows = await readJsonl(join(dir, "io.jsonl"));
    assertEquals(rows.length, 2);
    for (const r of rows) {
      assertEquals(r.stepIndex, 7);
      assertEquals(typeof r.ts, "string");
      assertStringIncludes(r.ts as string, "T"); // ISO 8601
      assertEquals(r.kind, "tool_call");
    }
    assertEquals(rows[0].seq, 0);
    assertEquals(rows[1].seq, 1);
  });
});

Deno.test("flushStep is idempotent within a step: second call returns []", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    await rec.recordWriteLib({ ok: true, source: "x" });
    const first = await rec.flushStep(1);
    const second = await rec.flushStep(1);
    assertEquals(first.length, 1);
    assertEquals(second.length, 0);
  });
});

Deno.test("step isolation: events from step N don't leak into step N+1", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    await rec.recordWriteLib({ ok: true, source: "step1" });
    await rec.flushStep(1);
    rec.beginStep(2);
    await rec.recordWriteLib({ ok: true, source: "step2" });
    const step2 = await rec.flushStep(2);
    assertEquals(step2.length, 1);
    if (step2[0].kind !== "write_lib") throw new Error("kind");
    // io.jsonl carries both, distinguishable by stepIndex.
    const rows = await readJsonl(join(dir, "io.jsonl"));
    assertEquals(rows.length, 2);
    assertEquals(rows[0].stepIndex, 1);
    assertEquals(rows[1].stepIndex, 2);
  });
});

Deno.test("regression — concurrent record*() honors ioStepTotalBytes (review finding #1)", async () => {
  await withTempDir(async (dir) => {
    // Two 100-byte calls fired in parallel, step budget = 100. Without
    // serialization both can read #stepBodyBytes at 0 and both persist
    // their 100 bytes. With the op chain in place, the second must
    // observe the first's increment and record metadata-only.
    const rec = new IORecorder({
      sessionDir: dir,
      caps: caps({ ioBodyBytes: 200, ioStepTotalBytes: 100 }),
    });
    rec.beginStep(1);
    const a = rec.recordToolCall({
      callId: "a", name: "t", argsJson: "a".repeat(100),
      result: { ok: true, valueJson: "" }, durationMs: 1,
    });
    const b = rec.recordToolCall({
      callId: "b", name: "t", argsJson: "b".repeat(100),
      result: { ok: true, valueJson: "" }, durationMs: 1,
    });
    await Promise.all([a, b]);
    const events = await rec.flushStep(1);
    assertEquals(events.length, 2);
    if (events[0].kind !== "tool_call" || events[1].kind !== "tool_call") {
      throw new Error("kind");
    }
    // Total bytes persisted to blobs must be <= step cap.
    let totalBytes = 0;
    for await (const ent of walkFiles(join(dir, "blobs"))) {
      if (ent.isFile) {
        const stat = await Deno.stat(ent.path);
        totalBytes += stat.size;
      }
    }
    assertEquals(
      totalBytes <= 100,
      true,
      `total blob bytes must respect step cap; got ${totalBytes}`,
    );
    // First call (entered first) gets the blob; second is metadata-only.
    assertNotEquals(events[0].argsRef, undefined);
    assertEquals(events[1].argsRef, undefined);
  });
});

Deno.test("regression — seq reflects call order, not async-completion order (review finding #2)", async () => {
  await withTempDir(async (dir) => {
    // recordA enters first but does no async work besides the chain.
    // recordB enters second. Without serialization B could push before
    // A finishes its blob write. With the op chain + sync seq capture,
    // io.jsonl shows A at seq=0, B at seq=1.
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    // Fire in deterministic order; do not await individually.
    const p1 = rec.recordToolCall({
      callId: "first", name: "t",
      argsJson: "a".repeat(100), // bigger body → slower hash + write
      result: { ok: true, valueJson: "" }, durationMs: 1,
    });
    const p2 = rec.recordToolCall({
      callId: "second", name: "t",
      argsJson: "b", // tiny body, would finish first if parallel
      result: { ok: true, valueJson: "" }, durationMs: 1,
    });
    await Promise.all([p1, p2]);
    const events = await rec.flushStep(1);
    assertEquals(events.length, 2);
    if (events[0].kind !== "tool_call" || events[1].kind !== "tool_call") {
      throw new Error("kind");
    }
    assertEquals(events[0].callId, "first");
    assertEquals(events[1].callId, "second");
    // And the on-disk io.jsonl agrees.
    const rows = await readJsonl(join(dir, "io.jsonl"));
    assertEquals(rows[0].seq, 0);
    assertEquals((rows[0] as { callId: string }).callId, "first");
    assertEquals(rows[1].seq, 1);
    assertEquals((rows[1] as { callId: string }).callId, "second");
  });
});

Deno.test("regression — ioBodyBytes=0 records metadata-only without empty-sha blobs (review finding #3)", async () => {
  await withTempDir(async (dir) => {
    const rec = new IORecorder({
      sessionDir: dir,
      caps: caps({ ioBodyBytes: 0 }),
    });
    rec.beginStep(1);
    await rec.recordToolCall({
      callId: "c", name: "t", argsJson: "anything",
      result: { ok: true, valueJson: "value" }, durationMs: 1,
    });
    const [ev] = await rec.flushStep(1);
    if (ev.kind !== "tool_call") throw new Error("kind");
    assertEquals(ev.argsRef, undefined, "no blob ref when ioBodyBytes = 0");
    if (!ev.result.ok) throw new Error("expected ok");
    assertEquals(ev.result.valueRef, undefined, "no value ref when ioBodyBytes = 0");
    assertEquals(ev.argsBytes, 8); // original size still recorded
    // No blob files written.
    let any = false;
    for await (const _ of walkFiles(join(dir, "blobs"))) any = true;
    assertEquals(any, false);
  });
});

Deno.test("constructor rejects negative IO caps", () => {
  let threw = false;
  try {
    new IORecorder({
      sessionDir: "/tmp/x",
      caps: caps({ ioBodyBytes: -1 }),
    });
  } catch { threw = true; }
  assertEquals(threw, true);
  threw = false;
  try {
    new IORecorder({
      sessionDir: "/tmp/x",
      caps: caps({ ioStepTotalBytes: -1 }),
    });
  } catch { threw = true; }
  assertEquals(threw, true);
});

Deno.test("flushStep awaits in-flight record ops before draining", async () => {
  await withTempDir(async (dir) => {
    // If flushStep returned before pending blob writes settled, the
    // event would be absent from the returned array and io.jsonl. The
    // op chain guarantees flushStep waits for all enqueued record ops.
    const rec = new IORecorder({ sessionDir: dir, caps: caps() });
    rec.beginStep(1);
    rec.recordToolCall({
      callId: "c", name: "t", argsJson: "x".repeat(1024),
      result: { ok: true, valueJson: "y" }, durationMs: 1,
    });
    // Note: NOT awaiting the recordToolCall above.
    const events = await rec.flushStep(1);
    assertEquals(events.length, 1, "flushStep must wait for the pending record");
    const rows = await readJsonl(join(dir, "io.jsonl"));
    assertEquals(rows.length, 1);
  });
});

Deno.test("blobRelPath: two-level shard from first 4 hex chars", () => {
  assertEquals(
    blobRelPath("ab12cdef" + "00".repeat(28)),
    "blobs/ab/12/ab12cdef" + "00".repeat(28),
  );
});

// ── helpers ────────────────────────────────────────────────────────────

async function* walkFiles(root: string): AsyncIterable<Deno.DirEntry & { path: string }> {
  try {
    for await (const entry of Deno.readDir(root)) {
      const path = join(root, entry.name);
      if (entry.isDirectory) {
        for await (const inner of walkFiles(path)) yield inner;
      } else {
        yield { ...entry, path };
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

async function sha256OfString(s: string): Promise<string> {
  const ab = new ArrayBuffer(s.length);
  new Uint8Array(ab).set(new TextEncoder().encode(s));
  const buf = await crypto.subtle.digest("SHA-256", ab);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
