// Extended-transcript recorder — captures IOEvent records into the
// session's sidecar `io.jsonl` + a content-addressed `blobs/` tree.
//
// The recorder is the single ownership point for the extended transcript:
// callers (sandbox prelude wrappers in PR3, parent tool/lib dispatchers
// in PR2) hand it a fully-resolved record_*() call and it owns
// truncation, header redaction, blob hashing, per-step budget
// enforcement, and the io.jsonl append.
//
// Concurrency model: parent-side dispatchers (PersistentSandbox /
// Sandbox) fire tool / writeLib / storage handlers in parallel. The
// recorder MUST treat record_*() calls as concurrent — both because
// of those parent dispatchers and because the dreamer's recorder
// sees the same shape. Two invariants:
//
//   1. `seq` is captured SYNCHRONOUSLY at recordX entry, so the
//      JSONL `seq` field reflects call order (not async-completion
//      order — a slow fetch must not be sequenced after a faster
//      tool call that started later).
//   2. The body-budget read + blob persist + buffer write run inside
//      a serialized op chain so two concurrent calls cannot both
//      read `#stepBodyBytes` at 0 before either increments it.
//
// Append-only io.jsonl, one JSON line per IOEvent. Content-addressed
// blobs, sharded by first 4 hex of the sha256 (`blobs/ab/cd/<sha>`).
// Bodies larger than `caps.ioBodyBytes` are truncated to that many
// bytes BEFORE hashing, so the BlobRef is reproducible from the
// bytes on disk. `truncated: true` flags the prefix.
// Per-step total-body cap (`caps.ioStepTotalBytes`): once exhausted,
// subsequent records in the same step record metadata only (bodyRef
// omitted). Configured caps of 0 mean "metadata-only by policy" —
// the event still lands in io.jsonl, just without a body blob.

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { BlobRef, IOEvent, SizeCaps } from "./types.ts";
import { IO_REDACTED_VALUE } from "./types.ts";

export interface IORecorderOpts {
  /** Absolute path to the session directory that owns `io.jsonl` and
   *  `blobs/`. The recorder creates `blobs/` lazily on first write. */
  sessionDir: string;
  caps: SizeCaps;
}

export class IORecorder {
  readonly #sessionDir: string;
  readonly #caps: SizeCaps;
  readonly #ioJsonlPath: string;
  readonly #redactSet: Set<string>;

  /** Per-step monotonic seq counter, assigned synchronously at
   *  recordX entry. Reset on `beginStep`. */
  #seq = 0;
  /** Bytes persisted to blobs in the current step. Mutated only
   *  inside the serialized op chain so concurrent recordX calls
   *  can't both read it at 0 before either increments it. */
  #stepBodyBytes = 0;
  /** Buffered events for the current step. Indexed by `seq`. Drained
   *  on `flushStep`. Holes (undefined slots) are tolerated and
   *  filtered out on drain — they only occur if a record op was
   *  enqueued for a different step than the active one, which is a
   *  programming error and we'd rather observe than crash on. */
  #buffer: (IOEvent | undefined)[] = [];
  /** Step the recorder is currently buffering for. -1 between steps. */
  #stepIndex = -1;
  /** Promise chain that serializes all record_*() body work +
   *  flushStep IO. Each new op chains onto this so concurrent callers
   *  observe FIFO execution. Errors propagate to the specific awaiter. */
  #opChain: Promise<void> = Promise.resolve();

  constructor(opts: IORecorderOpts) {
    if (opts.caps.ioBodyBytes < 0) {
      throw new Error("IORecorder: caps.ioBodyBytes must be >= 0 (0 means metadata-only)");
    }
    if (opts.caps.ioStepTotalBytes < 0) {
      throw new Error("IORecorder: caps.ioStepTotalBytes must be >= 0 (0 means metadata-only)");
    }
    this.#sessionDir = opts.sessionDir;
    this.#caps = opts.caps;
    this.#ioJsonlPath = join(opts.sessionDir, "io.jsonl");
    this.#redactSet = new Set(opts.caps.ioRedactHeaders.map((h) => h.toLowerCase()));
  }

  /** Open a fresh step buffer. Call at the top of each step before any
   *  record_* calls for that step. */
  beginStep(stepIndex: number): void {
    this.#seq = 0;
    this.#stepBodyBytes = 0;
    this.#buffer = [];
    this.#stepIndex = stepIndex;
  }

  /** Persist the step's buffered IOEvents to `io.jsonl` and return the
   *  array (so the agent loop can attach it to the in-memory
   *  `StepRecord.io`). Idempotent: a second call returns `[]`.
   *
   *  Implicitly drains any in-flight record_*() calls first by chaining
   *  onto `#opChain` — callers don't need to await individual recordX
   *  promises before calling flushStep. */
  async flushStep(stepIndex: number): Promise<IOEvent[]> {
    // Wait for any pending record ops to complete and persist their
    // blob + buffer slot before draining.
    try { await this.#opChain; } catch { /* per-op error; recover */ }

    if (stepIndex !== this.#stepIndex) {
      // Either no step was begun or a different step was active —
      // return empty rather than throw, so callers don't have to guard.
      return [];
    }
    // Filter holes (undefined slots from mis-routed record ops).
    const events = this.#buffer.filter((e): e is IOEvent => e !== undefined);
    this.#buffer = [];
    this.#stepIndex = -1;
    if (events.length === 0) return [];

    const lines = events.map((ev, i) => {
      return JSON.stringify({
        ts: new Date().toISOString(),
        stepIndex,
        seq: i,
        ...ev,
      }) + "\n";
    }).join("");

    const sessionDir = this.#sessionDir;
    const path = this.#ioJsonlPath;
    this.#opChain = this.#opChain.then(async () => {
      await ensureDir(sessionDir);
      await Deno.writeTextFile(path, lines, { append: true });
    });
    try { await this.#opChain; } catch { /* IO errors are non-fatal observability */ }
    return events;
  }

  // ── recorders ──────────────────────────────────────────────────────────

  recordFetch(args: {
    callId: string;
    request: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: Uint8Array;
    };
    response:
      | {
        status: number;
        headers: Record<string, string>;
        body: Uint8Array;
        contentType?: string;
      }
      | { error: string };
    durationMs: number;
  }): Promise<void> {
    const { seq, stepIndex } = this.#claimSlot();
    return this.#enqueue(seq, stepIndex, async () => {
      const reqBodyBytes = args.request.body?.byteLength ?? 0;
      const reqBlob = args.request.body
        ? await this.#maybePersistBody(args.request.body)
        : undefined;
      let response: (IOEvent & { kind: "fetch" })["response"];
      if ("error" in args.response) {
        response = { error: args.response.error };
      } else {
        const resBodyBytes = args.response.body.byteLength;
        const resBlob = await this.#maybePersistBody(args.response.body);
        response = {
          status: args.response.status,
          headers: this.#redactHeaders(args.response.headers),
          bodyRef: resBlob,
          bodyBytes: resBodyBytes,
          ...(args.response.contentType ? { contentType: args.response.contentType } : {}),
        };
      }
      return {
        kind: "fetch",
        callId: args.callId,
        request: {
          url: args.request.url,
          method: args.request.method,
          headers: this.#redactHeaders(args.request.headers),
          bodyRef: reqBlob,
          bodyBytes: reqBodyBytes,
        },
        response,
        durationMs: args.durationMs,
      };
    });
  }

  recordFsRead(args: {
    path: string;
    api: "readTextFile" | "readFile" | "readDir" | "stat";
    body?: Uint8Array;
    entries?: number;
    stat?: Record<string, unknown>;
    error?: string;
    durationMs: number;
  }): Promise<void> {
    const { seq, stepIndex } = this.#claimSlot();
    return this.#enqueue(seq, stepIndex, async () => {
      let result: (IOEvent & { kind: "fs_read" })["result"];
      if (args.error !== undefined) {
        result = { ok: false, error: args.error };
      } else if (args.api === "readDir") {
        result = { ok: true, entries: args.entries ?? 0 };
      } else if (args.api === "stat") {
        result = { ok: true, stat: args.stat ?? {} };
      } else {
        const bytes = args.body?.byteLength ?? 0;
        const blob = args.body ? await this.#maybePersistBody(args.body) : undefined;
        result = { ok: true, bytes, bodyRef: blob };
      }
      return {
        kind: "fs_read",
        path: args.path,
        api: args.api,
        result,
        durationMs: args.durationMs,
      };
    });
  }

  recordToolCall(args: {
    callId: string;
    name: string;
    argsJson: string;
    result: { ok: true; valueJson: string } | { ok: false; error: string };
    durationMs: number;
  }): Promise<void> {
    const { seq, stepIndex } = this.#claimSlot();
    return this.#enqueue(seq, stepIndex, async () => {
      const enc = new TextEncoder();
      const argsBytes = enc.encode(args.argsJson);
      const argsRef = argsBytes.byteLength > 0
        ? await this.#maybePersistBody(argsBytes)
        : undefined;
      let result: (IOEvent & { kind: "tool_call" })["result"];
      if (args.result.ok) {
        const v = enc.encode(args.result.valueJson);
        const valueRef = v.byteLength > 0
          ? await this.#maybePersistBody(v)
          : undefined;
        result = { ok: true, valueRef, valueBytes: v.byteLength };
      } else {
        result = { ok: false, error: args.result.error };
      }
      return {
        kind: "tool_call",
        callId: args.callId,
        name: args.name,
        argsRef,
        argsBytes: argsBytes.byteLength,
        result,
        durationMs: args.durationMs,
      };
    });
  }

  recordWriteLib(args: {
    ok: boolean;
    source?: string;
    error?: string;
  }): Promise<void> {
    const { seq, stepIndex } = this.#claimSlot();
    return this.#enqueue(seq, stepIndex, async () => {
      const enc = new TextEncoder();
      const sourceBytes = args.source !== undefined
        ? enc.encode(args.source).byteLength
        : 0;
      let sourceRef: BlobRef | undefined;
      if (args.ok && args.source !== undefined && sourceBytes > 0) {
        sourceRef = await this.#maybePersistBody(enc.encode(args.source));
      }
      return {
        kind: "write_lib",
        ok: args.ok,
        sourceBytes,
        ...(sourceRef ? { sourceRef } : {}),
        ...(args.error !== undefined ? { error: args.error } : {}),
      };
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Assign a synchronous seq + capture the active step. Calls made
   *  before beginStep() (a programming error) get seq -1 / step -1 and
   *  the buffer write in `#enqueue` will be a no-op. */
  #claimSlot(): { seq: number; stepIndex: number } {
    const seq = this.#seq++;
    const stepIndex = this.#stepIndex;
    // Reserve the buffer slot so concurrent recordX calls don't race
    // on `length`. The eventual event overwrites this placeholder.
    if (stepIndex >= 0) this.#buffer[seq] = undefined;
    return { seq, stepIndex };
  }

  /** Chain `build()` after every pending op, store its result at the
   *  claimed seq slot if the step is still active. */
  #enqueue(
    seq: number,
    stepIndex: number,
    build: () => Promise<IOEvent>,
  ): Promise<void> {
    const next = this.#opChain.then(async () => {
      const ev = await build();
      // The step may have ended mid-flight (flushStep races a slow
      // recorder). Drop the event in that case — its seq slot has
      // already been recycled by beginStep.
      if (this.#stepIndex !== stepIndex) return;
      this.#buffer[seq] = ev;
    });
    this.#opChain = next.catch(() => {});
    return next;
  }

  #redactHeaders(headers: Record<string, string>): Record<string, string> {
    if (this.#redactSet.size === 0) return { ...headers };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = this.#redactSet.has(k.toLowerCase()) ? IO_REDACTED_VALUE : v;
    }
    return out;
  }

  /** Persist a body to the blob store, honoring per-body and per-step
   *  caps. Returns undefined when:
   *   - `caps.ioBodyBytes` is 0 (per-body cap = metadata-only by policy)
   *   - `caps.ioStepTotalBytes` is 0 (per-step cap = metadata-only)
   *   - the per-step body budget is already exhausted
   *   - the input is empty (0 bytes)
   *
   *  Mutates `#stepBodyBytes` — caller must hold the op chain to
   *  prevent concurrent reads of stale values. */
  async #maybePersistBody(body: Uint8Array): Promise<BlobRef | undefined> {
    if (body.byteLength === 0) return undefined;
    if (this.#caps.ioBodyBytes === 0) return undefined;
    if (this.#caps.ioStepTotalBytes === 0) return undefined;
    if (this.#stepBodyBytes >= this.#caps.ioStepTotalBytes) return undefined;

    // Truncate first so the sha is computed over the bytes we actually
    // write. A 100MB body with cap=256KB → BlobRef.truncated=true, sha
    // is of the first 256KB, file on disk is the first 256KB.
    const limit = this.#caps.ioBodyBytes;
    const truncated = body.byteLength > limit;
    const slice = truncated ? body.subarray(0, limit) : body;

    // Also honor the per-step total: if writing this would push us past
    // the step total, write what fits and mark truncated.
    const remaining = this.#caps.ioStepTotalBytes - this.#stepBodyBytes;
    const finalLen = Math.min(slice.byteLength, remaining);
    if (finalLen === 0) return undefined;
    const finalSlice = finalLen === slice.byteLength ? slice : slice.subarray(0, finalLen);
    const finalTruncated = truncated || finalLen < slice.byteLength;

    const sha = await sha256Hex(finalSlice);
    const relPath = blobRelPath(sha);
    const absPath = join(this.#sessionDir, relPath);

    // Dedup: skip write if file already exists. Even on dedup we still
    // charge the body bytes against the step budget — the dreamer sees
    // the same body N times and pays for it conceptually each time.
    try {
      const st = await Deno.stat(absPath);
      if (st.isFile) {
        this.#stepBodyBytes += finalSlice.byteLength;
        return { sha256: sha, path: relPath, truncated: finalTruncated };
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    await ensureDir(join(this.#sessionDir, "blobs", sha.slice(0, 2), sha.slice(2, 4)));
    await Deno.writeFile(absPath, finalSlice);
    this.#stepBodyBytes += finalSlice.byteLength;
    return { sha256: sha, path: relPath, truncated: finalTruncated };
  }
}

/** Two-level sharded path: `blobs/<sha[0:2]>/<sha[2:4]>/<sha>`.
 *  Exported for tests + observability tooling that resolves a `BlobRef`
 *  against a session dir without constructing a recorder. */
export function blobRelPath(sha256: string): string {
  return `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer to satisfy WebCrypto's BufferSource
  // typing (Deno's Uint8Array can be backed by SharedArrayBuffer).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const buf = await crypto.subtle.digest("SHA-256", ab);
  const arr = new Uint8Array(buf);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
}
