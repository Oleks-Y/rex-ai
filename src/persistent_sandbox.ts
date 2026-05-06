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
// As of step 4, the prelude exposes `scheduleWakeup` + `tasks`; this
// file relays the resulting wakeup_* frames through `WakeupHandlers`
// and keeps a parent-side `WakeupDescriptor` mirror. Soft cancel
// (step 6) and tier-3 SIGKILL+restart (step 7) still aren't here. A
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
 *  events (e.g. tier-3 restart, step 7) — the actual JS promise lives
 *  in the subprocess and dies with it, but the descriptor here lets
 *  the host re-create timer-based wakeups on restart and surface
 *  scheduled tasks in event streams. */
export interface WakeupDescriptor {
  id: string;
  reason: string;
  wakeupKind: "delay" | "thunk" | "signal";
  status: "pending" | "resolved" | "rejected" | "cancelled";
  /** Wall-clock ms when the wakeup was registered (parent-side). */
  scheduledAt: number;
  /** Set on terminal transition. */
  resolvedAt?: number;
  error?: string;
  cancelReason?: string;
}

export interface WakeupHandlers {
  onScheduled?(d: WakeupDescriptor): void;
  onResolved?(id: string): void;
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
}

export interface RunStepInput {
  llmCode: string;
}

export class PersistentSandbox {
  readonly #tools: ToolRegistry;
  readonly #session: SessionStore;
  readonly #permissions: PermissionsConfig | undefined;
  readonly #sizeCaps: SizeCaps;
  readonly #allowedModules: string[];
  readonly #wakeupHandlers: WakeupHandlers;
  readonly #wakeupMirror: Map<string, WakeupDescriptor> = new Map();

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
  /** Stderr buffer for diagnostics on unexpected exit. */
  #stderrChunks: Uint8Array[] = [];
  #stderrCollect: Promise<void> = Promise.resolve();

  private constructor(args: {
    tools: ToolRegistry;
    session: SessionStore;
    permissions: PermissionsConfig | undefined;
    sizeCaps: SizeCaps;
    allowedModules: string[];
    wakeupHandlers: WakeupHandlers;
  }) {
    this.#tools = args.tools;
    this.#session = args.session;
    this.#permissions = args.permissions;
    this.#sizeCaps = args.sizeCaps;
    this.#allowedModules = args.allowedModules;
    this.#wakeupHandlers = args.wakeupHandlers;
  }

  static async open(input: PersistentSandboxOpenInput): Promise<PersistentSandbox> {
    const allowedModules = input.permissions?.modules ?? [];
    const sandbox = new PersistentSandbox({
      tools: input.tools,
      session: input.session,
      permissions: input.permissions,
      sizeCaps: input.sizeCaps,
      allowedModules,
      wakeupHandlers: input.wakeupHandlers ?? {},
    });
    await sandbox.#spawn(input.v8MaxOldSpaceMb ?? 512);
    return sandbox;
  }

  /** Read-only snapshot of the parent-side wakeup mirror. */
  wakeups(): WakeupDescriptor[] {
    return Array.from(this.#wakeupMirror.values());
  }

  async #spawn(v8MaxOldSpaceMb: number): Promise<void> {
    const script = PreludeV2.build({ tools: this.#tools.describe() });
    const compiled = PermissionCompiler.compile({
      permissions: this.#permissions,
      sessionDir: this.#session.dir,
      sessionLibPath: this.#session.libPath,
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
    this.#wakeupMirror.set(frame.id, desc);
    try {
      this.#wakeupHandlers.onScheduled?.(desc);
    } catch { /* host callback errors are not fatal */ }
  }

  #handleWakeupResolved(frame: import("./types.ts").FrameWakeupResolved): void {
    const desc = this.#wakeupMirror.get(frame.id);
    if (desc && desc.status === "pending") {
      desc.status = "resolved";
      desc.resolvedAt = Date.now();
    }
    try {
      this.#wakeupHandlers.onResolved?.(frame.id);
    } catch { /* */ }
  }

  #handleWakeupRejected(frame: import("./types.ts").FrameWakeupRejected): void {
    const desc = this.#wakeupMirror.get(frame.id);
    if (desc && desc.status === "pending") {
      desc.status = "rejected";
      desc.resolvedAt = Date.now();
      desc.error = frame.error;
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
    }
    try {
      this.#wakeupHandlers.onCancelled?.(frame.id, frame.reason);
    } catch { /* */ }
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
    const timeoutMs = this.#sizeCaps.stepTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      const reason = `step exceeded ${timeoutMs}ms wall-clock cap; sandbox killed`;
      this.#markClosed(reason);
      try {
        this.#proc?.kill("SIGKILL");
      } catch { /* already gone */ }
      collector.fail(reason);
    }, timeoutMs);

    let event: SandboxEvent;
    try {
      event = await collector.done;
    } finally {
      clearTimeout(timeoutHandle);
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
