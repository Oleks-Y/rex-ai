# Guardrails

Lightweight policy layer that inspects each sandbox step and can veto an event
(reply / abort / reflect / permission_denied / throw) before it propagates to
the host. Every guardrail is its own LLM call against a model the caller picks;
the call gets a rendered audit log of the conversation so far.

## TL;DR

| # | Severity | Title                                | Schema change | Code surface |
|---|----------|--------------------------------------|---------------|--------------|
| 1 | P1       | Trigger model + Guardrail definition | none          | new `src/guardrail.ts` |
| 2 | P1       | Per-step guardrail eval hook         | none          | `src/agent.ts`, `src/agent_session.ts` |
| 3 | P2       | Audit log builder w/ log truncation  | none          | `src/guardrail.ts` |
| 4 | P2       | Public surface + tests + example     | none          | `src/mod.ts`, tests, example |

## Component map

```
                  Sandbox returns event
                          │
                          ▼
            ┌───────────────────────────┐
            │ GuardrailRunner.evaluate  │  ← runs only if guardrails.length > 0
            │ filters by event.kind     │
            │ runs each matching one    │
            │ stops at first block      │
            └───────────────────────────┘
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
         allowed                      blocked (non-terminal)
            │                           │
            ▼                           ▼
   append transcript        REPLACE with `guardrail_blocked` step
   onStep(event)            (carries original payload + reason + logs)
   return event             append transcript, onStep, push to priorSteps,
                            loop another step so the model can revise
```

## 1. P1 · Trigger model + Guardrail definition

Triggers are SandboxEvent kinds plus a catch-all `"any"`:

```ts
type GuardrailTrigger =
  | "reply" | "abort" | "reflect"
  | "permission_denied" | "throw" | "any";

interface GuardrailDefinition {
  name: string;
  triggers: GuardrailTrigger[];
  model: LanguageModelV2;
  instructions: string;
  /** Per-step logs byte budget rendered to audit doc. Default 4 KiB. */
  maxLogsBytesPerStep?: number;
  /** Per reflect-state / abort-error / reply-message rendered length. Default 4 KiB. */
  maxEventBytes?: number;
  /** If the guardrail model call or output parse fails, allow the event. Default true. */
  passOnError?: boolean;
}

function defineGuardrail(g: GuardrailDefinition): GuardrailDefinition;
```

## 2. P1 · Per-step guardrail evaluation hook

Both `agent.ts` `#runOneStep` and `agent_session.ts` `#runOneStep` run the same
post-sandbox sequence:

```
sandbox.run → guardrail.evaluate → transcript.append → onStep → return
```

Block translates the event to a NON-TERMINAL `guardrail_blocked` event that
preserves the original payload for debugging and prompt context:

```ts
{
  kind: "guardrail_blocked",
  guardrail: "<name>",
  reason: "<reason>",
  originalKind: ev.kind,          // denormalized for ergonomics
  original: <ev minus logs>,      // full payload of the blocked event
  logs: ev.logs,
}
```

The loop pushes this to `priorSteps` and runs another step so the model can
revise. Every evaluation (allow or block) is forwarded to `onGuardrail` for
observability.

## 3. P2 · Audit log builder

Mirror of `prompt.ts` priorStepsBlock — same render style so the guardrail
sees the same step shape the agent does, but with logs truncated.

Per step, logs are joined and clipped to `maxLogsBytesPerStep` (default 4 KiB).
Reflect state / reply message / abort error get serialized with
`JSON.stringify` then clipped to `maxEventBytes`.

The current (under-evaluation) step is rendered last under a
`### CURRENT STEP (under review)` heading so the guardrail prompt makes the
distinction obvious.

The trailing prompt asks the guardrail model to respond with a single JSON
object: `{"ok": true}` or `{"ok": false, "reason": "..."}`.

## 4. P2 · Public surface

- `src/mod.ts` re-exports `defineGuardrail`, `GuardrailDefinition`,
  `GuardrailTrigger`, `GuardrailEvaluation`, `GuardrailVerdict`.
- `AgentOptions` gains `guardrails?: GuardrailDefinition[]` and
  `onGuardrail?: (ev: GuardrailEvaluation, stepIndex: number) => void`.

## Execution

```
[ guardrails module + tests ]
            ↓
[ wire into Agent (#runPerStep) + tests ]
            ↓
[ wire into AgentSession + tests ]
            ↓
[ export from mod.ts + example ]
```

## Open questions

| # | Question | Recommended |
|---|----------|-------------|
| 1 | Should guardrails see logs verbatim or summarized? | Verbatim, truncated to fixed byte budget — JSON-stringify is good enough |
| 2 | Block behavior on multiple guardrails? | First block wins; remaining guardrails are not called |
| 3 | Block on reflect — abort or fall through to reply? | Replace with non-terminal `guardrail_blocked` so the agent can revise the plan |
| 4 | Block on abort — let abort through or alter? | Replace with non-terminal `guardrail_blocked` (caller sees that policy intervened; loop keeps going so model can route around the failed approach) |
| 5 | Parse-fail policy? | Pass-by-default with `passOnError: true`; surface the eval error on `GuardrailEvaluation.evaluationError` |
