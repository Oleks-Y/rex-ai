import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  FrameReader,
  RpcFramingError,
  writeFrame,
} from "../../src/rpc.ts";

const enc = new TextEncoder();

/** Build a ReadableStream that emits each chunk in `chunks` in order. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

Deno.test("encodeFrame: header is byte length not char length", () => {
  const out = encodeFrame({ s: "héllo" }); // é is 2 UTF-8 bytes
  const text = new TextDecoder().decode(out);
  // body JSON: {"s":"héllo"} — count UTF-8 bytes of that
  const body = JSON.stringify({ s: "héllo" });
  const expectedHeader = `${enc.encode(body).length}\n`;
  assertEquals(text.startsWith(expectedHeader), true);
});

Deno.test("encodeFrame: rejects non-serializable values", () => {
  assertThrows(
    () => encodeFrame(undefined),
    RpcFramingError,
    "JSON-serializable",
  );
});

Deno.test("FrameReader: reads a single frame", async () => {
  const frame = encodeFrame({ type: "reply", message: "hi" });
  const r = new FrameReader(streamOf([frame]));
  assertEquals(await r.readFrame(), { type: "reply", message: "hi" });
  assertEquals(await r.readFrame(), null);
});

Deno.test("FrameReader: reads multiple frames in one chunk", async () => {
  const a = encodeFrame({ type: "log", level: "info", args: [1] });
  const b = encodeFrame({ type: "reply", message: "x" });
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  const r = new FrameReader(streamOf([merged]));
  assertEquals(await r.readFrame(), { type: "log", level: "info", args: [1] });
  assertEquals(await r.readFrame(), { type: "reply", message: "x" });
  assertEquals(await r.readFrame(), null);
});

Deno.test("FrameReader: handles partial reads (frame split across chunks)", async () => {
  const frame = encodeFrame({ type: "reply", message: "split me" });
  // Split into 3 weird chunks: 1 byte, then a chunk straddling header/body, then rest.
  const chunks = [
    frame.subarray(0, 1),
    frame.subarray(1, 3),
    frame.subarray(3, 10),
    frame.subarray(10),
  ];
  const r = new FrameReader(streamOf(chunks));
  assertEquals(await r.readFrame(), { type: "reply", message: "split me" });
});

Deno.test("FrameReader: empty chunks are tolerated", async () => {
  const frame = encodeFrame({ ok: true });
  const r = new FrameReader(streamOf([new Uint8Array(0), frame, new Uint8Array(0)]));
  assertEquals(await r.readFrame(), { ok: true });
  assertEquals(await r.readFrame(), null);
});

Deno.test("FrameReader: invalid length header → RpcFramingError", async () => {
  const r = new FrameReader(streamOf([enc.encode("notanumber\n{}")]));
  await assertRejects(() => r.readFrame(), RpcFramingError, "invalid frame length");
});

Deno.test("FrameReader: oversize frame rejected before buffering body", async () => {
  const r = new FrameReader(
    streamOf([enc.encode(`${DEFAULT_MAX_FRAME_BYTES + 1}\n`)]),
    { maxFrameBytes: 32 },
  );
  await assertRejects(() => r.readFrame(), RpcFramingError, "too large");
});

Deno.test("FrameReader: malformed JSON body → RpcFramingError", async () => {
  // length 5, then "not a JSON" — only 5 bytes are read, but they aren't valid JSON
  const r = new FrameReader(streamOf([enc.encode("5\nnotaJ")]));
  await assertRejects(() => r.readFrame(), RpcFramingError, "not valid JSON");
});

Deno.test("FrameReader: clean EOF after last frame returns null", async () => {
  const f = encodeFrame({ a: 1 });
  const r = new FrameReader(streamOf([f]));
  assertEquals(await r.readFrame(), { a: 1 });
  assertEquals(await r.readFrame(), null);
});

Deno.test("FrameReader: EOF mid-header → RpcFramingError", async () => {
  const r = new FrameReader(streamOf([enc.encode("12")])); // no newline
  await assertRejects(() => r.readFrame(), RpcFramingError, "no length terminator");
});

Deno.test("FrameReader: EOF mid-body → RpcFramingError", async () => {
  // length says 10 bytes, but only 3 follow before stream closes
  const r = new FrameReader(streamOf([enc.encode("10\nabc")]));
  await assertRejects(() => r.readFrame(), RpcFramingError, "needed");
});

Deno.test("writeFrame round-trips through a TransformStream", async () => {
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const reader = new FrameReader(ts.readable);
  const send = (async () => {
    await writeFrame(ts.writable, { type: "reply", message: "rt" });
    await writeFrame(ts.writable, { type: "log", level: "info", args: ["x"] });
    await ts.writable.close();
  })();
  const got: unknown[] = [];
  for (let f = await reader.readFrame(); f !== null; f = await reader.readFrame()) got.push(f);
  await send;
  assertEquals(got, [
    { type: "reply", message: "rt" },
    { type: "log", level: "info", args: ["x"] },
  ]);
});

Deno.test("writeFrame is safe under back-to-back writes (no interleaving)", async () => {
  // Write 50 frames as fast as possible; ensure all parse and order is preserved.
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const reader = new FrameReader(ts.readable);
  const send = (async () => {
    for (let i = 0; i < 50; i++) {
      await writeFrame(ts.writable, { i });
    }
    await ts.writable.close();
  })();
  const got: number[] = [];
  for (let f = await reader.readFrame(); f !== null; f = await reader.readFrame()) {
    got.push((f as { i: number }).i);
  }
  await send;
  assertEquals(got, Array.from({ length: 50 }, (_, i) => i));
});
