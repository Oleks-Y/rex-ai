// PersistentSandbox — one Deno subprocess per agent session.
//
// Behind `experimental.asyncWakeups`. Mirrors Sandbox.run's per-step
// contract (one SandboxEvent out per step) but holds the subprocess
// open across steps. The subprocess uses prelude_v2's dispatcher loop:
// each call to `runStep` writes a fresh `__step_N.ts` to the session
// dir, sends an `exec` frame, and waits for the next terminal frame.
//
// Permissions, import map, and tool stubs are fixed at session spawn —
// they cannot change between steps in this mode (per the
// async-wakeup-mode plan). Step source is module-guarded per step at
// the parent before the exec frame is sent.
//
// The prelude exposes wrapped `setTimeout` / `setInterval` /
// `clearTimeout` / `clearInterval` plus a slim `tasks` API; this file
// relays the resulting wakeup_* frames through `WakeupHandlers` and
// keeps a parent-side `WakeupDescriptor` mirror with periodic GC. A
// step that exceeds the wall-clock cap SIGKILLs the subprocess and
// marks the sandbox closed, so subsequent runStep calls short-circuit.

import { join } from "@std/path";
import { encodeFrame, FrameReader, RpcFramingError } from "./rpc.ts";
import { ModuleGuard } from "./module_guard.ts";
import { PermissionCompiler } from "./permissions.ts";
import { PreludeV2 } from "./prelude_v2.ts";
import { SessionStore } from "./session.ts";
import { ToolRegistry } from "./tools.ts";
import {
  type ChildFrame,
  type PermissionKind,
  type PermissionsConfig,
  type SandboxEvent,
  type SandboxLog,
  type SizeCaps,
  type WakeupKind,
  type WakeupResolvedPayload,
} from "./types.ts";

const enc = new TextEncoder();

const PERMISSION_KINDS = new Set<PermissionKind>([
  "net",
  "read",
  "write",
  "run",
  "env",
  "ffi",
  "sys",
]);

function classifyPermission(raw: string): PermissionKind {
  return PERMISSION_KINDS.has(raw as PermissionKind) ? (raw as PermissionKind) : "read";
}

/** Parent-side mirror of one scheduled wakeup. Survives sandbox-level
 *  events (e.g. tier-3 restart, step 7) — the actual JS timer / promise
 *  lives in the subprocess and dies with it, but the descriptor here
 *  lets the host surface scheduled tasks in event streams.
 *
 *  For `wakeupKind === "interval"`, the descriptor stays in `pending`
 *  status across fires — each tick that surfaces a payload updates
 *  `lastPayload`, but only `clearInterval` (→ `wakeup_cancelled`)
 *  transitions to a terminal status. */
export interface WakeupDescriptor {
  id: string;
  reason: string;
  wakeupKind: WakeupKind;
  status: "pending" | "resolved" | "rejected" | "cancelled";
  /** Wall-clock ms when the wakeup was registered (parent-side). */
  scheduledAt: number;
  /** Set on terminal transition. For intervals: only on cancellation. */
  resolvedAt?: number;
  error?: string;
  cancelReason?: string;
  /** Most recent payload from a `wakeup_resolved` for this id. For
   *  intervals this overwrites on each tick; for timeouts/promises it
   *  is the (single) payload. Absent for silent ticks. */
  lastPayload?: WakeupResolvedPayload;
  /** Configured delay (ms) at registration time, mirrored from the
   *  `wakeup_scheduled` frame. Set for timer kinds; absent for promise. */
  delayMs?: number;
}

export interface WakeupHandlers {
  onScheduled?(d: WakeupDescriptor): void;
  onResolved?(id: string, payload?: WakeupResolvedPayload): void;
  onRejected?(id: string, error: string): void;
  onCancelled?(id: string, reason: string): void;
}

export interface PersistentSandboxOpenInput {
  tools: ToolRegistry;
  session: SessionStore;
  permissions: PermissionsConfig | undefined;
  sizeCaps: SizeCaps;
  /** Hard backstop for V8 heap (in MiB). Step 2 default: 512. */
  v8MaxOldSpaceMb?: number;
  /** Optional callbacks for wakeup lifecycle. Each fires once per
   *  matching frame; PersistentSandbox itself does no AgentSession-
   *  specific bookkeeping beyond the parent-side mirror. */
  wakeupHandlers?: WakeupHandlers;
  /** When true, every fire of a wrapped timer wakes the agent (the
   *  callback's return value becomes the synthetic prior step's
   *  reflect state). Default false. Mirrors
   *  `ExperimentalOptions.autoWakeOnTimer`. */
  autoWakeOnTimer?: boolean;
  /** Extra read-only paths spliced into --allow-read. Dreamer-only;
   *  every non-dreamer call site leaves this unset. */
  extraReadOnlyPaths?: string[];
}

/** Mirror size + GC tuning. Plan §"Decisions made" Issue 14: drop
 *  terminal entries 60s after settle, GC pass every 30s, hard cap of
 *  1000 entries with FIFO eviction of oldest terminal entries as a
 *  backstop. */
const WAKEUP_MIRROR_GC_INTERVAL_MS = 30_000;
const WAKEUP_MIRROR_TERMINAL_TTL_MS = 60_000;
const WAKEUP_MIRROR_MAX_ENTRIES = 1000;

export interface RunStepInput {
  llmCode: string;
}

export class PersistentSandbox {
  readonly #tools: ToolRegistry;
  readonly #session: SessionStore;
  readonly #permissions: PermissionsConfig | undefined;
  readonly #sizeCaps: SizeCaps;
  readonly #allowedModules: string[];
  readonly #extraReadOnlyPaths: string[];
  readonly #wakeupHandlers: WakeupHandlers;
  readonly #wakeupMirror: Map<string, WakeupDescriptor> = new Map();
  readonly #autoWakeOnTimer: boolean;
  #gcTimer: number | null = null;

  #proc: Deno.ChildProcess | null = null;
  #reader: FrameReader | null = null;
  #stdinWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #writeChain: Promise<void> = Promise.resolve();
  /** Per-step counter for unique `__step_N.ts` filenames (and dynamic-
   *  import URLs the runtime hasn't seen before, so module-cache misses
   *  every time). */
  #stepCounter = 0;
  /** Set when the sandbox is no longer usable. Reasons: graceful close,
   *  step wall-clock timeout (SIGKILL'd to halt the stuck step), or pump
   *  observing unexpected EOF. Subsequent `runStep` returns a throw
   *  event so callers can drain cleanly. */
  #closed = false;
  /** Reason recorded on first transition to `#closed`. Used as the
   *  message for any post-close `runStep`. */
  #closedReason: string | null = null;
  /** Frame pump promise — drains stdout into in-flight readers and to a
   *  per-step terminal collector. Started once on open. */
  #pumpDone: Promise<void> = Promise.resolve();
  /** Active per-step collector, set by `runStep` while a step is in flight. */
  #activeCollector: StepCollector | null = null;
  /** Serializes `runStep` callers so two concurrent calls can't both
   *  install themselves as `#activeCollector`. The Agent is currently
   *  serial, but the duplex `AgentSession` surface in step 3 will have
   *  multiple producers (user msg + wakeup), so wire it now. */
  #stepChain: Promise<unknown> = Promise.resolve();
  /** Per-step file paths we've written so close() can clean them up. */
  #stepFiles: string[] = [];
  /** Hooks installed by the active `runStep` so wakeup frame handlers
   *  can extend / restore the per-step deadline when an unwrapped
   *  `reflect(promise)` is awaiting. Null between steps. */
  #activeStepDeadline: {
    onPromiseScheduled: (id: string) => void;
    onPromiseSettled: (id: string) => void;
  } | null = null;
  /** Stderr buffer for diagnostics on unexpected exit. */
  #stderrChunks: Uint8Array[] = [];
  #stderrCollect: Promise<void> = Promise.resolve();

  private constructor(args: {
    tools: ToolRegistry;
    session: SessionStore;
    permissions: PermissionsConfig | undefined;
    sizeCaps: SizeCaps;
    allowedModules: string[];
    extraReadOnlyPaths: string[];
    wakeupHandlers: WakeupHandlers;
    autoWakeOnTimer: boolean;
  }) {
    this.#tools = args.tools;
    this.#session = args.session;
    this.#permissions = args.permissions;
    this.#sizeCaps = args.sizeCaps;
    this.#allowedModules = args.allowedModules;
    this.#extraReadOnlyPaths = args.extraReadOnlyPaths;
    this.#wakeupHandlers = args.wakeupHandlers;
    this.#autoWakeOnTimer = args.autoWakeOnTimer;
  }

  static async open(input: PersistentSandboxOpenInput): Promise<PersistentSandbox> {
    const allowedModules = input.permissions?.modules ?? [];
    const sandbox = new PersistentSandbox({
      tools: input.tools,
      session: input.session,
      permissions: input.permissions,
      sizeCaps: input.sizeCaps,
      allowedModules,
      extraReadOnlyPaths: input.extraReadOnlyPaths ?? [],
      wakeupHandlers: input.wakeupHandlers ?? {},
      autoWakeOnTimer: input.autoWakeOnTimer === true,
    });
    await sandbox.#spawn(input.v8MaxOldSpaceMb ?? 512);
    sandbox.#startWakeupMirrorGc();
    return sandbox;
  }

  /** Read-only snapshot of the parent-side wakeup mirror. */
  wakeups(): WakeupDescriptor[] {
    return Array.from(this.#wakeupMirror.values());
  }

  async #spawn(v8MaxOldSpaceMb: number): Promise<void> {
    const script = PreludeV2.build({
      tools: this.#tools.describe(),
      autoWakeOnTimer: this.#autoWakeOnTimer,
      reflectPromiseTimeoutMs: this.#sizeCaps.reflectPromiseTimeoutMs,
    });
    const compiled = PermissionCompiler.compile({
      permissions: this.#permissions,
      sessionDir: this.#session.dir,
      sessionLibPath: this.#session.libPath,
      extraReadOnlyPaths: this.#extraReadOnlyPaths,
    });

    const scriptPath = join(this.#session.dir, "__prelude_v2.ts");
    const importMapPath = join(this.#session.dir, "__import_map.json");
    await Deno.writeTextFile(scriptPath, script);
    await Deno.writeTextFile(importMapPath, JSON.stringify(compiled.importMap));

    const args: string[] = [
      "run",
      "--no-check",
      `--v8-flags=--max-old-space-size=${v8MaxOldSpaceMb}`,
      `--import-map=${importMapPath}`,
      ...compiled.flags,
      scriptPath,
    ];

    const cmd = new Deno.Command(Deno.execPath(), {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      cwd: Deno.cwd(),
      env: {},
      clearEnv: true,
    });
    const proc = cmd.spawn();
    this.#proc = proc;

    this.#reader = new FrameReader(proc.stdout, {
      maxFrameBytes: Math.max(
        this.#sizeCaps.reflectStateBytes,
        this.#sizeCaps.toolResultBytes,
        this.#sizeCaps.libBytes,
      ) + 4096,
    });
    this.#stdinWriter = proc.stdin.getWriter();

    this.#stderrChunks = [];
    this.#stderrCollect = collectStderr(proc.stderr, this.#stderrChunks);

    this.#pumpDone = this.#runPump();
  }

  /** Single long-lived loop draining stdout. Routes RPC responses to
   *  in-flight callers via #handleParentSideRpc, and feeds the active
   *  step collector with logs and terminal frames. */
  async #runPump(): Promise<void> {
    const reader = this.#reader!;
    while (true) {
      let frame: ChildFrame | null;
      try {
        frame = (await reader.readFrame()) as ChildFrame | null;
      } catch (e) {
        if (e instanceof RpcFramingError) {
          this.#activeCollector?.fail(`rpc: ${e.message}`);
        }
        return;
      }
      if (frame === null) {
        // EOF — child exited. Mark sandbox dead so future runStep calls
        // reject cleanly rather than racing for an `exec` write into a
        // closed pipe.
        const reason = this.#unexpectedExitMessage();
        this.#markClosed(reason);
        this.#activeCollector?.fail(reason);
        return;
      }
      const collector = this.#activeCollector;
      switch (frame.type) {
        case "reply":
        case "abort":
        case "reflect":
        case "permission_denied":
        case "throw":
          collector?.complete(frame);
          break;
        case "log":
          collector?.addLog(frame);
          break;
        case "tool_call":
          this.#handleToolCall(frame);
          break;
        case "storage_get":
          this.#handleStorageGet(frame);
          break;
        case "storage_set":
          this.#handleStorageSet(frame);
          break;
        case "storage_del":
          this.#handleStorageDel(frame);
          break;
        case "storage_keys":
          this.#handleStorageKeys(frame);
          break;
        case "write_lib":
          this.#handleWriteLib(frame);
          break;
        case "wakeup_scheduled":
          this.#handleWakeupScheduled(frame);
          break;
        case "wakeup_resolved":
          this.#handleWakeupResolved(frame);
          break;
        case "wakeup_rejected":
          this.#handleWakeupRejected(frame);
          break;
        case "wakeup_cancelled":
          this.#handleWakeupCancelled(frame);
          break;
      }
    }
  }

  // ── wakeup frame handlers ──────────────────────────────────────────────

  #handleWakeupScheduled(frame: import("./types.ts").FrameWakeupScheduled): void {
    const desc: WakeupDescriptor = {
      id: frame.id,
      reason: frame.reason,
      wakeupKind: frame.wakeupKind,
      status: "pending",
      scheduledAt: Date.now(),
    };
    if (frame.delayMs !== undefined) desc.delayMs = frame.delayMs;
    this.#wakeupMirror.set(frame.id, desc);
    if (frame.wakeupKind === "promise") {
      this.#activeStepDeadline?.onPromiseScheduled(frame.id);
    }
    try {
      this.#wakeupHandlers.onScheduled?.(desc);
    } catch { /* host callback errors are not fatal */ }
  }

  #handleWakeupResolved(frame: import("./types.ts").FrameWakeupResolved): void {
    const desc = this.#wakeupMirror.get(frame.id);
    if (desc) {
      if (frame.payload) desc.lastPayload = frame.payload;
      // Intervals keep firing — the descriptor stays pending until the
      // host calls clearInterval (→ wakeup_cancelled). Only timeout /
      // promise wakeups are terminal at this point.
      if (desc.wakeupKind !== "interval" && desc.status === "pending") {
        desc.status = "resolved";
        desc.resolvedAt = Date.now();
      }
      if (desc.wakeupKind === "promise") {
        this.#activeStepDeadline?.onPromiseSettled(frame.id);
      }
    }
    try {
      this.#wakeupHandlers.onResolved?.(frame.id, frame.payload);
    } catch { /* */ }
  }

  #handleWakeupRejected(frame: import("./types.ts").FrameWakeupRejected): void {
    const desc = this.#wakeupMirror.get(frame.id);
    if (desc && desc.status === "pending") {
      desc.status = "rejected";
      desc.resolvedAt = Date.now();
      desc.error = frame.error;
      if (desc.wakeupKind === "promise") {
        this.#activeStepDeadline?.onPromiseSettled(frame.id);
      }
    }
    try {
      this.#wakeupHandlers.onRejected?.(frame.id, frame.error);
    } catch { /* */ }
  }

  #handleWakeupCancelled(frame: import("./types.ts").FrameWakeupCancelled): void {
    const desc = this.#wakeupMirror.get(frame.id);
    if (desc && desc.status === "pending") {
      desc.status = "cancelled";
      desc.resolvedAt = Date.now();
      desc.cancelReason = frame.reason;
      if (desc.wakeupKind === "promise") {
        this.#activeStepDeadline?.onPromiseSettled(frame.id);
      }
    }
    try {
      this.#wakeupHandlers.onCancelled?.(frame.id, frame.reason);
    } catch { /* */ }
  }

  /** Send a `cancel_step` frame. Used by AgentSessionImpl to interrupt
   *  an in-flight `reflect(promise)` wait when a user message arrives.
   *  The dispatcher resolves the wait synthetically and dispatches
   *  reflect with `{ __interrupted_by: reason }` as state. */
  cancelStep(reason: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return this.#writeFrame({ type: "cancel_step", reason }).catch(() => {});
  }

  // ── wakeup mirror GC ──────────────────────────────────────────────────

  #startWakeupMirrorGc(): void {
    // Use the host's native setTimeout (the wrappers live only inside
    // the sandbox subprocess; we're safe). `unref` so this doesn't
    // hold the event loop open at shutdown.
    const handle = setInterval(() => this.#runWakeupMirrorGc(), WAKEUP_MIRROR_GC_INTERVAL_MS);
    // deno-lint-ignore no-explicit-any
    if (typeof (handle as any).unref === "function") (handle as any).unref();
    this.#gcTimer = handle;
  }

  #runWakeupMirrorGc(): void {
    if (this.#wakeupMirror.size === 0) return;
    const cutoff = Date.now() - WAKEUP_MIRROR_TERMINAL_TTL_MS;
    for (const [id, d] of this.#wakeupMirror) {
      if (d.status !== "pending" && (d.resolvedAt ?? 0) < cutoff) {
        this.#wakeupMirror.delete(id);
      }
    }
    // Hard cap backstop. Iteration order is insertion order, so the
    // earliest-inserted terminal entries get evicted first.
    if (this.#wakeupMirror.size > WAKEUP_MIRROR_MAX_ENTRIES) {
      let overflow = this.#wakeupMirror.size - WAKEUP_MIRROR_MAX_ENTRIES;
      for (const [id, d] of this.#wakeupMirror) {
        if (overflow <= 0) break;
        if (d.status !== "pending") {
          this.#wakeupMirror.delete(id);
          overflow--;
        }
      }
    }
  }

  runStep(input: RunStepInput): Promise<SandboxEvent> {
    // Serialize callers so we never have two collectors fighting for the
    // single subprocess. Each call awaits the previous one.
    const myTurn = this.#stepChain.then(() => this.#runStepSerialized(input));
    this.#stepChain = myTurn.catch(() => {});
    return myTurn;
  }

  async #runStepSerialized(input: RunStepInput): Promise<SandboxEvent> {
    if (this.#closed) {
      return {
        kind: "throw",
        error: this.#closedReason ?? "persistent sandbox closed",
        logs: [],
      };
    }

    // 1. Module guard the LLM body before we ever ask the child to import it.
    const guard = ModuleGuard.scan({
      source: input.llmCode,
      allowed: this.#allowedModules,
      filename: `agent_step.ts`,
    });
    if (!guard.ok) {
      return { kind: "throw", error: `module guard: ${guard.reason}`, logs: [] };
    }

    // 2. Write the per-step module to the session dir.
    const stepIdx = ++this.#stepCounter;
    const stepFile = `__step_${stepIdx}.ts`;
    const stepPath = join(this.#session.dir, stepFile);
    const moduleSource = PreludeV2.buildStepModule(input.llmCode);
    await Deno.writeTextFile(stepPath, moduleSource);
    this.#stepFiles.push(stepPath);

    // 3. Set up a collector for this step's terminal/log frames.
    const collector = new StepCollector(this.#sizeCaps);
    this.#activeCollector = collector;

    // 4. Send the exec frame.
    try {
      await this.#writeFrame({ type: "exec", id: `e${stepIdx}`, path: stepPath });
    } catch (e) {
      this.#activeCollector = null;
      return { kind: "throw", error: `exec frame write failed: ${(e as Error).message}`, logs: [] };
    }

    // 5. Wait for terminal frame OR wall-clock timeout.
    //
    // On timeout we MUST stop the stuck step in the subprocess; otherwise
    // a late terminal frame would land on the *next* step's collector.
    // Step 7 will replace this with cooperative-cancel + tier-3 restart;
    // for step 2 we kill the subprocess and mark the sandbox dead. The
    // current step returns a synthetic throw; subsequent runStep calls
    // see #closed and short-circuit.
    //
    // The deadline is re-armable: when the prelude unwraps a
    // `reflect(promise)` and emits `wakeup_scheduled` with
    // `wakeupKind: "promise"`, we extend the deadline to
    // `max(stepDeadline, scheduledAt + reflectPromiseTimeoutMs)` so the
    // separate `reflectPromiseTimeoutMs` cap is actually reachable.
    // When that wakeup settles (resolve / reject / cancel), the deadline
    // recomputes — empty active set returns to the original step
    // deadline.
    const stepStart = Date.now();
    const stepTimeoutMs = this.#sizeCaps.stepTimeoutMs;
    const reflectPromiseTimeoutMs = this.#sizeCaps.reflectPromiseTimeoutMs;
    const baseDeadline = stepStart + stepTimeoutMs;
    const activePromises = new Map<string, number>();
    let currentDeadline = baseDeadline;
    let timeoutHandle: number | null = null;

    const fireDeadline = () => {
      const elapsed = currentDeadline - stepStart;
      const reason = `step exceeded ${elapsed}ms wall-clock cap; sandbox killed`;
      this.#markClosed(reason);
      try {
        this.#proc?.kill("SIGKILL");
      } catch { /* already gone */ }
      collector.fail(reason);
    };
    const armTimer = () => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      const delay = Math.max(0, currentDeadline - Date.now());
      timeoutHandle = setTimeout(fireDeadline, delay);
    };
    const recomputeDeadline = () => {
      let extension = 0;
      for (const at of activePromises.values()) {
        const candidate = at + reflectPromiseTimeoutMs;
        if (candidate > extension) extension = candidate;
      }
      const newDeadline = Math.max(baseDeadline, extension);
      if (newDeadline !== currentDeadline) {
        currentDeadline = newDeadline;
        armTimer();
      }
    };

    this.#activeStepDeadline = {
      onPromiseScheduled: (id) => {
        activePromises.set(id, Date.now());
        recomputeDeadline();
      },
      onPromiseSettled: (id) => {
        if (!activePromises.delete(id)) return;
        recomputeDeadline();
      },
    };
    armTimer();

    let event: SandboxEvent;
    try {
      event = await collector.done;
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      this.#activeStepDeadline = null;
      this.#activeCollector = null;
    }

    // 6. Reflect-state size cap (mirrors v1 behavior).
    if (event.kind === "reflect") {
      const json = JSON.stringify(event.state);
      if (json !== undefined && enc.encode(json).length > this.#sizeCaps.reflectStateBytes) {
        return {
          kind: "throw",
          error: `reflect state too large: ${
            enc.encode(json).length
          } bytes (cap ${this.#sizeCaps.reflectStateBytes})`,
          logs: event.logs,
        };
      }
    }

    return event;
  }

  /** Idempotent. First reason wins. */
  #markClosed(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closedReason = reason;
  }

  async close(): Promise<void> {
    const wasClosed = this.#closed;
    this.#markClosed("persistent sandbox closed");

    if (this.#gcTimer !== null) {
      clearInterval(this.#gcTimer);
      this.#gcTimer = null;
    }

    // Graceful shutdown with a hard timeout backstop. Order:
    //   1. Send `shutdown` frame so the dispatcher exits cleanly.
    //   2. Race proc.status against a 2s timer; SIGKILL if it lapses.
    if (!wasClosed) {
      try {
        await this.#writeFrame({ type: "shutdown" });
      } catch { /* writer may already be closed */ }
    }
    try {
      await this.#stdinWriter?.close();
    } catch { /* may already be closed */ }

    const proc = this.#proc;
    if (proc) {
      const status = proc.status.catch(() => null);
      let timerHandle: number | null = null;
      const timer = new Promise<"timeout">((resolve) => {
        timerHandle = setTimeout(() => resolve("timeout"), 2000);
      });
      const winner = await Promise.race([status, timer]);
      if (timerHandle !== null) clearTimeout(timerHandle);
      if (winner === "timeout") {
        try {
          proc.kill("SIGKILL");
        } catch { /* already gone */ }
        try {
          await proc.status;
        } catch { /* */ }
      }
    }
    try {
      await this.#reader?.cancel();
    } catch { /* */ }
    try {
      await this.#pumpDone;
    } catch { /* */ }
    try {
      await this.#stderrCollect;
    } catch { /* */ }

    // Clean up the per-step source files we wrote. The session dir
    // itself is owned by SessionStore (which deletes it for ephemeral
    // sessions); for persistent sessions we don't want unbounded
    // `__step_N.ts` files to accumulate across runs.
    for (const path of this.#stepFiles) {
      try {
        await Deno.remove(path);
      } catch { /* may have been removed already */ }
    }
    this.#stepFiles = [];
  }

  // ── parent-side RPC handlers (mirror sandbox.ts) ───────────────────────

  #writeFrame(value: unknown): Promise<void> {
    if (!this.#stdinWriter) {
      return Promise.reject(new Error("sandbox stdin not initialized"));
    }
    const writer = this.#stdinWriter;
    const frame = encodeFrame(value);
    const next = this.#writeChain.then(() => writer.write(frame));
    this.#writeChain = next.catch(() => {});
    return next;
  }

  async #handleToolCall(frame: import("./types.ts").FrameToolCall): Promise<void> {
    const outcome = await this.#tools.call(frame.name, frame.args, {
      maxResultBytes: this.#sizeCaps.toolResultBytes,
    });
    const reply = outcome.ok
      ? { type: "tool_result", id: frame.id, ok: true, value: outcome.value }
      : {
        type: "tool_result",
        id: frame.id,
        ok: false,
        error: outcome.error,
        issues: outcome.issues,
      };
    await this.#writeFrame(reply).catch(() => {});
  }

  async #handleStorageGet(frame: import("./types.ts").FrameStorageGet): Promise<void> {
    try {
      const value = this.#session.storageGet(frame.key);
      await this.#writeFrame({ type: "storage_result", id: frame.id, ok: true, value });
    } catch (e) {
      await this.#writeFrame({
        type: "storage_result",
        id: frame.id,
        ok: false,
        error: (e as Error).message,
      });
    }
  }

  async #handleStorageSet(frame: import("./types.ts").FrameStorageSet): Promise<void> {
    try {
      await this.#session.storageSet(frame.key, frame.value);
      await this.#writeFrame({ type: "storage_result", id: frame.id, ok: true });
    } catch (e) {
      await this.#writeFrame({
        type: "storage_result",
        id: frame.id,
        ok: false,
        error: (e as Error).message,
      });
    }
  }

  async #handleStorageDel(frame: import("./types.ts").FrameStorageDel): Promise<void> {
    try {
      await this.#session.storageDel(frame.key);
      await this.#writeFrame({ type: "storage_result", id: frame.id, ok: true });
    } catch (e) {
      await this.#writeFrame({
        type: "storage_result",
        id: frame.id,
        ok: false,
        error: (e as Error).message,
      });
    }
  }

  async #handleStorageKeys(frame: import("./types.ts").FrameStorageKeys): Promise<void> {
    try {
      const keys = this.#session.storageKeys();
      await this.#writeFrame({ type: "storage_result", id: frame.id, ok: true, value: keys });
    } catch (e) {
      await this.#writeFrame({
        type: "storage_result",
        id: frame.id,
        ok: false,
        error: (e as Error).message,
      });
    }
  }

  async #handleWriteLib(frame: import("./types.ts").FrameWriteLib): Promise<void> {
    try {
      await this.#session.writeLib(frame.source, this.#allowedModules);
      await this.#writeFrame({ type: "write_lib_result", id: frame.id, ok: true });
    } catch (e) {
      await this.#writeFrame({
        type: "write_lib_result",
        id: frame.id,
        ok: false,
        error: (e as Error).message,
      });
    }
  }

  #unexpectedExitMessage(): string {
    const stderrText = decodeAll(this.#stderrChunks);
    return `sandbox subprocess exited unexpectedly${
      stderrText ? `: ${stderrText.slice(0, 1024)}` : ""
    }`;
  }
}

// ── per-step collector ───────────────────────────────────────────────────

class StepCollector {
  readonly done: Promise<SandboxEvent>;
  #resolve!: (ev: SandboxEvent) => void;
  #logs: SandboxLog[] = [];
  #logBytes = 0;
  #logsTruncated = false;
  readonly #caps: SizeCaps;
  #settled = false;

  constructor(caps: SizeCaps) {
    this.#caps = caps;
    this.done = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  addLog(frame: import("./types.ts").FrameLog): void {
    if (this.#logsTruncated) return;
    const sizeOfThis = enc.encode(JSON.stringify(frame.args)).length;
    if (this.#logBytes + sizeOfThis > this.#caps.logBytes) {
      this.#logs.push({
        level: "warn",
        args: [
          `…[log truncated at ${this.#caps.logBytes} bytes; further logs dropped]`,
        ],
      });
      this.#logsTruncated = true;
    } else {
      this.#logBytes += sizeOfThis;
      this.#logs.push({ level: frame.level, args: frame.args });
    }
  }

  complete(frame: ChildFrame): void {
    if (this.#settled) return;
    this.#settled = true;
    switch (frame.type) {
      case "reply":
        this.#resolve({ kind: "reply", message: frame.message, logs: this.#logs });
        break;
      case "abort":
        this.#resolve({ kind: "abort", error: frame.error, logs: this.#logs });
        break;
      case "reflect":
        this.#resolve({ kind: "reflect", state: frame.state, logs: this.#logs });
        break;
      case "permission_denied":
        this.#resolve({
          kind: "permission_denied",
          permission: classifyPermission(frame.permission),
          target: frame.target,
          logs: this.#logs,
        });
        break;
      case "throw":
        this.#resolve({ kind: "throw", error: frame.error, logs: this.#logs });
        break;
      default:
        this.#resolve({
          kind: "throw",
          error: `unexpected frame type ${(frame as { type: string }).type}`,
          logs: this.#logs,
        });
    }
  }

  fail(error: string): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve({ kind: "throw", error, logs: this.#logs });
  }
}

// ── helpers (mirror sandbox.ts) ──────────────────────────────────────────

async function collectStderr(
  stream: ReadableStream<Uint8Array>,
  out: Uint8Array[],
): Promise<void> {
  const r = stream.getReader();
  try {
    while (true) {
      const { value, done } = await r.read();
      if (done) return;
      if (value && value.length) out.push(value);
    }
  } catch {
    /* */
  } finally {
    try {
      r.releaseLock();
    } catch { /* */ }
    try {
      await stream.cancel();
    } catch { /* */ }
  }
}

function decodeAll(chunks: Uint8Array[]): string {
  if (chunks.length === 0) return "";
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.length;
  }
  try {
    return new TextDecoder().decode(merged);
  } catch {
    return "";
  }
}
