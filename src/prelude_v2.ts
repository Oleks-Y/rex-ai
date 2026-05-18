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
//   - The standard JS timer surface (`setTimeout`, `setInterval`,
//     `clearTimeout`, `clearInterval`) is wrapped to drive wakeups: each
//     scheduled timer registers a parent-side descriptor; each fire that
//     calls a control fn (reflect, or reply / abort which translate to
//     reflect) wakes the agent for another turn. Silent ticks (no
//     control fn) emit no wakeup turn unless the host enables
//     `experimental.autoWakeOnTimer`.
//
//   - `reflect(promise)` is honored at the terminal-dispatch site: a
//     thenable state is awaited (bounded by `reflectPromiseTimeoutMs`)
//     and the resolved value becomes the step's reflect state. A
//     parent-sent `cancel_step` frame interrupts the wait synthetically.
//
// The wire format additions are documented in src/types.ts.

import type { ToolDescription } from "./tools.ts";

// The prelude script written to disk inlines the translator helpers
// (see src/prelude_translator.ts). We read the source verbatim at
// host module load time and strip top-level `import` lines and the
// `export ` keyword so the names become subprocess-local. Doing this
// at module load (not at every PreludeV2.build call) keeps build cheap.
const TRANSLATOR_INLINE: string = (() => {
  const path = new URL("./prelude_translator.ts", import.meta.url);
  const raw = Deno.readTextFileSync(path);
  return raw
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line))
    .join("\n")
    .replace(/^export /gm, "");
})();

export interface BuildPreludeV2Input {
  tools: ToolDescription[];
  /** When true, every fire of a wrapped timer wakes the agent — even
   *  if the callback called no control fn. The callback's return value
   *  becomes the synthetic prior step's reflect state. Default false. */
  autoWakeOnTimer?: boolean;
  /** Wall-clock cap on a `reflect(promise)` await, in ms. Default
   *  matches `DEFAULT_SIZE_CAPS.reflectPromiseTimeoutMs` (5 min). */
  reflectPromiseTimeoutMs?: number;
}

function strLit(s: string): string {
  return JSON.stringify(s);
}

const PRELUDE_V2_HEADER = String.raw`// === rex-ai prelude v2 (auto-generated, persistent dispatcher) ===

import { AsyncLocalStorage } from "node:async_hooks";

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
// Extends ToolError so a single catch(e instanceof ToolError) in agent code
// handles validation failures AND oversize results. instanceof
// ToolResultTooLargeError still works when the caller wants to discriminate.
class ToolResultTooLargeError extends ToolError {
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
  // Snapshot once: we only block on writes that were already pending
  // when the drain began. Writes that arrive AFTER drain entry (e.g. a
  // setInterval tick mid-shutdown) keep flowing on their own — waiting
  // for them would let a fast interval starve the drain forever.
  const snapshot = Array.from(__pendingWrites);
  if (snapshot.length === 0) return;
  await Promise.allSettled(snapshot);
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
  // Same single-snapshot rule as __drainPendingWrites — see comment
  // there. With timer-driven wakeups, a periodic callback that issues
  // its own RPC calls (e.g. storage.set) could otherwise keep this
  // loop alive forever during step shutdown.
  const calls = Array.from(__pendingCalls);
  if (calls.length > 0) await Promise.allSettled(calls);
  await __drainPendingWrites();
}

// ---- Control values (synchronous constructors, recorded as fallback) ----
//
// reply / abort / reflect produce a tagged value AND record it as the
// step-level fallback (for code that calls without \`return\`).
//
// While a wrapped-timer callback is on the stack, recording is
// redirected to a per-callback intent slot instead of the step-level
// slot — see __callbackContext below. This is how the prelude enforces
// "only step-body code talks to the user" without banning reply/abort
// inside callbacks: they're translated to reflect with an \`intent\`
// payload that the next wakeup-driven turn can render.
// __REX_TAG, __ControlValue, __isControl, __payloadFromControl,
// __decideTimerPayload — all injected from src/prelude_translator.ts
// at PreludeV2.build time. See TRANSLATOR_INLINE in the host module.
let __recordedControl: __ControlValue | null = null;

interface __TimerCallbackFrame {
  entry: __TimerEntry;
  intent: __ControlValue | null;
}

// Per-callback frame storage. Bound to the callback's full async
// lifetime via AsyncLocalStorage, so reply / abort / reflect calls
// from inside the cb (sync or after any number of awaits) land in
// the *correct* frame even when multiple async timer callbacks are
// in flight concurrently. A naive shared stack would pop frames in
// the wrong order under overlapping fires.
const __callbackStorage = new AsyncLocalStorage<__TimerCallbackFrame>();

function __recordControl(v: __ControlValue): void {
  const frame = __callbackStorage.getStore();
  if (frame) {
    frame.intent = v;
  } else {
    __recordedControl = v;
  }
}

function reply(message: string): __ControlValue {
  const v: __ControlValue = { [__REX_TAG]: true, kind: "reply", message: String(message) };
  __recordControl(v);
  return v;
}
function abort(error: string): __ControlValue {
  const v: __ControlValue = { [__REX_TAG]: true, kind: "abort", error: String(error) };
  __recordControl(v);
  return v;
}
function reflect(state: unknown): __ControlValue {
  const v: __ControlValue = { [__REX_TAG]: true, kind: "reflect", state };
  __recordControl(v);
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

// ---- Timer interception ----
//
// The standard timer surface (\`setTimeout\`, \`setInterval\`,
// \`clearTimeout\`, \`clearInterval\`) is wrapped to:
//   1. Allocate a parent-side wakeupId per timer and emit
//      \`wakeup_scheduled\`.
//   2. Run the callback inside a __callbackContext frame so reply /
//      abort / reflect record into the frame's intent slot rather than
//      the step-level slot.
//   3. After the callback settles, decide whether to wake the agent
//      for another turn:
//        - any control fn called → wake (translated for reply/abort)
//        - else if __AUTO_WAKE_ON_TIMER → wake with return value as state
//        - else silent (no wakeup_resolved emitted; setInterval keeps firing)
//   4. Errors in callbacks emit \`wakeup_rejected\`.
//   5. \`clearTimeout\` / \`clearInterval\` emit \`wakeup_cancelled\` and
//      cancel the underlying native timer.
//
// IDs returned from set* are numeric (DOM contract). The numeric id is
// what \`clearTimeout\` / \`clearInterval\` accept and what
// \`tasks.cancel(id)\` accepts.

interface __TimerEntry {
  id: number;
  wakeupId: string;
  kind: "timeout" | "interval";
  delayMs: number;
  cb: (...a: unknown[]) => unknown;
  args: unknown[];
  // deno-lint-ignore no-explicit-any
  nativeId: any;
  status: "pending" | "cancelled";
}

const __timers = new Map<number, __TimerEntry>();
let __nextTimerId = 1;
let __nextWakeupId = 0;

const __AUTO_WAKE_ON_TIMER = __REX_AUTO_WAKE_ON_TIMER__;
const __REFLECT_PROMISE_TIMEOUT_MS = __REX_REFLECT_PROMISE_TIMEOUT_MS__;

// Snapshot the native timer fns BEFORE wrapping. Code inside the
// prelude itself (e.g. the reflect-promise timeout) uses these so it
// is not affected by the wrappers.
// deno-lint-ignore no-explicit-any
const __nativeSetTimeout: (cb: (...a: any[]) => unknown, ms?: number, ...args: any[]) => any =
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setTimeout.bind(globalThis);
// deno-lint-ignore no-explicit-any
const __nativeSetInterval: (cb: (...a: any[]) => unknown, ms?: number, ...args: any[]) => any =
  // deno-lint-ignore no-explicit-any
  (globalThis as any).setInterval.bind(globalThis);
// deno-lint-ignore no-explicit-any
const __nativeClearTimeout: (id: any) => void =
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearTimeout.bind(globalThis);
// deno-lint-ignore no-explicit-any
const __nativeClearInterval: (id: any) => void =
  // deno-lint-ignore no-explicit-any
  (globalThis as any).clearInterval.bind(globalThis);

// Decide what to emit for a timer callback whose effective control
// value is \`ctrl\`. If \`ctrl\` is \`reflect(<thenable>)\`, await the
// thenable through the same unwrap helper used by top-level reflect:
//   - emits its own \`wakeup_scheduled (promise)\` + matching terminal
//     frame for the inner promise so the parent's wakeup mirror sees
//     the unwrap lifecycle;
//   - returns the resolved value as the timer's payload state on
//     success, surfaces rejection as the timer's wakeup_rejected,
//     and reports interruption (timeout) as a synthetic state. */
async function __unwrapCallbackReflect(ctrl: __ControlValue):
  Promise<
    | { kind: "ok"; payload: { state?: unknown; intent?: { kind: "reply" | "abort"; text: string } } }
    | { kind: "rejected"; error: string }
  > {
  if (ctrl.kind !== "reflect" || !__isThenable(ctrl.state)) {
    return { kind: "ok", payload: __payloadFromControl(ctrl) };
  }
  // Same defensive .catch as the top-level path — the rejection-killer
  // can fire before \`__resolveReflectPromise\`'s race attaches handlers.
  Promise.resolve(ctrl.state).catch(() => {});
  const wakeupId = "p_" + (__nextWakeupId++);
  await __rpcWrite({
    type: "wakeup_scheduled", id: wakeupId, reason: "", wakeupKind: "promise",
  });
  const outcome = await __resolveReflectPromise(ctrl.state, wakeupId, { allowCancel: false });
  if (outcome.kind === "value") {
    await __rpcWrite({ type: "wakeup_resolved", id: wakeupId });
    return { kind: "ok", payload: { state: outcome.value } };
  }
  if (outcome.kind === "rejected") {
    const msg = outcome.error instanceof Error
      ? (outcome.error.message || String(outcome.error))
      : String(outcome.error);
    await __rpcWrite({ type: "wakeup_rejected", id: wakeupId, error: msg });
    return { kind: "rejected", error: msg };
  }
  // Interrupted (timeout). The cb-side wait isn't cancellable by the
  // parent (allowCancel:false), so this branch is reached only when
  // the per-promise cap fires. Surface as the cb's payload state.
  await __rpcWrite({ type: "wakeup_cancelled", id: wakeupId, reason: outcome.reason });
  return { kind: "ok", payload: { state: { __interrupted_by: outcome.reason } } };
}

function __runTimerFire(entry: __TimerEntry): void {
  // Bind the per-callback frame to the cb's full async lifetime via
  // AsyncLocalStorage. reply / abort / reflect calls from anywhere
  // inside the cb (sync or post-await) land in this frame's intent
  // slot — even when sibling callbacks are concurrently mid-await.
  const frame: __TimerCallbackFrame = { entry, intent: null };
  // Track this fire so __drainAllPending sees it during graceful shutdown.
  const fire = (async () => {
    let result: unknown = undefined;
    let err: unknown = __NONE;
    try {
      result = await __callbackStorage.run(
        frame,
        async () => await entry.cb.apply(undefined, entry.args),
      );
    } catch (e) {
      err = e;
    }
    const intent = frame.intent;
    if (entry.status === "cancelled") {
      if (entry.kind === "timeout") __timers.delete(entry.id);
      return;
    }
    if (err !== __NONE) {
      const msg = err instanceof Error ? (err.message || String(err)) : String(err);
      await __rpcWrite({ type: "wakeup_rejected", id: entry.wakeupId, error: msg });
      // setInterval keeps firing on cb error (matches DOM behavior); we
      // do not delete the entry. setTimeout is one-shot — drop entry.
      if (entry.kind === "timeout") __timers.delete(entry.id);
      return;
    }
    let payload:
      { state?: unknown; intent?: { kind: "reply" | "abort"; text: string } } | undefined;
    const decision = __decideTimerPayload(intent, result, __AUTO_WAKE_ON_TIMER);
    if (decision.effectiveCtrl) {
      const u = await __unwrapCallbackReflect(decision.effectiveCtrl);
      if (u.kind === "rejected") {
        await __rpcWrite({
          type: "wakeup_rejected", id: entry.wakeupId, error: u.error,
        });
        if (entry.kind === "timeout") __timers.delete(entry.id);
        return;
      }
      payload = u.payload;
    } else if (decision.autoWakePayload) {
      payload = decision.autoWakePayload;
    }
    if (entry.kind === "timeout") {
      // Always emit so the parent can transition the descriptor.
      const f: { type: string; id: string; payload?: unknown } = {
        type: "wakeup_resolved",
        id: entry.wakeupId,
      };
      if (payload) f.payload = payload;
      await __rpcWrite(f);
      __timers.delete(entry.id);
    } else {
      // Interval: only emit on payload-bearing ticks. Silent ticks do
      // not flood the parent or the agent inbox; the descriptor stays
      // pending until clearInterval.
      if (payload) {
        await __rpcWrite({ type: "wakeup_resolved", id: entry.wakeupId, payload });
      }
    }
  })();
  __trackWrite(fire).catch(() => {});
}

// deno-lint-ignore no-explicit-any
(globalThis as any).setTimeout = (
  cb: (...a: unknown[]) => unknown,
  ms?: number,
  ...args: unknown[]
): number => {
  if (typeof cb !== "function") {
    throw new TypeError("setTimeout: callback must be a function");
  }
  const id = __nextTimerId++;
  const wakeupId = "t_" + (__nextWakeupId++);
  const delayMs = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms))) : 0;
  const entry: __TimerEntry = {
    id, wakeupId, kind: "timeout", delayMs, cb, args, nativeId: 0, status: "pending",
  };
  entry.nativeId = __nativeSetTimeout(() => {
    if (entry.status === "cancelled") return;
    __runTimerFire(entry);
  }, delayMs);
  __timers.set(id, entry);
  __trackWrite(__rpcWrite({
    type: "wakeup_scheduled", id: wakeupId, reason: "", wakeupKind: "timeout", delayMs,
  })).catch(() => {});
  return id;
};

// deno-lint-ignore no-explicit-any
(globalThis as any).setInterval = (
  cb: (...a: unknown[]) => unknown,
  ms?: number,
  ...args: unknown[]
): number => {
  if (typeof cb !== "function") {
    throw new TypeError("setInterval: callback must be a function");
  }
  const id = __nextTimerId++;
  const wakeupId = "t_" + (__nextWakeupId++);
  const delayMs = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms))) : 0;
  const entry: __TimerEntry = {
    id, wakeupId, kind: "interval", delayMs, cb, args, nativeId: 0, status: "pending",
  };
  entry.nativeId = __nativeSetInterval(() => {
    if (entry.status === "cancelled") return;
    __runTimerFire(entry);
  }, delayMs);
  __timers.set(id, entry);
  __trackWrite(__rpcWrite({
    type: "wakeup_scheduled", id: wakeupId, reason: "", wakeupKind: "interval", delayMs,
  })).catch(() => {});
  return id;
};

function __cancelTimer(rawId: unknown): void {
  // DOM contract: clearTimeout / clearInterval accept either kind's id
  // and silently no-op for unknown ids.
  if (typeof rawId !== "number") return;
  const entry = __timers.get(rawId);
  if (!entry) return;
  if (entry.status === "cancelled") return;
  entry.status = "cancelled";
  if (entry.kind === "interval") {
    __nativeClearInterval(entry.nativeId);
  } else {
    __nativeClearTimeout(entry.nativeId);
  }
  __timers.delete(entry.id);
  __trackWrite(__rpcWrite({
    type: "wakeup_cancelled", id: entry.wakeupId, reason: "",
  })).catch(() => {});
}
// deno-lint-ignore no-explicit-any
(globalThis as any).clearTimeout = (id: unknown) => __cancelTimer(id);
// deno-lint-ignore no-explicit-any
(globalThis as any).clearInterval = (id: unknown) => __cancelTimer(id);

// ---- tasks (slim API) ----
//
// Lets the model inspect and cancel live timers without remembering
// numeric ids across steps. \`tasks.cancel\` routes through the same
// path as \`clearTimeout\` / \`clearInterval\`.
const tasks = {
  list(): { id: number; wakeupId: string; kind: "timeout" | "interval"; delayMs: number; status: string }[] {
    return Array.from(__timers.values()).map((t) => ({
      id: t.id,
      wakeupId: t.wakeupId,
      kind: t.kind,
      delayMs: t.delayMs,
      status: t.status,
    }));
  },
  cancel(id: number): boolean {
    const entry = __timers.get(id);
    if (!entry || entry.status !== "pending") return false;
    __cancelTimer(id);
    return true;
  },
};
// deno-lint-ignore no-explicit-any
(globalThis as any).tasks = tasks;
// deno-lint-ignore no-explicit-any
// \`__rex\` is the cross-step state hub. \`timers\` is the live wakeup
// registry; \`state\` is a generic Map<string, unknown> the runtime
// itself doesn't touch — useful for users / helpers that need a
// subprocess-scoped key/value store cheaper than \`storage\`.
(globalThis as any).__rex = { timers: __timers, state: new Map<string, unknown>() };

// ---- Sentinel + reflect(promise) cancel hook ----
const __NONE = Symbol("rex.none");
// Object container so TS flow analysis doesn't narrow the type to
// \`null\` after the initial assignment — the slot is mutated from
// inside a Promise constructor, which TS treats as a separate flow.
const __cancelHookSlot: { fn: ((reason: string) => void) | null } = { fn: null };
`;

const PRELUDE_V2_DISPATCHER = String.raw`
// ---- Per-step dispatcher ----
function __isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function";
}

async function __resolveReflectPromise(
  state: PromiseLike<unknown>,
  wakeupId: string,
  opts?: { allowCancel?: boolean },
): Promise<{ kind: "value"; value: unknown } | { kind: "interrupted"; reason: string } | { kind: "rejected"; error: unknown }> {
  // Cancel hook + timeout race. Whichever wins dictates the outcome.
  // The actual promise keeps running in the background — its
  // settlement is dropped on interrupt/timeout.
  //
  // \`allowCancel\` controls whether this wait participates in the
  // \`cancel_step\` parent→child interrupt. The top-level reflect path
  // sets it to true so a user message preempts the wait. Timer-callback
  // reflects (Issue 3) set it to false — they're not blocking a user
  // turn, and the cancel hook slot is a singleton (would race against
  // a concurrent top-level reflect).
  const allowCancel = opts?.allowCancel !== false;
  const INTERRUPTED = Symbol("rex.interrupted");
  const TIMED_OUT = Symbol("rex.timed_out");
  let cancelReason = "";
  let cancelP: Promise<typeof INTERRUPTED> | null = null;
  if (allowCancel) {
    cancelP = new Promise<typeof INTERRUPTED>((res) => {
      __cancelHookSlot.fn = (reason: string) => { cancelReason = reason; res(INTERRUPTED); };
    });
  }
  let timerHandle: unknown = null;
  const timeoutP = new Promise<typeof TIMED_OUT>((res) => {
    timerHandle = __nativeSetTimeout(() => res(TIMED_OUT), __REFLECT_PROMISE_TIMEOUT_MS);
  });
  try {
    const racers: Promise<unknown>[] = [
      Promise.resolve(state).then((v) => ({ tag: "value" as const, v })).catch((e) => ({ tag: "err" as const, e })),
      timeoutP,
    ];
    if (cancelP) racers.push(cancelP);
    const winner = await Promise.race(racers) as
      | { tag: "value"; v: unknown }
      | { tag: "err"; e: unknown }
      | typeof INTERRUPTED
      | typeof TIMED_OUT;
    if (winner === INTERRUPTED) {
      return { kind: "interrupted", reason: cancelReason || "interrupted" };
    }
    if (winner === TIMED_OUT) {
      return { kind: "interrupted", reason: "reflect promise wait exceeded " + __REFLECT_PROMISE_TIMEOUT_MS + "ms" };
    }
    if (winner.tag === "value") return { kind: "value", value: winner.v };
    return { kind: "rejected", error: winner.e };
  } finally {
    if (allowCancel) __cancelHookSlot.fn = null;
    if (timerHandle !== null) __nativeClearTimeout(timerHandle);
    void wakeupId; // referenced only for parent symmetry; no-op here
  }
}

async function __dispatchTerminal(ctrl: __ControlValue | null, fallbackErr: string): Promise<void> {
  if (!ctrl) {
    await __rpcWrite({ type: "abort", error: fallbackErr });
    return;
  }
  // \`reflect(promise)\` — await the thenable, bounded by the cap, before
  // sending the terminal frame. The resolved value becomes the state.
  if (ctrl.kind === "reflect" && __isThenable(ctrl.state)) {
    // Pre-emptively attach a swallowing handler so Deno's unhandled-
    // rejection killer doesn't fire if the promise has ALREADY rejected
    // by the time we reach __resolveReflectPromise's Promise.race
    // (which only attaches its own handler after at least one
    // microtask has rolled).
    Promise.resolve(ctrl.state).catch(() => {});
    const wakeupId = "p_" + (__nextWakeupId++);
    await __rpcWrite({
      type: "wakeup_scheduled", id: wakeupId, reason: "", wakeupKind: "promise",
    });
    const outcome = await __resolveReflectPromise(ctrl.state, wakeupId);
    if (outcome.kind === "value") {
      await __rpcWrite({ type: "wakeup_resolved", id: wakeupId });
      await __rpcWrite({ type: "reflect", state: outcome.value });
      return;
    }
    if (outcome.kind === "rejected") {
      const msg = outcome.error instanceof Error
        ? (outcome.error.message || String(outcome.error))
        : String(outcome.error);
      await __rpcWrite({ type: "wakeup_rejected", id: wakeupId, error: msg });
      await __rpcWrite({ type: "throw", error: msg });
      return;
    }
    // Interrupted by the parent (cancel_step) or by timeout.
    await __rpcWrite({ type: "wakeup_cancelled", id: wakeupId, reason: outcome.reason });
    await __rpcWrite({
      type: "reflect",
      state: { __interrupted_by: outcome.reason },
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

async function __runStep(stepPath: string): Promise<void> {
  // Reset the per-step recorded control fallback. Cross-step state on
  // \`globalThis.__rex\` and storage persists. Live timers also persist
  // across steps — that's the whole point.
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
    if (frame.type === "cancel_step") {
      // Currently used only to interrupt an in-flight reflect-promise
      // wait. If no wait is active, ignore.
      const hook = __cancelHookSlot.fn;
      if (hook) hook(String(frame.reason ?? "cancelled"));
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

function substituteConfig(src: string, input: BuildPreludeV2Input): string {
  const autoWake = input.autoWakeOnTimer === true ? "true" : "false";
  const timeoutMs = Math.max(1, Math.floor(Number(input.reflectPromiseTimeoutMs ?? 5 * 60_000)));
  return src
    .replaceAll("__REX_AUTO_WAKE_ON_TIMER__", autoWake)
    .replaceAll("__REX_REFLECT_PROMISE_TIMEOUT_MS__", String(timeoutMs));
}

export const PreludeV2 = {
  /**
   * Build the long-lived sandbox entry point. Includes the dispatcher,
   * control fns, RPC plumbing, tool stubs, timer wrappers, and
   * `globalThis.__rex`. The per-step LLM body lives in a separate
   * `__step_N.ts` file the dispatcher dynamic-imports on demand.
   */
  build(input: BuildPreludeV2Input): string {
    const stubs = buildToolStubs(input.tools);
    return substituteConfig(
      PRELUDE_V2_HEADER + TRANSLATOR_INLINE + stubs + PRELUDE_V2_DISPATCHER,
      input,
    );
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
