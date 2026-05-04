// Shared types for the agent library.
//
// This file is the single source of truth for the discriminated unions that
// flow between Agent → Sandbox → Prelude → tool handlers, plus the typed
// errors users (and tools) can encounter.

import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { z } from "zod";

// ────────────────────────────────────────────────────────────────────────────
// Public surface (Agent options + result)
// ────────────────────────────────────────────────────────────────────────────

export interface PermissionsConfig {
  /** Hostnames the sandbox may reach. Empty / undefined → no net. */
  net?: string[];
  /** Filesystem read paths. `.rex/sessions/<id>` is auto-added. */
  read?: string[];
  /** Filesystem write paths. */
  write?: string[];
  /** Whether the sandbox may spawn subprocesses. MVP: boolean only. */
  run?: boolean;
  /** Module specifiers the sandbox may import. */
  modules?: string[];
}

export interface ToolDefinition<
  // deno-lint-ignore no-explicit-any
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TResult = unknown,
> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (args: z.infer<TSchema>) => Promise<TResult> | TResult;
  /** Optional override for what TS signature the LLM sees in the prompt. */
  tsSignature?: string;
}

export interface SizeCaps {
  /** Per-step cumulative log bytes. Default 64 KiB. */
  logBytes: number;
  /** Max bytes for a single `reflect(state)` JSON. Default 256 KiB. */
  reflectStateBytes: number;
  /** Max bytes for a single tool result JSON. Default 256 KiB. */
  toolResultBytes: number;
  /** Max bytes for `lib.ts` source. Default 64 KiB. */
  libBytes: number;
  /** Max bytes for storage.json total. Default 1 MiB. */
  storageBytes: number;
  /** Per-step wall-clock cap in ms. Default 60_000. */
  stepTimeoutMs: number;
}

export const DEFAULT_SIZE_CAPS: SizeCaps = {
  logBytes: 64 * 1024,
  reflectStateBytes: 256 * 1024,
  toolResultBytes: 256 * 1024,
  libBytes: 64 * 1024,
  storageBytes: 1024 * 1024,
  stepTimeoutMs: 60_000,
};

export interface StepRecord {
  /** 1-based index of the step within this run. */
  index: number;
  /** Whether this step came from the transcript (resume) or just executed. */
  source: "fresh" | "resumed";
  code: string;
  event: SandboxEvent;
}

export interface AgentOptions {
  model: LanguageModelV2;
  task: string;
  // deno-lint-ignore no-explicit-any
  tools?: ToolDefinition<any, any>[];
  permissions?: PermissionsConfig;
  /** Persistent session id. Omit to use an ephemeral session. */
  sessionId?: string;
  /** Hard cap on agent loop iterations. Default 8. */
  maxSteps?: number;
  /** Override default size caps. */
  sizeCaps?: Partial<SizeCaps>;
  /** Root for `.rex/sessions/<id>/`. Defaults to cwd. */
  sessionsRoot?: string;
  /**
   * If true, replays `transcript.jsonl` as priorSteps when resuming a
   * session. Default false (state persists, history doesn't — original
   * §14a contract).
   */
  resumeHistory?: boolean;
  /**
   * Called after each step (both replayed-from-transcript and freshly-
   * executed). Useful for CLI / UI rendering. Awaited if it returns a
   * promise.
   */
  onStep?: (step: StepRecord) => void | Promise<void>;
}

export type RunResult =
  | { kind: "reply"; message: string }
  | { kind: "abort"; error: string }
  | { kind: "exhausted"; steps: number };

// ────────────────────────────────────────────────────────────────────────────
// Sandbox events (parent's view of one step)
// ────────────────────────────────────────────────────────────────────────────

export type SandboxLog = {
  level: "log" | "info" | "warn" | "error" | "debug";
  // deno-lint-ignore no-explicit-any
  args: any[];
};

export type PermissionKind = "net" | "read" | "write" | "run" | "env" | "ffi" | "sys";

export type SandboxEvent =
  | { kind: "reply"; message: string; logs: SandboxLog[] }
  | { kind: "abort"; error: string; logs: SandboxLog[] }
  | { kind: "reflect"; state: unknown; logs: SandboxLog[] }
  | {
    kind: "permission_denied";
    permission: PermissionKind;
    target: string;
    logs: SandboxLog[];
  }
  | { kind: "throw"; error: string; logs: SandboxLog[] };

// ────────────────────────────────────────────────────────────────────────────
// RPC frames (parent ↔ child)
// ────────────────────────────────────────────────────────────────────────────

// Child → Parent (one-shot terminal events)
export interface FrameReply {
  type: "reply";
  message: string;
}
export interface FrameAbort {
  type: "abort";
  error: string;
}
export interface FrameReflect {
  type: "reflect";
  state: unknown;
}
export interface FramePermissionDenied {
  type: "permission_denied";
  permission: PermissionKind;
  target: string;
}
export interface FrameThrow {
  type: "throw";
  error: string;
}
export interface FrameLog {
  type: "log";
  level: SandboxLog["level"];
  // deno-lint-ignore no-explicit-any
  args: any[];
}

// Child → Parent (request/response style — child awaits a *_result)
export interface FrameToolCall {
  type: "tool_call";
  id: string;
  name: string;
  args: unknown;
}
export interface FrameStorageGet {
  type: "storage_get";
  id: string;
  key: string;
}
export interface FrameStorageSet {
  type: "storage_set";
  id: string;
  key: string;
  value: unknown;
}
export interface FrameStorageDel {
  type: "storage_del";
  id: string;
  key: string;
}
export interface FrameStorageKeys {
  type: "storage_keys";
  id: string;
}
export interface FrameWriteLib {
  type: "write_lib";
  id: string;
  source: string;
}

// Parent → Child (responses)
export interface FrameToolResult {
  type: "tool_result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export interface FrameStorageResult {
  type: "storage_result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}
export interface FrameWriteLibResult {
  type: "write_lib_result";
  id: string;
  ok: boolean;
  error?: string;
}

export type ChildFrame =
  | FrameReply
  | FrameAbort
  | FrameReflect
  | FramePermissionDenied
  | FrameThrow
  | FrameLog
  | FrameToolCall
  | FrameStorageGet
  | FrameStorageSet
  | FrameStorageDel
  | FrameStorageKeys
  | FrameWriteLib;

export type ParentFrame =
  | FrameToolResult
  | FrameStorageResult
  | FrameWriteLibResult;

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

/** Thrown by `CodeExtractor.extract` when no ts/typescript fence is found. */
export class NoCodeBlockError extends Error {
  constructor(message = "no ts/typescript code block found in model output") {
    super(message);
    this.name = "NoCodeBlockError";
  }
}

/** Thrown inside the sandbox when a tool call fails (incl. zod validation). */
export class ToolError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

/** Returned to the sandbox when a tool result exceeds the size cap. */
export class ToolResultTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolResultTooLargeError";
  }
}

/** Returned to the sandbox when `writeLib` is rejected. */
export class WriteLibError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteLibError";
  }
}

/** Thrown by `Agent.run` when another run is already holding the session lock. */
export class SessionLockedError extends Error {
  constructor(sessionId: string, holderPid: number | null) {
    super(
      `session "${sessionId}" is locked${holderPid !== null ? ` by pid ${holderPid}` : ""}`,
    );
    this.name = "SessionLockedError";
  }
}

/** Reserved tool / global names — Agent rejects user tools that collide. */
export const RESERVED_NAMES = [
  "reply",
  "abort",
  "reflect",
  "writeLib",
  "storage",
  "console",
] as const;
