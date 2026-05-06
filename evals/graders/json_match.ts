// JSON-structural grader. Parses the reply (or the last code-fenced
// JSON block within it) and deep-compares against `expected`.
//
// `subset: true` means "every key/value in expected must appear in got"
// — useful when the model returns extra metadata fields.

import type { GraderConfig } from "../types.ts";

function tryParseJson(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function extractJson(reply: string): unknown | undefined {
  // 1. Whole reply.
  const direct = tryParseJson(reply.trim());
  if (direct !== undefined) return direct;
  // 2. ```json ... ``` block.
  const fence = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const inner = tryParseJson(fence[1].trim());
    if (inner !== undefined) return inner;
  }
  // 3. First {...} or [...] substring.
  const obj = reply.match(/\{[\s\S]*\}/);
  if (obj) {
    const parsed = tryParseJson(obj[0]);
    if (parsed !== undefined) return parsed;
  }
  const arr = reply.match(/\[[\s\S]*\]/);
  if (arr) return tryParseJson(arr[0]);
  return undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length) return false;
    if (!ak.every((k, i) => k === bk[i])) return false;
    return ak.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    );
  }
  return false;
}

function isSubset(expected: unknown, got: unknown): boolean {
  if (expected === got) return true;
  if (Array.isArray(expected)) {
    if (!Array.isArray(got)) return false;
    return expected.every((e) => got.some((g) => isSubset(e, g)));
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof got !== "object" || got === null) return false;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
      isSubset(v, (got as Record<string, unknown>)[k])
    );
  }
  return deepEqual(expected, got);
}

export function gradeJsonMatch(reply: string, cfg: GraderConfig): number {
  if (cfg.expected === undefined) {
    throw new Error("json_match requires `expected`");
  }
  const got = extractJson(reply);
  if (got === undefined) return 0;
  const expected = typeof cfg.expected === "string"
    ? tryParseJson(cfg.expected) ?? cfg.expected
    : cfg.expected;
  if (cfg.subset) return isSubset(expected, got) ? 1 : 0;
  return deepEqual(expected, got) ? 1 : 0;
}
