// Tracer — single source of truth for the structured trace event stream.
//
// Fans each emitted event out to:
//   1. the user's `onTrace(event)` callback (if any),
//   2. a debug formatter that writes one line per event to stderr (when
//      `debug` is on), and
//   3. an optional `<sessionDir>/trace.jsonl` file.
//
// Design notes:
//   - emit() is async. The caller may fire-and-forget (`tracer.emit(...)`)
//     for non-critical events, or `await` it where ordering matters.
//   - Persistence is serialized through a single Promise chain so concurrent
//     emits don't interleave bytes within the file. The chain is awaited by
//     close().
//   - onTrace errors are caught. The first one is reported to the debug
//     stream; subsequent ones are silenced to avoid loops.
//   - The 0-th event is always emitted at ts=0, seq=0 (the Tracer's clock
//     starts in the constructor — the run owner should construct it at the
//     beginning of run()).

import type { TraceEvent } from "./types.ts";

/** Distributive Omit so each member of the discriminated union keeps its
 *  own narrow shape after the envelope fields are stripped. (A plain
 *  `Omit<TraceEvent, "ts"|"seq">` collapses the union and loses fields
 *  unique to a single variant.) */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
type TraceEventInput = DistributiveOmit<TraceEvent, "ts" | "seq">;

export type TraceListener = (event: TraceEvent) => void | Promise<void>;
export type DebugWriter = (line: string) => void;

export interface TracerOptions {
  onTrace?: TraceListener;
  /** When true, every event is formatted and written via `debugWrite`. */
  debug: boolean;
  /** Custom debug-line sink. Default: write to stderr. */
  debugWrite?: DebugWriter;
  /** Path to write trace.jsonl. Omit to skip persistence. */
  persistPath?: string;
}

export interface TracerFactoryArgs {
  onTrace?: TraceListener;
  /** Explicit override. When undefined, falls back to REX_DEBUG env var. */
  debug?: boolean;
  persistTrace?: boolean;
  /** Required when persistTrace is true; ignored otherwise. */
  sessionDir?: string;
  /** Test hook. */
  debugWrite?: DebugWriter;
  /** Test hook for env lookup. */
  envGet?: (name: string) => string | undefined;
}

export class Tracer {
  readonly #onTrace?: TraceListener;
  readonly #debug: boolean;
  readonly #debugWrite: DebugWriter;
  readonly #persistPath?: string;
  readonly #start: number;
  #seq = 0;
  #onTraceErrorReported = false;
  #persistFile?: Deno.FsFile;
  #persistChain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(opts: TracerOptions) {
    this.#onTrace = opts.onTrace;
    this.#debug = opts.debug;
    this.#debugWrite = opts.debugWrite ?? defaultDebugWrite;
    this.#persistPath = opts.persistPath;
    this.#start = performance.now();
  }

  /**
   * Resolve the {debug, persistPath} pair from the higher-level
   * {debug?, persistTrace?, sessionDir?} the Agent receives. Folds in the
   * REX_DEBUG env var when `debug` is undefined.
   */
  static fromOptions(args: TracerFactoryArgs): Tracer {
    const env = args.envGet ?? ((n) => Deno.env.get(n));
    const debug = args.debug ?? parseDebugEnv(env("REX_DEBUG"));
    let persistPath: string | undefined;
    if (args.persistTrace) {
      if (args.sessionDir) {
        persistPath = `${args.sessionDir}/trace.jsonl`;
      } else if (debug) {
        // Surface the misconfig once so the user notices.
        const w = args.debugWrite ?? defaultDebugWrite;
        try {
          w("[rex] persistTrace requested but no sessionId set — skipping persistence");
        } catch { /* */ }
      }
    }
    return new Tracer({
      onTrace: args.onTrace,
      debug,
      debugWrite: args.debugWrite,
      persistPath,
    });
  }

  /** Whether anyone is listening (cheap-skip helper for hot paths). */
  get isActive(): boolean {
    return !!this.#onTrace || this.#debug || !!this.#persistPath;
  }

  /**
   * Emit one event. Fills in `ts` and `seq`. Fans out to the debug stream,
   * the persistence file, and `onTrace`.
   *
   * The promise resolves once `onTrace` (if async) settles. Persistence is
   * serialized internally; awaiting the returned promise does NOT guarantee
   * the line has reached disk — call `close()` for that.
   */
  async emit(partial: TraceEventInput): Promise<void> {
    if (this.#closed) return;
    const event = {
      ...(partial as Record<string, unknown>),
      ts: Math.round(performance.now() - this.#start),
      seq: this.#seq++,
    } as TraceEvent;

    if (this.#debug) {
      try {
        this.#debugWrite(formatTraceEvent(event));
      } catch { /* */ }
    }

    if (this.#persistPath) {
      // Capture the line synchronously; serialize the I/O on the chain so
      // concurrent emits can't interleave bytes.
      const line = JSON.stringify(event) + "\n";
      this.#persistChain = this.#persistChain.then(() => this.#writeLine(line));
    }

    if (this.#onTrace) {
      try {
        await this.#onTrace(event);
      } catch (e) {
        if (!this.#onTraceErrorReported) {
          this.#onTraceErrorReported = true;
          try {
            this.#debugWrite(
              `[rex] onTrace threw (further errors silenced): ${(e as Error).message}`,
            );
          } catch { /* */ }
        }
      }
    }
  }

  /** Flush pending persistence and close any open file handles. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#persistChain;
    } catch { /* */ }
    if (this.#persistFile) {
      try {
        this.#persistFile.close();
      } catch { /* already closed */ }
      this.#persistFile = undefined;
    }
  }

  async #writeLine(line: string): Promise<void> {
    if (!this.#persistPath) return;
    try {
      if (!this.#persistFile) {
        this.#persistFile = await Deno.open(this.#persistPath, {
          write: true,
          append: true,
          create: true,
        });
      }
      await this.#persistFile.write(new TextEncoder().encode(line));
    } catch (e) {
      // One-shot warning — keep going, don't keep retrying.
      try {
        this.#debugWrite(`[rex] trace persist failed: ${(e as Error).message}`);
      } catch { /* */ }
    }
  }
}

/** Default debug sink: write a line to stderr synchronously. */
function defaultDebugWrite(line: string): void {
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(line + "\n"));
  } catch { /* */ }
}

function parseDebugEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/**
 * Format a trace event as a single grep-friendly line, e.g.
 *   `[rex   123ms #007 tool_call_finished] name=fetchIssues ok=true bytes=1284 ms=42`
 *
 * Exported so users building their own UI can reuse the formatter or
 * subscribe via onTrace and re-emit.
 */
export function formatTraceEvent(ev: TraceEvent): string {
  // deno-lint-ignore no-explicit-any
  const { ts, seq, type, ...rest } = ev as any;
  const tsStr = String(ts).padStart(5, " ");
  const seqStr = String(seq).padStart(3, "0");
  const fields = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(" ");
  return `[rex ${tsStr}ms #${seqStr} ${type}]${fields ? " " + fields : ""}`;
}

const FIELD_TRUNC = 120;

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    const trimmed = v.length > FIELD_TRUNC ? v.slice(0, FIELD_TRUNC - 1) + "…" : v;
    return /[\s"=]/.test(trimmed) ? JSON.stringify(trimmed) : trimmed;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const json = JSON.stringify(v);
    if (json === undefined) return String(v);
    return json.length > FIELD_TRUNC ? json.slice(0, FIELD_TRUNC - 1) + "…" : json;
  } catch {
    return String(v);
  }
}
