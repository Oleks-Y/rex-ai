// LLM-as-judge grader. Uses a *pinned* judge model + a strict-JSON rubric.
// The judge's rationale is logged into the JSONL row for debugging.

import { generateText } from "ai";
import type { GraderConfig } from "../types.ts";
import { extractJson } from "./json_match.ts";
import { JUDGE_MODEL_ALIAS, resolveModel } from "../models.ts";

export interface JudgeOutput {
  score: number;
  rationale: string;
  /** Tokens used by the judge. Charged separately from the agent run. */
  tokensIn: number;
  tokensOut: number;
}

const PROMPT = (task: string, reply: string, rubric: string) =>
  `You are grading an agent's answer to a task.

Task:
${task}

Agent reply:
${reply}

Rubric:
${rubric}

Respond with strict JSON only, no prose, in this exact shape:
{"score": 0 | 1, "rationale": "<one short sentence>"}`;

export async function gradeLlmJudge(
  task: string,
  reply: string,
  cfg: GraderConfig,
): Promise<JudgeOutput> {
  if (!cfg.rubric) throw new Error("llm_judge requires `rubric`");
  const { model } = resolveModel(JUDGE_MODEL_ALIAS);
  const result = await generateText({
    model,
    prompt: PROMPT(task, reply, cfg.rubric),
  });
  const parsed = extractJson(result.text) as
    | { score?: number; rationale?: string }
    | undefined;
  const score = parsed && typeof parsed.score === "number" ? parsed.score === 1 ? 1 : 0 : 0;
  const rationale = parsed && typeof parsed.rationale === "string"
    ? parsed.rationale
    : "(judge returned no rationale)";
  // deno-lint-ignore no-explicit-any
  const usage = (result as any).usage ?? {};
  const tokensIn = Number(usage.promptTokens ?? usage.inputTokens ?? 0);
  const tokensOut = Number(usage.completionTokens ?? usage.outputTokens ?? 0);
  return { score, rationale, tokensIn, tokensOut };
}
