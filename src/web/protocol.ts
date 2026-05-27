// Wire protocol for the frontend chat SDK.
//
// SSE downstream + POST upstream. Each SSE frame carries a single
// `WireFrame { seq, event }`. `seq` is monotonic per session and rides
// the SSE `id:` field so browsers re-send it as `Last-Event-ID` after a
// reconnect (reconnect handling lives in src/web/server.ts).
//
// `WireEvent` is a superset of `AgentEvent`:
//   - `phase` — derived from the agent's `onPhase` callback so the
//     client can show a generating/running indicator without inferring
//     it from step boundaries.
//   - `resync` — server tells the client its ring buffer rolled past
//     the requested `Last-Event-ID`; client refetches /transcript.
//
// The wire is deliberately a different concern from `AgentEvent`. Keeping
// `phase` and `resync` on the wire (and out of `AgentEvent`) means the
// agent core stays untouched.

import type { AgentEvent, UserMessage } from "../types.ts";

export const SSE_EVENT_NAME = "agent";

/** Event types added on the wire that aren't part of `AgentEvent`. */
export type WirePhaseEvent = {
  kind: "phase";
  phase: "generating" | "running";
  stepIndex: number;
};

export type WireResyncEvent = {
  kind: "resync";
  /** Why a resync is needed. "ring_rolled" is the common cause. */
  reason: "ring_rolled";
};

export type WireEvent = AgentEvent | WirePhaseEvent | WireResyncEvent;

export interface WireFrame {
  seq: number;
  event: WireEvent;
}

/** Encode a frame as an SSE event block. Includes the `id:` field so the
 *  browser will echo it back as `Last-Event-ID` on reconnect. */
export function encodeSSE(frame: WireFrame): string {
  // SSE: each block ends with a blank line. We avoid embedded newlines in
  // `data:` by JSON-encoding the whole payload onto a single line.
  const data = JSON.stringify(frame);
  return `event: ${SSE_EVENT_NAME}\nid: ${frame.seq}\ndata: ${data}\n\n`;
}

/** Heartbeat comment to keep proxies from closing idle SSE connections.
 *  SSE comments start with `:` and are ignored by clients. */
export function encodeHeartbeat(): string {
  return `: heartbeat ${Date.now()}\n\n`;
}

/** Parse an inbound POST body as a `UserMessage`. Throws on malformed input.
 *  Kept strict so a misbehaving client surfaces an error rather than silently
 *  sending an empty turn. */
export function parseInboundMessage(body: unknown): UserMessage {
  if (!body || typeof body !== "object") {
    throw new Error("inbound message: expected object");
  }
  const o = body as Record<string, unknown>;
  if (o.kind !== "user_message") {
    throw new Error(`inbound message: expected kind="user_message" (got ${String(o.kind)})`);
  }
  if (typeof o.content !== "string" || o.content.length === 0) {
    throw new Error("inbound message: `content` must be a non-empty string");
  }
  return { kind: "user_message", content: o.content };
}

/** Parsed `Last-Event-ID` from an SSE reconnect, or null if absent / invalid. */
export function parseLastEventId(headerValue: string | null): number | null {
  if (headerValue === null) return null;
  const n = Number(headerValue);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}
