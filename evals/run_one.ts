// Single-task runner — exported separately so tests can inject a fake model.
//
// Returns one fully-formed RunResultRow ready to write to JSONL. Pure
// orchestration — does not write to disk and does not enforce the budget.

import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { StepRecord } from "../src/types.ts";
import type { FinishReason, RunResultRow, TaskDef, TrajectoryStep } from "./types.ts";
import { buildAgent } from "./agents/mod.ts";
import { grade } from "./graders/mod.ts";
import { estimateCostUsd, MODELS } from "./models.ts";

export interface RunOneArgs {
  layer: "l1" | "l2";
  source: string;
  task: TaskDef;
  modelAlias: string;
  /** Test override — bypass the model registry. When set, `modelAlias` is
   *  recorded as-is in the JSONL but isn't resolved to a real provider. */
  modelOverride?: LanguageModelV2;
  seed: number;
  runId: string;
  rexAiCommit: string;
  defaultAgent?: string;
}

function summarizeStep(s: StepRecord): unknown {
  const ev = s.event;
  const t = (str: string, n = 200) => str.length > n ? str.slice(0, n) + "…" : str;
  switch (ev.kind) {
    case "reply":
      return { kind: "reply", message: t(ev.message) };
    case "abort":
      return { kind: "abort", error: t(ev.error) };
    case "reflect":
      return { kind: "reflect" };
    case "permission_denied":
      return {
        kind: "permission_denied",
        permission: ev.permission,
        target: ev.target,
      };
    case "throw":
      return { kind: "throw", error: t(ev.error) };
  }
}

export async function runOne(args: RunOneArgs): Promise<RunResultRow> {
  const { task, modelAlias, seed } = args;
  const trajectory: TrajectoryStep[] = [];
  const onStep = (s: StepRecord) => {
    trajectory.push({
      step: s.index,
      code: s.code,
      observation: summarizeStep(s),
    });
  };
  const agentName = task.agent ?? args.defaultAgent ?? "generic";
  const t0 = performance.now();
  let reply = "";
  let finish: FinishReason = "error";
  let errMsg: string | undefined;
  try {
    const agent = buildAgent({
      agent: agentName,
      modelAlias,
      task: task.task,
      maxSteps: task.max_steps,
      onStep,
      modelOverride: args.modelOverride,
      allowHosts: task.permissions?.allowHosts,
    });
    const result = await agent.run();
    finish = result.kind;
    if (result.kind === "reply") {
      reply = result.message;
    } else if (result.kind === "abort") {
      errMsg = result.error;
      // Surface the abort reason to the grader. Tasks that want to test
      // "agent should abort with reason X" can use exact_match / regex /
      // llm_judge against the "ABORT: <reason>" string.
      reply = `ABORT: ${result.error}`;
    } else if (result.kind === "exhausted") {
      reply = `EXHAUSTED: ${result.steps} steps`;
    }
  } catch (e) {
    finish = "error";
    errMsg = (e as Error).message;
  }
  const wallMs = Math.round(performance.now() - t0);

  // Token + cost estimate. Until we plumb usage out of the agent loop,
  // approximate from trajectory size (4 chars/token).
  const traffic = trajectory.reduce(
    (acc, s) =>
      acc + (s.code?.length ?? 0) +
      JSON.stringify(s.observation ?? null).length,
    0,
  );
  const tokensIn = Math.round(traffic / 4);
  const tokensOut = Math.round(reply.length / 4) + Math.round(tokensIn / 4);
  const agentCost = estimateCostUsd(modelAlias, tokensIn, tokensOut);

  let score = 0;
  let rationale: string | undefined;
  let judgeIn = 0;
  let judgeOut = 0;
  try {
    const g = await grade(task.task, reply, task.grader);
    score = g.score;
    rationale = g.rationale;
    judgeIn = g.judgeTokensIn ?? 0;
    judgeOut = g.judgeTokensOut ?? 0;
  } catch (e) {
    errMsg = (errMsg ? errMsg + " | " : "") + `grader: ${(e as Error).message}`;
  }
  const judgeCost = estimateCostUsd("claude-haiku-4-5", judgeIn, judgeOut);

  const recordedModel = MODELS[modelAlias]?.id ?? modelAlias;

  return {
    run_id: args.runId,
    layer: args.layer,
    source: args.source,
    task_id: task.id,
    seed,
    model: recordedModel,
    agent: agentName,
    score,
    grader_type: task.grader.type,
    judge_rationale: rationale,
    reply,
    trajectory,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: agentCost + judgeCost,
    steps: trajectory.length,
    wall_ms: wallMs,
    error: errMsg,
    finish_reason: finish,
    rex_ai_commit: args.rexAiCommit,
    ts: new Date().toISOString(),
  };
}
