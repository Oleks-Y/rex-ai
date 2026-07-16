// SDK-side type mirrors of the agent's runtime events.
//
// These are structurally compatible with the Deno-side `AgentEvent` in
// `src/types.ts`, plus the `phase` and `resync` variants the server adds
// on the wire. They are intentionally re-declared here (rather than
// imported) so the SDK has no runtime dependency on the Deno-only
// `src/types.ts` (which references `@ai-sdk/provider`).

export type SandboxLog = {
  level: "log" | "info" | "warn" | "error" | "debug";
  args: unknown[];
};

export type PermissionKind =
  | "net"
  | "read"
  | "write"
  | "run"
  | "env"
  | "ffi"
  | "sys";

export type GuardrailBlockedOriginal =
  | { kind: "reply"; message: string }
  | { kind: "abort"; error: string }
  | { kind: "reflect"; state: unknown }
  | { kind: "permission_denied"; permission: PermissionKind; target: string }
  | { kind: "throw"; error: string };

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
  | { kind: "throw"; error: string; logs: SandboxLog[] }
  | {
    kind: "guardrail_blocked";
    guardrail: string;
    reason: string;
    originalKind: GuardrailBlockedOriginal["kind"];
    original: GuardrailBlockedOriginal;
    logs: SandboxLog[];
  };

export type TurnCause = "user" | "wakeup";
export type WakeupKind = "timeout" | "interval" | "promise";

export interface WakeupResolvedPayload {
  state?: unknown;
  intent?: { kind: "reply" | "abort"; text: string };
}

export type AgentEvent =
  | {
    kind: "step";
    index: number;
    source: "fresh" | "resumed";
    code: string;
    event: SandboxEvent;
  }
  | { kind: "reply"; message: string; turn: number; cause: TurnCause }
  | { kind: "abort"; error: string; turn: number; cause: TurnCause }
  | { kind: "exhausted"; steps: number; turn: number; cause: TurnCause }
  | {
    kind: "wakeup_scheduled";
    id: string;
    reason: string;
    wakeupKind: WakeupKind;
    delayMs?: number;
  }
  | { kind: "wakeup_resolved"; id: string; payload?: WakeupResolvedPayload }
  | { kind: "wakeup_rejected"; id: string; error: string }
  | { kind: "wakeup_cancelled"; id: string; reason: string }
  | { kind: "session_closed"; reason: string };

/** Wire-only event variants the server adds on top of `AgentEvent`. */
export type WirePhaseEvent = {
  kind: "phase";
  phase: "generating" | "running";
  stepIndex: number;
};

export type WireResyncEvent = { kind: "resync"; reason: "ring_rolled" };

export type WireEvent = AgentEvent | WirePhaseEvent | WireResyncEvent;

export interface WireFrame {
  seq: number;
  event: WireEvent;
}

// ────────────────────────────────────────────────────────────────────────────
// Chat-shape derived types (reducer output, consumed by UI)
// ────────────────────────────────────────────────────────────────────────────

export type ChatStatus =
  | "idle"
  | "connecting"
  | "thinking"
  | "running"
  | "replying"
  | "closed"
  | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** When `role==="assistant"` and the agent did not produce a clean reply. */
  error?: "abort" | "exhausted" | "guardrail";
  /** 1-based step indices this assistant message was assembled from. */
  stepRange?: [number, number];
  createdAt: number;
}

export interface GuardrailBlock {
  guardrail: string;
  reason: string;
  stepIndex: number;
  at: number;
}
