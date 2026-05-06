// Numeric grader. Pulls the last number out of a freeform reply and
// compares against `expected` per `op`.

import type { GraderConfig } from "../types.ts";

const NUM_RE = /-?\d+(?:\.\d+)?/g;

export function extractLastNumber(s: string): number | null {
  const matches = s.match(NUM_RE);
  if (!matches || matches.length === 0) return null;
  const n = Number(matches[matches.length - 1]);
  return Number.isFinite(n) ? n : null;
}

export function gradeNumericMatch(reply: string, cfg: GraderConfig): number {
  const got = extractLastNumber(reply);
  if (got === null) return 0;
  const op = cfg.op ?? "==";
  const tol = cfg.tolerance ?? 0;
  if (op === "range") {
    if (!cfg.range) throw new Error("numeric_match op=range requires `range`");
    const [lo, hi] = cfg.range;
    return got >= lo && got <= hi ? 1 : 0;
  }
  const expected = typeof cfg.expected === "number" ? cfg.expected : Number(cfg.expected);
  if (!Number.isFinite(expected)) {
    throw new Error("numeric_match requires numeric `expected`");
  }
  switch (op) {
    case "==":
      return Math.abs(got - expected) <= tol ? 1 : 0;
    case ">=":
      return got >= expected - tol ? 1 : 0;
    case "<=":
      return got <= expected + tol ? 1 : 0;
  }
}
