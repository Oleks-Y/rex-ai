// Regex grader — answer must match `pattern`.

import type { GraderConfig } from "../types.ts";

export function gradeRegexMatch(reply: string, cfg: GraderConfig): number {
  if (!cfg.pattern) throw new Error("regex_match requires `pattern`");
  const re = new RegExp(cfg.pattern, cfg.flags ?? "");
  return re.test(reply) ? 1 : 0;
}
