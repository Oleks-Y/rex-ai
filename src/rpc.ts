// Length-prefixed JSON RPC framing (parent ↔ sandbox).
//
// Wire format per §5:
//
//   <decimal byte count>\n<JSON payload>
//
// Examples:
//   12\n{"type":"x"}\n     ← invalid: there's a stray \n after the payload
//   12\n{"type":"x"}       ← valid: byte count is exact, no trailing newline
//
// Notes:
//   - The length is the *byte* length of the UTF-8 JSON, not characters.
//   - Frames are back-to-back: after reading `len` bytes, the next byte is
//     either the start of another length line or EOF.
//   - We deliberately don't share writers across calls — they're cheap, and
//     each `writeFrame` writes a complete frame and yields control. That
//     keeps the protocol robust against interleaved writers (which we
//     shouldn't have, but defensive coding here is cheap insurance).

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** Default max bytes per frame — bigger than any documented size cap. */
export const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024; // 4 MiB

export class RpcFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcFramingError";
  }
}

/** Encode `value` as a single framed JSON message. */
export function encodeFrame(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new RpcFramingError("value is not JSON-serializable");
  }
  const body = enc.encode(json);
  const header = enc.encode(`${body.length}\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/**
 * Write a single frame to `writable`. Acquires and releases a writer for
 * each call — fine for our throughput, and means concurrent writes from
 * different control paths don't risk interleaving.
 */
export async function writeFrame(
  writable: WritableStream<Uint8Array>,
  value: unknown,
): Promise<void> {
  const w = writable.getWriter();
  try {
    await w.write(encodeFrame(value));
  } finally {
    w.releaseLock();
  }
}

/**
 * Streaming frame reader. Consumes bytes from an async source and yields
 * one parsed JSON frame at a time.
 */
export class FrameReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buf: Uint8Array = new Uint8Array(0);
  #closed = false;
  #maxFrameBytes: number;

  constructor(
    stream: ReadableStream<Uint8Array>,
    opts: { maxFrameBytes?: number } = {},
  ) {
    this.#reader = stream.getReader();
    this.#maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Release the underlying reader lock. Safe to call multiple times. */
  release(): void {
    if (!this.#closed) {
      try {
        this.#reader.releaseLock();
      } catch { /* already unlocked */ }
      this.#closed = true;
    }
  }

  /**
   * Release the lock and cancel the underlying stream. Use this when the
   * caller is done reading and wants to shut the source down (e.g. after
   * a child process exited and we want to drop the pipe).
   */
  async cancel(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#reader.cancel();
    } catch { /* already cancelled */ }
    this.release();
  }

  /**
   * Read the next frame. Resolves to `null` at clean EOF (no buffered bytes).
   * Throws RpcFramingError on malformed input or oversize frames.
   */
  async readFrame(): Promise<unknown | null> {
    while (true) {
      const newlineIdx = this.#buf.indexOf(0x0a /* \n */);
      if (newlineIdx === -1) {
        if (!(await this.#pull())) {
          if (this.#buf.length === 0) return null; // clean EOF
          throw new RpcFramingError("unexpected EOF: no length terminator");
        }
        continue;
      }

      // Parse the length header.
      const headerBytes = this.#buf.subarray(0, newlineIdx);
      const headerStr = dec.decode(headerBytes);
      if (!/^[0-9]+$/.test(headerStr)) {
        throw new RpcFramingError(
          `invalid frame length header: ${JSON.stringify(headerStr)}`,
        );
      }
      const len = Number(headerStr);
      if (!Number.isSafeInteger(len) || len < 0) {
        throw new RpcFramingError(`invalid frame length: ${headerStr}`);
      }
      if (len > this.#maxFrameBytes) {
        throw new RpcFramingError(
          `frame too large: ${len} > ${this.#maxFrameBytes}`,
        );
      }

      // Pull until we have the full body.
      const total = newlineIdx + 1 + len;
      while (this.#buf.length < total) {
        if (!(await this.#pull())) {
          throw new RpcFramingError(
            `unexpected EOF: needed ${total} bytes, have ${this.#buf.length}`,
          );
        }
      }

      const body = this.#buf.subarray(newlineIdx + 1, total);
      // Advance the buffer past this frame.
      this.#buf = this.#buf.subarray(total);

      let json: string;
      try {
        json = dec.decode(body);
      } catch (e) {
        throw new RpcFramingError(`frame body is not valid UTF-8: ${(e as Error).message}`);
      }
      try {
        return JSON.parse(json);
      } catch (e) {
        throw new RpcFramingError(`frame body is not valid JSON: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Pull the next chunk into the buffer. Returns false on EOF.
   */
  async #pull(): Promise<boolean> {
    const { value, done } = await this.#reader.read();
    if (done) return false;
    if (!value || value.length === 0) return true; // spurious empty chunk
    if (this.#buf.length === 0) {
      this.#buf = value;
    } else {
      const merged = new Uint8Array(this.#buf.length + value.length);
      merged.set(this.#buf, 0);
      merged.set(value, this.#buf.length);
      this.#buf = merged;
    }
    return true;
  }
}
