// Unit tests for graders. Hits no network and no LLM (excludes llm_judge).

import { assertEquals } from "@std/assert";
import { gradeExactMatch, normalize } from "../../graders/exact_match.ts";
import { extractLastNumber, gradeNumericMatch } from "../../graders/numeric_match.ts";
import { extractJson, gradeJsonMatch } from "../../graders/json_match.ts";
import { gradeRegexMatch } from "../../graders/regex_match.ts";

// ── exact_match ─────────────────────────────────────────────────────────

Deno.test("exact_match: trivial loose match", () => {
  assertEquals(
    gradeExactMatch("Paris", { type: "exact_match", expected: "paris" }),
    1,
  );
});

Deno.test("exact_match: substring containment in loose mode", () => {
  assertEquals(
    gradeExactMatch("The answer is Paris.", {
      type: "exact_match",
      expected: "Paris",
    }),
    1,
  );
});

Deno.test("exact_match: strict mode rejects substring", () => {
  assertEquals(
    gradeExactMatch("The answer is Paris.", {
      type: "exact_match",
      expected: "Paris",
      normalize: "strict",
    }),
    0,
  );
});

Deno.test("exact_match: list of accepted answers", () => {
  assertEquals(
    gradeExactMatch("yes", { type: "exact_match", expected: ["yep", "yes", "y"] }),
    1,
  );
});

Deno.test("normalize: drops punctuation + lowercases", () => {
  assertEquals(normalize("$1,234.56!"), "1234.56");
  assertEquals(normalize("Paris."), "paris");
  assertEquals(normalize("  HELLO; world  "), "hello world");
});

// ── numeric_match ───────────────────────────────────────────────────────

Deno.test("numeric_match: extract last number", () => {
  assertEquals(extractLastNumber("Step 1: 10. Step 2: 42"), 42);
  assertEquals(extractLastNumber("no numbers here"), null);
  assertEquals(extractLastNumber("answer: -3.14"), -3.14);
});

Deno.test("numeric_match: == op", () => {
  assertEquals(
    gradeNumericMatch("answer is 42", { type: "numeric_match", expected: 42 }),
    1,
  );
  assertEquals(
    gradeNumericMatch("answer is 41", { type: "numeric_match", expected: 42 }),
    0,
  );
});

Deno.test("numeric_match: tolerance", () => {
  assertEquals(
    gradeNumericMatch("3.14159", {
      type: "numeric_match",
      expected: 3.14,
      tolerance: 0.01,
    }),
    1,
  );
});

Deno.test("numeric_match: range", () => {
  assertEquals(
    gradeNumericMatch("the count is 47", {
      type: "numeric_match",
      op: "range",
      range: [40, 50],
    }),
    1,
  );
  assertEquals(
    gradeNumericMatch("the count is 60", {
      type: "numeric_match",
      op: "range",
      range: [40, 50],
    }),
    0,
  );
});

// ── json_match ──────────────────────────────────────────────────────────

Deno.test("json_match: deep equal", () => {
  assertEquals(
    gradeJsonMatch('{"a":1,"b":2}', {
      type: "json_match",
      expected: { a: 1, b: 2 },
    }),
    1,
  );
});

Deno.test("json_match: subset", () => {
  assertEquals(
    gradeJsonMatch('{"a":1,"b":2,"extra":99}', {
      type: "json_match",
      subset: true,
      expected: { a: 1 },
    }),
    1,
  );
});

Deno.test("json_match: subset rejects missing key", () => {
  assertEquals(
    gradeJsonMatch('{"a":1}', {
      type: "json_match",
      subset: true,
      expected: { a: 1, b: 2 },
    }),
    0,
  );
});

Deno.test("extractJson: from fenced block", () => {
  const out = extractJson('here is the answer:\n```json\n{"x":7}\n```\n');
  assertEquals(out, { x: 7 });
});

Deno.test("extractJson: from substring", () => {
  const out = extractJson('result: {"y":3} done');
  assertEquals(out, { y: 3 });
});

// ── regex_match ─────────────────────────────────────────────────────────

Deno.test("regex_match: basic", () => {
  assertEquals(
    gradeRegexMatch("the user count is 14523", {
      type: "regex_match",
      pattern: "user count is \\d+",
    }),
    1,
  );
  assertEquals(
    gradeRegexMatch("nope", {
      type: "regex_match",
      pattern: "user count is \\d+",
    }),
    0,
  );
});

Deno.test("regex_match: case-insensitive flag", () => {
  assertEquals(
    gradeRegexMatch("Paris", {
      type: "regex_match",
      pattern: "paris",
      flags: "i",
    }),
    1,
  );
});
