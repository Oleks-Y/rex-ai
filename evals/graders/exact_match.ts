// Exact-match grader. Smolagents-style normalization.

import type { GraderConfig } from "../types.ts";

export function normalize(s: string, mode: "strict" | "loose" = "loose"): string {
  if (mode === "strict") return s.trim();
  return s
    .toLowerCase()
    .replace(/[$%,;]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}

export function gradeExactMatch(reply: string, cfg: GraderConfig): number {
  const expected = cfg.expected;
  if (expected === undefined) {
    throw new Error("exact_match grader requires `expected`");
  }
  const mode = cfg.normalize ?? "loose";
  const got = normalize(reply, mode);
  const expectedList = Array.isArray(expected)
    ? (expected as unknown[]).map(String)
    : [String(expected)];
  for (const e of expectedList) {
    if (normalize(e, mode) === got) return 1;
  }
  // For "loose" mode, also accept substring containment — handles cases
  // where the model wraps the answer in a sentence.
  if (mode === "loose") {
    for (const e of expectedList) {
      if (got.includes(normalize(e, mode))) return 1;
    }
  }
  return 0;
}
