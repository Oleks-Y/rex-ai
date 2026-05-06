// Prelude builder — assembles the .ts file we hand to `deno run`.
//
// The prelude lives inside the sandbox. It must be self-contained (no
// imports from the agent library, since the sandbox runs with --no-remote
// and only the user's allowlisted modules in the import map). All RPC
// framing logic is inlined.
//
// Structure:
//   1. RPC framing (inline, mirrors src/rpc.ts wire format)
//   2. Control fns: reply / abort / reflect (synchronous value constructors)
//   3. writeLib + storage stubs
//   4. ToolError class + one stub per registered tool
//   5. console.* override → log events
//   6. async IIFE wrapping the LLM body; captures the IIFE's return value
//   7. After the body resolves: drain in-flight tool calls + log writes,
//      then dispatch the terminal frame (returned value, or the last call
//      to a control fn as fallback). Synthesize abort if neither happened.
//   8. catch block: PermissionDenied → permission_denied event;
//      anything else → throw event

import type { ToolDescription } from "./tools.ts";

export interface BuildPreludeInput {
  /** The TS code the LLM produced. Inserted verbatim inside an async IIFE. */
  llmCode: string;
  /** Tool descriptions, used to emit one stub per tool. */
  tools: ToolDescription[];
}

/** Identifier-validated tool name → JSON-safe string literal for embedding. */
function strLit(s: string): string {
  return JSON.stringify(s);
}

const PRELUDE_HEADER = String.raw`// === rex-ai prelude (auto-generated) ===
// Self-contained RPC + control surface for code-action sandbox.

const __ENC = new TextEncoder();
const __DEC = new TextDecoder("utf-8", { fatal: true });

class ToolError extends Error {
  issues: unknown;
  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = "ToolError";
    this.issues = issues;
  }
}
class WriteLibError extends Error {
  constructor(message: string) { super(message); this.name = "WriteLibError"; }
}
class ToolResultTooLargeError extends Error {
  constructor(message: string) { super(message); this.name = "ToolResultTooLargeError"; }
}

// ---- RPC framing (length\n + JSON, inlined to avoid imports) ----
let __rpcBuf = new Uint8Array(0);
const __rpcReader = Deno.stdin.readable.getReader();

async function __rpcPull(): Promise<boolean> {
  const r = await __rpcReader.read();
  if (r.done) return false;
  if (!r.value || r.value.length === 0) return true;
  if (__rpcBuf.length === 0) { __rpcBuf = r.value; return true; }
  const merged = new Uint8Array(__rpcBuf.length + r.value.length);
  merged.set(__rpcBuf, 0); merged.set(r.value, __rpcBuf.length);
  __rpcBuf = merged;
  return true;
}

async function __rpcRead(): Promise<unknown> {
  while (true) {
    const nl = __rpcBuf.indexOf(0x0a);
    if (nl === -1) {
      if (!(await __rpcPull())) throw new Error("RPC: unexpected EOF reading header");
      continue;
    }
    const headerStr = __DEC.decode(__rpcBuf.subarray(0, nl));
    if (!/^[0-9]+$/.test(headerStr)) throw new Error("RPC: invalid frame length");
    const len = Number(headerStr);
    const total = nl + 1 + len;
    while (__rpcBuf.length < total) {
      if (!(await __rpcPull())) throw new Error("RPC: unexpected EOF reading body");
    }
    const body = __rpcBuf.subarray(nl + 1, total);
    __rpcBuf = __rpcBuf.subarray(total);
    return JSON.parse(__DEC.decode(body));
  }
}

async function __rpcWrite(value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("RPC: value not serializable");
  const body = __ENC.encode(json);
  const header = __ENC.encode(body.length + "\n");
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0); out.set(body, header.length);
  // Deno.stdout.write loops internally for partial writes.
  let written = 0;
  while (written < out.length) {
    written += await Deno.stdout.write(out.subarray(written));
  }
}

// Track in-flight fire-and-forget writes (e.g. console.log) so the trailer
// can drain them before the terminal frame fires.
const __pendingWrites = new Set<Promise<unknown>>();
function __trackWrite<T>(p: Promise<T>): Promise<T> {
  __pendingWrites.add(p);
  p.finally(() => __pendingWrites.delete(p));
  return p;
}
async function __drainPendingWrites(): Promise<void> {
  while (__pendingWrites.size > 0) {
    await Promise.allSettled(Array.from(__pendingWrites));
  }
}

// ---- Pending RPC requests (id → resolver, plus the promise itself) ----
let __nextRpcId = 0;
const __pendingResolvers = new Map<string, (frame: any) => void>();
const __pendingCalls = new Set<Promise<unknown>>();
let __readerRunning = false;

async function __startReaderIfNeeded(): Promise<void> {
  if (__readerRunning) return;
  __readerRunning = true;
  // Background loop: only consumes responses for outstanding requests.
  // Terminal frames are sent and immediately followed by Deno.exit, so we
  // never need to read past them.
  (async () => {
    try {
      while (__pendingResolvers.size > 0) {
        const frame = await __rpcRead() as any;
        const id = frame?.id;
        if (typeof id !== "string") continue; // ignore unsolicited
        const cb = __pendingResolvers.get(id);
        if (cb) { __pendingResolvers.delete(id); cb(frame); }
      }
    } catch { /* if we lose the channel mid-call, the awaiter will hang
                  until the parent kills us — acceptable for MVP */ }
    __readerRunning = false;
  })();
}

async function __rpcCall(type: string, payload: Record<string, unknown>): Promise<any> {
  const id = "r" + (__nextRpcId++);
  const promise = new Promise<any>((resolve) => {
    __pendingResolvers.set(id, resolve);
  });
  __pendingCalls.add(promise);
  promise.finally(() => __pendingCalls.delete(promise));
  await __rpcWrite({ type, id, ...payload });
  __startReaderIfNeeded();
  return promise;
}

/** Wait for in-flight RPC calls (tool/storage/writeLib) to settle, then
 *  flush any fire-and-forget writes. New calls that fire DURING the drain
 *  (e.g. a then-handler triggers another tool call) are also awaited. */
async function __drainAllPending(): Promise<void> {
  while (__pendingCalls.size > 0) {
    await Promise.allSettled(Array.from(__pendingCalls));
  }
  await __drainPendingWrites();
}

// ---- Control functions (synchronous value constructors) ----
//
// Contract: the LLM body must "return reply(...)" / "return abort(...)" /
// "return reflect(...)" from its top-level scope. As a safety net, calling
// any of these *without* returning still records the intent — the trailer
// uses the most-recent call as fallback. The returned value (if any) wins.
//
// These are NOT async and do NOT exit the process. They produce a tagged
// JS object the trailer dispatches after draining in-flight RPC.

const __REX_TAG = Symbol.for("rex.control");
type __ControlValue =
  | { [__REX_TAG]: true; kind: "reply"; message: string }
  | { [__REX_TAG]: true; kind: "abort"; error: string }
  | { [__REX_TAG]: true; kind: "reflect"; state: unknown };

let __recordedControl: __ControlValue | null = null;
function __isControl(v: unknown): v is __ControlValue {
  return !!v && typeof v === "object" && (v as any)[__REX_TAG] === true;
}

function reply(message: string): __ControlValue {
  const v: __ControlValue = { [__REX_TAG]: true, kind: "reply", message: String(message) };
  __recordedControl = v;
  return v;
}
function abort(error: string): __ControlValue {
  const v: __ControlValue = { [__REX_TAG]: true, kind: "abort", error: String(error) };
  __recordedControl = v;
  return v;
}
function reflect(state: unknown): __ControlValue {
  const v: __ControlValue = { [__REX_TAG]: true, kind: "reflect", state };
  __recordedControl = v;
  return v;
}

// Also expose on globalThis so a defensive globalThis.reply(...) lookup
// (which some models reach for) still works.
// deno-lint-ignore no-explicit-any
(globalThis as any).reply = reply;
// deno-lint-ignore no-explicit-any
(globalThis as any).abort = abort;
// deno-lint-ignore no-explicit-any
(globalThis as any).reflect = reflect;

// ---- writeLib + storage ----
async function writeLib(source: string): Promise<void> {
  const r = await __rpcCall("write_lib", { source: String(source) });
  if (!r.ok) throw new WriteLibError(r.error ?? "writeLib failed");
}
const storage = {
  async get(key: string): Promise<unknown> {
    const r = await __rpcCall("storage_get", { key });
    if (!r.ok) throw new Error(r.error ?? "storage.get failed");
    return r.value;
  },
  async set(key: string, value: unknown): Promise<void> {
    const r = await __rpcCall("storage_set", { key, value });
    if (!r.ok) throw new Error(r.error ?? "storage.set failed");
  },
  async del(key: string): Promise<void> {
    const r = await __rpcCall("storage_del", { key });
    if (!r.ok) throw new Error(r.error ?? "storage.del failed");
  },
  async keys(): Promise<string[]> {
    const r = await __rpcCall("storage_keys", {});
    if (!r.ok) throw new Error(r.error ?? "storage.keys failed");
    return r.value as string[];
  },
};

// ---- console redirect (no real stdout/stderr — would corrupt RPC frames) ----
const __consoleEvent = (level: string) => (...args: unknown[]) => {
  // Best-effort serialize — anything not JSON-safe becomes its String() form.
  const safe = args.map((a) => {
    try { JSON.parse(JSON.stringify(a)); return a; }
    catch { return String(a); }
  });
  // Fire-and-forget; we don't await so console.log inside hot loops doesn't
  // serialize the whole step. Tracked via __pendingWrites so the trailer
  // drains them before exit.
  __trackWrite(__rpcWrite({ type: "log", level, args: safe })).catch(() => {});
};
for (const lvl of ["log","info","warn","error","debug"] as const) {
  // deno-lint-ignore no-explicit-any
  (console as any)[lvl] = __consoleEvent(lvl);
}

// ---- PermissionDenied classification ----
function __classifyPermErr(e: Error): { permission: string; target: string } {
  // Deno's PermissionDenied messages typically look like:
  //   "Requires net access to "host:port", run again with the --allow-net flag"
  //   "Requires read access to "/path", run again with the --allow-read flag"
  const msg = e.message;
  const m = /Requires (\w+) access to "?([^",]+)"?/.exec(msg);
  if (m) return { permission: m[1], target: m[2] };
  return { permission: "unknown", target: msg };
}
`;

const PRELUDE_TRAILER_TEMPLATE = String.raw`
// ---- LLM body wrapper ----
async function __dispatch(ctrl: __ControlValue | null): Promise<void> {
  if (!ctrl) {
    await __rpcWrite({
      type: "abort",
      error:
        "agent code finished without calling or returning reply(), abort(), or reflect()",
    });
    return;
  }
  switch (ctrl.kind) {
    case "reply":
      await __rpcWrite({ type: "reply", message: ctrl.message });
      return;
    case "abort":
      await __rpcWrite({ type: "abort", error: ctrl.error });
      return;
    case "reflect":
      await __rpcWrite({ type: "reflect", state: ctrl.state });
      return;
  }
}

try {
  // The LLM body runs inside this async IIFE. Its return value (if any)
  // becomes the terminal frame.
  const __returned = await (async () => {
    /*<<<LLM_CODE>>>*/
  })();
  // Drain in-flight tool/storage/writeLib calls and any fire-and-forget log
  // writes BEFORE the terminal frame fires. This prevents fire-and-forget
  // tool calls (e.g. sendEmail without await) from being orphaned by exit.
  await __drainAllPending();
  // Prefer the value the body returned; fall back to the last call to a
  // control fn so the older "await reply(...)" style still works.
  const ctrl = __isControl(__returned) ? __returned : __recordedControl;
  await __dispatch(ctrl);
  await __drainPendingWrites();
  Deno.exit(0);
} catch (e) {
  // Deno 2 uses Deno.errors.NotCapable; Deno 1 used PermissionDenied.
  // Check both so we work across runtime versions.
  // deno-lint-ignore no-explicit-any
  const NotCapable = (Deno.errors as any).NotCapable;
  const isPermErr = (NotCapable && e instanceof NotCapable) ||
    (Deno.errors.PermissionDenied && e instanceof Deno.errors.PermissionDenied);
  if (isPermErr) {
    const c = __classifyPermErr(e as Error);
    await __rpcWrite({ type: "permission_denied", permission: c.permission, target: c.target });
  } else {
    const msg = e instanceof Error ? (e.stack ?? String(e)) : String(e);
    await __rpcWrite({ type: "throw", error: msg });
  }
  await __drainPendingWrites();
  Deno.exit(0);
}
`;

/** Generate one tool stub per registered tool. */
function buildToolStubs(tools: ToolDescription[]): string {
  if (tools.length === 0) return "// (no tools registered)\n";
  const out: string[] = ["// ---- tool stubs ----"];
  for (const t of tools) {
    const name = t.name;
    out.push(
      String.raw`async function ${name}(args: unknown): Promise<unknown> {
  const r = await __rpcCall("tool_call", { name: ${strLit(name)}, args });
  if (!r.ok) {
    const err = new ToolError(r.error ?? "tool call failed", r.issues);
    if (typeof r.error === "string" && r.error.startsWith("ToolResultTooLargeError")) {
      throw new ToolResultTooLargeError(r.error);
    }
    throw err;
  }
  return r.value;
}`,
    );
  }
  return out.join("\n") + "\n";
}

export const Prelude = {
  /**
   * Build the complete sandbox script. Returns a string containing valid TS.
   *
   * The LLM body is interpolated literally — any syntax error in it surfaces
   * as a Deno parse failure, which the parent sees as exit-without-frame and
   * categorizes as `throw`.
   */
  build(input: BuildPreludeInput): string {
    const stubs = buildToolStubs(input.tools);
    // Replace the placeholder comment with the LLM body. We do *not*
    // sanitize the LLM body — it's just text we paste into a TS file. If
    // it has syntax errors, Deno's parser will reject it.
    const trailer = PRELUDE_TRAILER_TEMPLATE.replace(
      "/*<<<LLM_CODE>>>*/",
      input.llmCode,
    );
    return PRELUDE_HEADER + stubs + trailer;
  },
};
