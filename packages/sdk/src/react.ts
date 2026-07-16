// useRexChat — React hook that reduces wire events into chat-shape state.
//
// Reducer rules (mirrors docs/plans/frontend-chat-sdk.md §4):
//   step (any kind)        → not visible in `messages` (lives in `events`)
//   reply                  → append assistant message
//   abort / exhausted      → append assistant message with `error`
//   guardrail_blocked step → push onto `guardrails`, status="running"
//   wakeup_*               → no `messages` effect
//   phase (wire-only)      → drives `status` (thinking / running)
//   session_closed         → status="closed"
//
// `messages` carries user + assistant turns in a single ordered list.
// `events` carries the raw wire stream for devtools panels.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RexClient } from "./client";
import type {
  AgentEvent,
  ChatMessage,
  ChatStatus,
  GuardrailBlock,
  WireEvent,
} from "./types";

export interface UseRexChatOptions {
  client: RexClient;
  /** First task sent to the agent; opens the session on mount. If omitted,
   *  caller is responsible for `client.open()`. */
  initialTask?: string;
  /** Cap on `events` (the raw wire log). `messages` is never truncated.
   *  Default 1000. */
  maxEventsBuffered?: number;
}

export interface UseRexChatResult {
  messages: ChatMessage[];
  status: ChatStatus;
  send: (content: string) => void;
  events: WireEvent[];
  guardrails: GuardrailBlock[];
  error: Error | null;
  sessionId: string | null;
}

export function useRexChat(opts: UseRexChatOptions): UseRexChatResult {
  const { client, initialTask, maxEventsBuffered = 1000 } = opts;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailBlock[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Track ongoing assistant-turn step range so the assembled message can
  // point at the right step indices for devtools deep-linking.
  const turnStartStep = useRef<number | null>(null);

  // Single subscription lifecycle. Re-runs only if the client identity
  // changes (rare — usually stable for the component's lifetime).
  useEffect(() => {
    let cancelled = false;

    const startup = async () => {
      try {
        if (initialTask && client.sessionId === null) {
          setStatus("connecting");
          const { sessionId: sid } = await client.open(initialTask);
          if (cancelled) return;
          setSessionId(sid);
          // The initial task IS the first user message — render it.
          setMessages((m) => [
            ...m,
            makeMsg("user", initialTask),
          ]);
          setStatus("thinking");
        }

        for await (const ev of client.events()) {
          if (cancelled) return;
          applyEvent(ev, {
            setMessages,
            setStatus,
            setEvents,
            setGuardrails,
            turnStartStep,
            maxEventsBuffered,
          });
        }
        if (!cancelled) setStatus("closed");
      } catch (e) {
        if (cancelled) return;
        setError(e as Error);
        setStatus("error");
      }
    };

    void startup();

    return () => {
      cancelled = true;
    };
  }, [client, initialTask, maxEventsBuffered]);

  const send = useCallback((content: string) => {
    if (!content.trim()) return;
    setMessages((m) => [...m, makeMsg("user", content)]);
    setStatus("thinking");
    client.send(content);
  }, [client]);

  return useMemo(
    () => ({ messages, status, send, events, guardrails, error, sessionId }),
    [messages, status, send, events, guardrails, error, sessionId],
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Internal reducer
// ────────────────────────────────────────────────────────────────────────────

interface ApplyCtx {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setStatus: React.Dispatch<React.SetStateAction<ChatStatus>>;
  setEvents: React.Dispatch<React.SetStateAction<WireEvent[]>>;
  setGuardrails: React.Dispatch<React.SetStateAction<GuardrailBlock[]>>;
  turnStartStep: React.MutableRefObject<number | null>;
  maxEventsBuffered: number;
}

function applyEvent(ev: WireEvent, ctx: ApplyCtx): void {
  // Always log the raw event for devtools (capped at maxEventsBuffered).
  ctx.setEvents((existing) => {
    const next = existing.length >= ctx.maxEventsBuffered
      ? existing.slice(existing.length - ctx.maxEventsBuffered + 1)
      : existing;
    return [...next, ev];
  });

  switch (ev.kind) {
    case "phase":
      ctx.setStatus(ev.phase === "generating" ? "thinking" : "running");
      return;

    case "resync":
      // v0: surface as an error indicator. Future: refetch /transcript.
      ctx.setStatus("error");
      return;

    case "step": {
      if (ctx.turnStartStep.current === null) {
        ctx.turnStartStep.current = ev.index;
      }
      if (ev.event.kind === "guardrail_blocked") {
        ctx.setGuardrails((g) => [
          ...g,
          {
            guardrail: ev.event.kind === "guardrail_blocked"
              ? ev.event.guardrail
              : "",
            reason: ev.event.kind === "guardrail_blocked"
              ? ev.event.reason
              : "",
            stepIndex: ev.index,
            at: Date.now(),
          },
        ]);
      }
      return;
    }

    case "reply": {
      const startStep = ctx.turnStartStep.current ?? 0;
      ctx.turnStartStep.current = null;
      const msg = makeMsg("assistant", ev.message);
      msg.stepRange = [startStep, startStep];
      ctx.setMessages((m) => [...m, msg]);
      ctx.setStatus("idle");
      return;
    }

    case "abort": {
      ctx.turnStartStep.current = null;
      const msg = makeMsg("assistant", ev.error);
      msg.error = "abort";
      ctx.setMessages((m) => [...m, msg]);
      ctx.setStatus("error");
      return;
    }

    case "exhausted": {
      ctx.turnStartStep.current = null;
      const msg = makeMsg(
        "assistant",
        `Agent reached its step cap (${ev.steps} steps) without replying.`,
      );
      msg.error = "exhausted";
      ctx.setMessages((m) => [...m, msg]);
      ctx.setStatus("error");
      return;
    }

    case "session_closed":
      ctx.setStatus("closed");
      return;

    case "wakeup_scheduled":
    case "wakeup_resolved":
    case "wakeup_rejected":
    case "wakeup_cancelled":
      // No effect on `messages`; visible in `events` only.
      return;
  }

  // Exhaustiveness: types we don't model here are non-fatal.
  const _: AgentEvent | { kind: "phase" } | { kind: "resync" } = ev;
  void _;
}

function makeMsg(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: cryptoRandomId(),
    role,
    content,
    createdAt: Date.now(),
  };
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
