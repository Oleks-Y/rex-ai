// Sandbox — spawns a Deno subprocess for one agent step, drives the RPC
// loop, and resolves to a SandboxEvent (one of reply / abort / reflect /
// permission_denied / throw).
//
// Per §4 / §5 / §11 / §17:
//   - One subprocess per step (clean isolation).
//   - stdin/stdout carry framed JSON RPC, nothing else.
//   - Tool calls / writeLib / storage are mediated by the parent.
//   - Logs accumulate per step with a size cap (logBytes); over-cap logs
//     are truncated and a marker is appended.
//   - reflect state JSON over the cap → translated to a synthetic throw
//     event so the LLM gets a chance to retry with smaller state.
//   - Per-step wall-clock cap → SIGKILL the child, return a synthetic throw.

import { join } from "@std/path";
import { encodeFrame, FrameReader, RpcFramingError } from "./rpc.ts";
import { PermissionCompiler } from "./permissions.ts";
import { ModuleGuard } from "./module_guard.ts";
import { Prelude } from "./prelude.ts";
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

export interface RunInput {
  llmCode: string;
  tools: ToolRegistry;
  session: SessionStore;
  permissions: PermissionsConfig | undefined;
  sizeCaps: SizeCaps;
}

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

export const Sandbox = {
  async run(input: RunInput): Promise<SandboxEvent> {
    // 1. Pre-scan the LLM code through the same module guard we apply to
    //    writeLib. If it imports something disallowed, fail before we even
    //    spawn — the model gets a clean throw event with the reason.
    const allowedModules = input.permissions?.modules ?? [];
    const guard = ModuleGuard.scan({
      source: input.llmCode,
      allowed: allowedModules,
      filename: "agent_step.ts",
    });
    if (!guard.ok) {
      return { kind: "throw", error: `module guard: ${guard.reason}`, logs: [] };
    }

    // 2. Build prelude + script.
    const script = Prelude.build({
      llmCode: input.llmCode,
      tools: input.tools.describe(),
    });

    // 3. Compile permissions + import map.
    const compiled = PermissionCompiler.compile({
      permissions: input.permissions,
      sessionDir: input.session.dir,
      sessionLibPath: input.session.libPath,
    });

    // 4. Write step script + import map into the session dir.
    //    They're regenerated per step (allowlist may change between calls).
    const scriptPath = join(input.session.dir, "__step.ts");
    const importMapPath = join(input.session.dir, "__import_map.json");
    await Deno.writeTextFile(scriptPath, script);
    await Deno.writeTextFile(importMapPath, JSON.stringify(compiled.importMap));

    // 5. Spawn Deno.
    const args: string[] = [
      "run",
      "--no-check",
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
      env: {}, // child gets a clean env; --allow-env isn't granted anyway
      clearEnv: true,
    });
    const proc = cmd.spawn();

    // 6. Set up timeout.
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch { /* already exited */ }
    }, input.sizeCaps.stepTimeoutMs);

    // 7. Drive the RPC loop.
    const reader = new FrameReader(proc.stdout, {
      maxFrameBytes: Math.max(
        input.sizeCaps.reflectStateBytes,
        input.sizeCaps.toolResultBytes,
        input.sizeCaps.libBytes,
      ) + 4096, // a little slack for the framing wrapper
    });
    const stderrChunks: Uint8Array[] = [];
    const stderrCollect = collectStderr(proc.stderr, stderrChunks);

    const logs: SandboxLog[] = [];
    let logBytes = 0;
    let logsTruncated = false;
    let terminal: SandboxEvent | null = null;

    // Hold the stdin writer for the lifetime of the run. Acquiring per-call
    // (`proc.stdin.getWriter()` on each frame) races when multiple in-flight
    // handlers (concurrent tool/storage calls from the LLM body) try to write
    // back at the same time and Deno throws "stream is already locked".
    // Serialize through a promise chain so frames go out in submission order.
    const stdinWriter = proc.stdin.getWriter();
    let writeChain: Promise<void> = Promise.resolve();
    const writeFrameTo = (value: unknown): Promise<void> => {
      const frame = encodeFrame(value);
      const next = writeChain.then(() => stdinWriter.write(frame));
      // Detach from the chain so one rejected write doesn't poison the rest;
      // the immediate caller still observes the rejection via `next`.
      writeChain = next.catch(() => {});
      return next;
    };

    try {
      // Inline frame-handling loop. We handle one frame at a time but
      // dispatch tool/storage/writeLib calls without blocking subsequent
      // frame reads (the child awaits the response by id, but it can keep
      // sending logs in between).
      const inflight: Promise<void>[] = [];
      while (terminal === null) {
        let frame: ChildFrame | null;
        try {
          frame = (await reader.readFrame()) as ChildFrame | null;
        } catch (e) {
          if (e instanceof RpcFramingError) {
            terminal = { kind: "throw", error: `rpc: ${e.message}`, logs };
            break;
          }
          throw e;
        }
        if (frame === null) {
          // EOF without a terminal frame → child died early.
          if (timedOut) {
            terminal = {
              kind: "throw",
              error: `step exceeded ${input.sizeCaps.stepTimeoutMs}ms wall-clock cap`,
              logs,
            };
          } else {
            const stderrText = decodeAll(stderrChunks);
            terminal = {
              kind: "throw",
              error: `sandbox exited without sending a control frame${
                stderrText ? `: ${stderrText.slice(0, 1024)}` : ""
              }`,
              logs,
            };
          }
          break;
        }

        switch (frame.type) {
          case "reply":
            terminal = { kind: "reply", message: frame.message, logs };
            break;
          case "abort":
            terminal = { kind: "abort", error: frame.error, logs };
            break;
          case "reflect": {
            const json = JSON.stringify(frame.state);
            if (json !== undefined && enc.encode(json).length > input.sizeCaps.reflectStateBytes) {
              terminal = {
                kind: "throw",
                error: `reflect state too large: ${
                  enc.encode(json).length
                } bytes (cap ${input.sizeCaps.reflectStateBytes})`,
                logs,
              };
            } else {
              terminal = { kind: "reflect", state: frame.state, logs };
            }
            break;
          }
          case "permission_denied":
            terminal = {
              kind: "permission_denied",
              permission: classifyPermission(frame.permission),
              target: frame.target,
              logs,
            };
            break;
          case "throw":
            terminal = { kind: "throw", error: frame.error, logs };
            break;
          case "log": {
            // Record up to logBytes; drop after that with a single marker.
            if (logsTruncated) break;
            const sizeOfThis = enc.encode(JSON.stringify(frame.args)).length;
            if (logBytes + sizeOfThis > input.sizeCaps.logBytes) {
              logs.push({
                level: "warn",
                args: [
                  `…[log truncated at ${input.sizeCaps.logBytes} bytes; further logs dropped]`,
                ],
              });
              logsTruncated = true;
            } else {
              logBytes += sizeOfThis;
              logs.push({ level: frame.level, args: frame.args });
            }
            break;
          }
          case "tool_call":
            inflight.push(handleToolCall(frame, input, writeFrameTo));
            break;
          case "storage_get":
            inflight.push(handleStorageGet(frame, input, writeFrameTo));
            break;
          case "storage_set":
            inflight.push(handleStorageSet(frame, input, writeFrameTo));
            break;
          case "storage_del":
            inflight.push(handleStorageDel(frame, input, writeFrameTo));
            break;
          case "storage_keys":
            inflight.push(handleStorageKeys(frame, input, writeFrameTo));
            break;
          case "write_lib":
            inflight.push(
              handleWriteLib(frame, input, writeFrameTo, allowedModules),
            );
            break;
        }
      }

      // Drain in-flight handler responses so we don't leave promises behind.
      await Promise.allSettled(inflight);
    } finally {
      clearTimeout(timeout);
      // Order matters: cancel reader (releases stdout lock + drops pipe),
      // close stdin, ensure child is dead, await status, drain stderr.
      try {
        await reader.cancel();
      } catch { /* */ }
      // `stdinWriter.close()` closes the underlying pipe; calling
      // `proc.stdin.close()` while we still hold the lock would throw.
      try {
        await stdinWriter.close();
      } catch { /* may already be closed */ }
      try {
        proc.kill("SIGKILL");
      } catch { /* already exited */ }
      try {
        await proc.status;
      } catch { /* */ }
      await stderrCollect.catch(() => {});
    }

    return terminal!;
  },
};

// ── frame handlers ────────────────────────────────────────────────────────

async function handleToolCall(
  frame: import("./types.ts").FrameToolCall,
  input: RunInput,
  send: (v: unknown) => Promise<void>,
): Promise<void> {
  const outcome = await input.tools.call(frame.name, frame.args, {
    maxResultBytes: input.sizeCaps.toolResultBytes,
  });
  const reply = outcome.ok
    ? { type: "tool_result", id: frame.id, ok: true, value: outcome.value }
    : { type: "tool_result", id: frame.id, ok: false, error: outcome.error, issues: outcome.issues };
  await send(reply);
}

async function handleStorageGet(
  frame: import("./types.ts").FrameStorageGet,
  input: RunInput,
  send: (v: unknown) => Promise<void>,
): Promise<void> {
  try {
    const value = input.session.storageGet(frame.key);
    await send({ type: "storage_result", id: frame.id, ok: true, value });
  } catch (e) {
    await send({ type: "storage_result", id: frame.id, ok: false, error: (e as Error).message });
  }
}

async function handleStorageSet(
  frame: import("./types.ts").FrameStorageSet,
  input: RunInput,
  send: (v: unknown) => Promise<void>,
): Promise<void> {
  try {
    await input.session.storageSet(frame.key, frame.value);
    await send({ type: "storage_result", id: frame.id, ok: true });
  } catch (e) {
    await send({ type: "storage_result", id: frame.id, ok: false, error: (e as Error).message });
  }
}

async function handleStorageDel(
  frame: import("./types.ts").FrameStorageDel,
  input: RunInput,
  send: (v: unknown) => Promise<void>,
): Promise<void> {
  try {
    await input.session.storageDel(frame.key);
    await send({ type: "storage_result", id: frame.id, ok: true });
  } catch (e) {
    await send({ type: "storage_result", id: frame.id, ok: false, error: (e as Error).message });
  }
}

async function handleStorageKeys(
  frame: import("./types.ts").FrameStorageKeys,
  input: RunInput,
  send: (v: unknown) => Promise<void>,
): Promise<void> {
  try {
    const keys = input.session.storageKeys();
    await send({ type: "storage_result", id: frame.id, ok: true, value: keys });
  } catch (e) {
    await send({ type: "storage_result", id: frame.id, ok: false, error: (e as Error).message });
  }
}

async function handleWriteLib(
  frame: import("./types.ts").FrameWriteLib,
  input: RunInput,
  send: (v: unknown) => Promise<void>,
  allowedModules: string[],
): Promise<void> {
  try {
    await input.session.writeLib(frame.source, allowedModules);
    await send({ type: "write_lib_result", id: frame.id, ok: true });
  } catch (e) {
    await send({
      type: "write_lib_result",
      id: frame.id,
      ok: false,
      error: (e as Error).message,
    });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

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
    // Stream may have been cancelled by the caller after a SIGKILL — that's
    // fine, just stop collecting.
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
