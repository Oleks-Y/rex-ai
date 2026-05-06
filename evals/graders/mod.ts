// Grader dispatch — pure (sync) graders return a number; the LLM judge
// is async and returns extra rationale + cost metadata.

import type { GraderConfig } from "../types.ts";
import { gradeExactMatch } from "./exact_match.ts";
import { gradeNumericMatch } from "./numeric_match.ts";
import { gradeJsonMatch } from "./json_match.ts";
import { gradeRegexMatch } from "./regex_match.ts";
import { gradeLlmJudge, type JudgeOutput } from "./llm_judge.ts";

export interface GradeResult {
  score: number;
  rationale?: string;
  judgeTokensIn?: number;
  judgeTokensOut?: number;
}

export async function grade(
  task: string,
  reply: string,
  cfg: GraderConfig,
): Promise<GradeResult> {
  switch (cfg.type) {
    case "exact_match":
      return { score: gradeExactMatch(reply, cfg) };
    case "numeric_match":
      return { score: gradeNumericMatch(reply, cfg) };
    case "json_match":
      return { score: gradeJsonMatch(reply, cfg) };
    case "regex_match":
      return { score: gradeRegexMatch(reply, cfg) };
    case "llm_judge": {
      const j: JudgeOutput = await gradeLlmJudge(task, reply, cfg);
      return {
        score: j.score,
        rationale: j.rationale,
        judgeTokensIn: j.tokensIn,
        judgeTokensOut: j.tokensOut,
      };
    }
  }
}
