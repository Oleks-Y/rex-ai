// Prelude v2 — persistent-sandbox dispatcher.
//
// Differences from src/prelude.ts:
//
//   - The script is the entry point of a long-lived Deno subprocess. It
//     does not exit after one step; it loops on a dispatcher reading
//     `exec` frames from stdin. Each frame names a per-step `.ts` file
//     to dynamic-import; the default export is awaited and its
//     control-value (or recorded fallback) becomes the step's terminal
//     frame.
//
//   - Tool stubs, control fns (reply / abort / reflect), storage,
//     writeLib, console redirect — all installed once at startup as
//     globals. Same names, same shapes as v1. The LLM body in each
//     step module sees them as ambient globals.
//
//   - `globalThis.__rex` is initialized as the cross-step state hub.
//     For step 2 it only holds an empty `tasks` Map; later steps will
//     populate it from `scheduleWakeup`.
//
// The wire format and frame types are otherwise identical to v1, so the
// parent-side handlers (tool_call / storage_* / write_lib / log) can be
// reused unchanged.

import type { ToolDescription } from "./tools.ts";

export interface BuildPreludeV2Input {
  tools: ToolDescription[];
}

function strLit(s: string): string {
  return JSON.stringify(s);
}

const PRELUDE_V2_HEADER = String.raw`// === rex-ai prelude v2 (auto-generated, persistent dispatcher) ===

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

// ---- RPC framing (length\n + JSON, inlined) ----
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

// Serialize stdout writes through a chain so concurrent __rpcWrite
// callers (e.g. console.log fire-and-forget plus a wakeup_resolved
// from a settled promise) can't interleave bytes via partial writes.
let __stdoutChain: Promise<void> = Promise.resolve();

async function __rpcWrite(value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("RPC: value not serializable");
  const body = __ENC.encode(json);
  const header = __ENC.encode(body.length + "\n");
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0); out.set(body, header.length);
  const next = __stdoutChain.then(async () => {
    let written = 0;
    while (written < out.length) {
      written += await Deno.stdout.write(out.subarray(written));
    }
  });
  __stdoutChain = next.catch(() => {});
  return next;
}

const __pendingWrites = new Set<Promise<unknown>>();
function __trackWrite<T>(p: Promise<T>): Promise<T> {
  __pendingWrites.add(p);
  // The .finally chain returns a new promise; without observing its
  // rejection, a failed inner promise becomes an unhandled rejection
  // even when the outer caller has its own .catch handler on it.
  p.finally(() => __pendingWrites.delete(p)).catch(() => {});
  return p;
}
async function __drainPendingWrites(): Promise<void> {
  while (__pendingWrites.size > 0) {
    await Promise.allSettled(Array.from(__pendingWrites));
  }
}

// ---- Pending RPC requests (id → resolver) ----
//
// In v2 the dispatcher holds the stdin reader for its lifetime — there
// is no "start a reader on first call" race. Tool/storage/writeLib
// responses are routed by the dispatcher via __pendingResolvers as
// frames flow in.
let __nextRpcId = 0;
const __pendingResolvers = new Map<string, (frame: any) => void>();
const __pendingCalls = new Set<Promise<unknown>>();

async function __rpcCall(type: string, payload: Record<string, unknown>): Promise<any> {
  const id = "r" + (__nextRpcId++);
  const promise = new Promise<any>((resolve) => {
    __pendingResolvers.set(id, resolve);
  });
  __pendingCalls.add(promise);
  promise.finally(() => __pendingCalls.delete(promise));
  await __rpcWrite({ type, id, ...payload });
  return promise;
}

async function __drainAllPending(): Promise<void> {
  while (__pendingCalls.size > 0) {
    await Promise.allSettled(Array.from(__pendingCalls));
  }
  await __drainPendingWrites();
}

// ---- Control values (synchronous constructors, recorded as fallback) ----
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
// deno-lint-ignore no-explicit-any
(globalThis as any).writeLib = writeLib;
// deno-lint-ignore no-explicit-any
(globalThis as any).storage = storage;

// ---- console redirect ----
const __consoleEvent = (level: string) => (...args: unknown[]) => {
  const safe = args.map((a) => {
    try { JSON.parse(JSON.stringify(a)); return a; }
    catch { return String(a); }
  });
  __trackWrite(__rpcWrite({ type: "log", level, args: safe })).catch(() => {});
};
for (const lvl of ["log","info","warn","error","debug"] as const) {
  // deno-lint-ignore no-explicit-any
  (console as any)[lvl] = __consoleEvent(lvl);
}

// ---- PermissionDenied classification ----
function __classifyPermErr(e: Error): { permission: string; target: string } {
  const msg = e.message;
  const m = /Requires (\w+) access to "?([^",]+)"?/.exec(msg);
  if (m) return { permission: m[1], target: m[2] };
  return { permission: "unknown", target: msg };
}

// ---- Cross-step state hub + scheduleWakeup / tasks API ----
//
// \`globalThis.__rex.tasks\` is the task registry. Each entry is a
// \`TaskHandle\` whose \`done\` promise lives in this long-lived
// subprocess. The handle survives across steps, so a step can call
// \`tasks.get(id).done\` in step N+K and \`await\` the promise that was
// kicked off in step N. \`globalThis.__rex.signals\` is reserved for
// step 5.

type __TaskStatus = "pending" | "resolved" | "rejected" | "cancelled";

interface __TaskHandle<T = unknown> {
  id: string;
  status: __TaskStatus;
  reason: string;
  wakeupKind: "delay" | "thunk" | "signal";
  done: Promise<T>;
  value?: T;
  error?: unknown;
  cancel(reason?: string): void;
}

const __taskRegistry = new Map<string, __TaskHandle>();
let __nextWakeupId = 0;

interface __WakeupOptions {
  reason?: string;
}

class __WakeupCancelled extends Error {
  constructor(reason: string) {
    super("wakeup cancelled" + (reason ? ": " + reason : ""));
    this.name = "WakeupCancelled";
  }
}

function __scheduleWakeupCore<T>(
  thunk: () => Promise<T> | T,
  wakeupKind: "delay" | "thunk",
  options: __WakeupOptions,
): __TaskHandle<T> {
  const id = "w" + (__nextWakeupId++);
  const reason = String(options.reason ?? "");

  let resolveDone!: (v: T) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<T>((res, rej) => { resolveDone = res; rejectDone = rej; });

  const handle: __TaskHandle<T> = {
    id,
    status: "pending",
    reason,
    wakeupKind,
    done,
    cancel(cancelReason?: string) {
      if (handle.status !== "pending") return;
      handle.status = "cancelled";
      const r = String(cancelReason ?? "");
      const err = new __WakeupCancelled(r);
      handle.error = err;
      rejectDone(err);
      // Suppress unhandled rejection if no one ever awaits done.
      done.catch(() => {});
      __trackWrite(__rpcWrite({ type: "wakeup_cancelled", id, reason: r })).catch(() => {});
    },
  };

  __taskRegistry.set(id, handle as __TaskHandle);

  // Notify parent BEFORE running the thunk so a fast-resolving promise
  // can't beat the scheduled-event to the parent.
  __trackWrite(__rpcWrite({
    type: "wakeup_scheduled",
    id,
    reason,
    wakeupKind,
  })).catch(() => {});

  // Suppress unhandled rejection; we route via the handle.
  done.catch(() => {});

  // Kick off the thunk on a microtask so registry insertion completes
  // first (and a synchronous thunk doesn't fire wakeup_resolved before
  // the dispatcher sees wakeup_scheduled).
  Promise.resolve()
    .then(() => thunk())
    .then((value: T) => {
      if (handle.status !== "pending") return; // cancelled — drop
      handle.status = "resolved";
      handle.value = value;
      resolveDone(value);
      __trackWrite(__rpcWrite({ type: "wakeup_resolved", id })).catch(() => {});
    })
    .catch((err) => {
      if (handle.status !== "pending") return;
      handle.status = "rejected";
      handle.error = err;
      rejectDone(err);
      const message = err instanceof Error ? (err.message || String(err)) : String(err);
      __trackWrite(__rpcWrite({ type: "wakeup_rejected", id, error: message })).catch(() => {});
    });

  return handle;
}

interface __ScheduleWakeupFn {
  <T>(thunk: () => Promise<T> | T, options?: __WakeupOptions): __TaskHandle<T>;
  delay(ms: number, options?: __WakeupOptions): __TaskHandle<void>;
  signal(name: string, options?: __WakeupOptions): __TaskHandle<unknown>;
}

const scheduleWakeup: __ScheduleWakeupFn = (<T>(
  thunk: () => Promise<T> | T,
  options: __WakeupOptions = {},
): __TaskHandle<T> => __scheduleWakeupCore<T>(thunk, "thunk", options)) as __ScheduleWakeupFn;

scheduleWakeup.delay = (ms: number, options: __WakeupOptions = {}): __TaskHandle<void> => {
  const safeMs = Math.max(0, Math.floor(Number(ms)));
  return __scheduleWakeupCore<void>(
    () => new Promise<void>((resolve) => setTimeout(resolve, safeMs)),
    "delay",
    options,
  );
};

scheduleWakeup.signal = (_name: string, _options: __WakeupOptions = {}): __TaskHandle<unknown> => {
  // Reserved for step 5.
  throw new Error("scheduleWakeup.signal is not implemented yet");
};

const tasks = {
  list(): __TaskHandle[] {
    return Array.from(__taskRegistry.values());
  },
  pending(): __TaskHandle[] {
    const out: __TaskHandle[] = [];
    for (const t of __taskRegistry.values()) {
      if (t.status === "pending") out.push(t);
    }
    return out;
  },
  get(id: string): __TaskHandle | null {
    return __taskRegistry.get(id) ?? null;
  },
  cancel(id: string, reason?: string): boolean {
    const t = __taskRegistry.get(id);
    if (!t) return false;
    if (t.status !== "pending") return false;
    t.cancel(reason);
    return true;
  },
};

// deno-lint-ignore no-explicit-any
(globalThis as any).scheduleWakeup = scheduleWakeup;
// deno-lint-ignore no-explicit-any
(globalThis as any).tasks = tasks;
// deno-lint-ignore no-explicit-any
(globalThis as any).__rex = {
  tasks: __taskRegistry,
  signals: new Map<string, unknown>(),
};
`;

const PRELUDE_V2_DISPATCHER = String.raw`
// ---- Per-step dispatcher ----
async function __dispatchTerminal(ctrl: __ControlValue | null, fallbackErr: string): Promise<void> {
  if (!ctrl) {
    await __rpcWrite({ type: "abort", error: fallbackErr });
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

async function __runStep(stepPath: string): Promise<void> {
  // Reset the per-step recorded control fallback. Cross-step state on
  // \`globalThis.__rex\` and storage persists.
  __recordedControl = null;

  try {
    const url = "file://" + stepPath;
    const mod = await import(url);
    const fn = mod && mod.default;
    if (typeof fn !== "function") {
      await __drainAllPending();
      await __rpcWrite({
        type: "abort",
        error: "step module did not export a default async function",
      });
      await __drainPendingWrites();
      return;
    }
    const __returned = await fn();
    await __drainAllPending();
    const ctrl = __isControl(__returned) ? __returned : __recordedControl;
    await __dispatchTerminal(
      ctrl,
      "agent code finished without calling or returning reply(), abort(), or reflect()",
    );
    await __drainPendingWrites();
  } catch (e) {
    await __drainAllPending();
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
  }
}

// ---- Main loop ----
//
// The loop drains frames from stdin and routes them. Critically, it
// runs \`__runStep\` *concurrently* (without awaiting), because the step
// itself issues RPC calls (tool_call, storage_*, write_lib) whose
// responses arrive on the same stdin pipe — awaiting __runStep here
// would deadlock the step against its own RPC responses. The parent
// serializes \`exec\` frames (it never sends a second one until the
// previous step's terminal frame is observed), so concurrent steps
// can't be in flight at the same time.
let __activeStep: Promise<void> = Promise.resolve();

(async () => {
  while (true) {
    let frame: any;
    try {
      frame = await __rpcRead();
    } catch {
      // Pipe closed by parent — drain anything in flight, then exit.
      try { await __activeStep; } catch { /* */ }
      Deno.exit(0);
    }
    if (!frame || typeof frame !== "object") continue;
    if (frame.type === "shutdown") {
      try { await __activeStep; } catch { /* */ }
      Deno.exit(0);
    }
    if (frame.type === "exec" && typeof frame.path === "string") {
      // Fire and track. Errors inside __runStep are caught by its own
      // try/catch and surfaced as a terminal frame; we still .catch()
      // here defensively so an unexpected throw can't unhandled-reject.
      __activeStep = __runStep(frame.path).catch(() => {});
      continue;
    }
    // Response to an outstanding RPC call.
    if (typeof frame.id === "string") {
      const cb = __pendingResolvers.get(frame.id);
      if (cb) {
        __pendingResolvers.delete(frame.id);
        cb(frame);
      }
      continue;
    }
    // Unknown frame — ignore.
  }
})();
`;

function buildToolStubs(tools: ToolDescription[]): string {
  if (tools.length === 0) return "// (no tools registered)\n";
  const out: string[] = ["// ---- tool stubs (installed as globals) ----"];
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
}
// deno-lint-ignore no-explicit-any
(globalThis as any).${name} = ${name};`,
    );
  }
  return out.join("\n") + "\n";
}

export const PreludeV2 = {
  /**
   * Build the long-lived sandbox entry point. Includes the dispatcher,
   * control fns, RPC plumbing, tool stubs, and `globalThis.__rex`. The
   * per-step LLM body lives in a separate `__step_N.ts` file the
   * dispatcher dynamic-imports on demand.
   */
  build(input: BuildPreludeV2Input): string {
    const stubs = buildToolStubs(input.tools);
    return PRELUDE_V2_HEADER + stubs + PRELUDE_V2_DISPATCHER;
  },

  /** Build the per-step module the dispatcher will dynamic-import. The
   *  LLM body becomes the function body of the default export. */
  buildStepModule(llmCode: string): string {
    return `// auto-generated per-step module
export default async function __step() {
${llmCode}
}
`;
  },
};
