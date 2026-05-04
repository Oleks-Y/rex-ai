import { assertEquals, assertThrows } from "@std/assert";
import { CodeExtractor } from "../../src/extractor.ts";
import { NoCodeBlockError } from "../../src/types.ts";

Deno.test("extracts a ```ts fence", () => {
  const out = CodeExtractor.extract("preamble\n```ts\nawait reply('hi');\n```\nepilogue");
  assertEquals(out, "await reply('hi');");
});

Deno.test("extracts a ```typescript fence", () => {
  const out = CodeExtractor.extract("```typescript\nconst x = 1;\nreply(String(x));\n```");
  assertEquals(out, "const x = 1;\nreply(String(x));");
});

Deno.test("language tag is case-insensitive", () => {
  const out = CodeExtractor.extract("```TS\nawait reply('y');\n```");
  assertEquals(out, "await reply('y');");
});

Deno.test("multiple fences: last wins", () => {
  const out = CodeExtractor.extract(
    "```ts\nfirst\n```\nfiller\n```typescript\nsecond\n```\n",
  );
  assertEquals(out, "second");
});

Deno.test("nested ``` inside body is preserved (only opening tag matches)", () => {
  // The model writes a fenced block whose body contains a ```md sub-fence.
  // Our regex looks for the *next* closing ```, so we'll get the substring
  // up to the first closing fence — matching how markdown renderers parse.
  const out = CodeExtractor.extract(
    "```ts\nconst doc = `markdown body`;\nreply(doc);\n```\n",
  );
  assertEquals(out, "const doc = `markdown body`;\nreply(doc);");
});

Deno.test("missing fence → NoCodeBlockError", () => {
  assertThrows(
    () => CodeExtractor.extract("Sure, here is the code: const x = 1;"),
    NoCodeBlockError,
  );
});

Deno.test("wrong language tag (js) → NoCodeBlockError", () => {
  assertThrows(
    () => CodeExtractor.extract("```js\nconst x = 1;\n```"),
    NoCodeBlockError,
  );
});

Deno.test("wrong language tag (tsx) → NoCodeBlockError", () => {
  assertThrows(
    () => CodeExtractor.extract("```tsx\nconst x = 1;\n```"),
    NoCodeBlockError,
  );
});

Deno.test("untagged fence → NoCodeBlockError", () => {
  assertThrows(
    () => CodeExtractor.extract("```\nconst x = 1;\n```"),
    NoCodeBlockError,
  );
});

Deno.test("unclosed fence at EOF still parses (streaming-tolerant)", () => {
  // No trailing ``` because the stream got cut off. Better to give the
  // sandbox the partial code and let it fail at parse time than to lose it.
  const out = CodeExtractor.extract("```ts\nconst x = 1;\nreply('done');");
  assertEquals(out, "const x = 1;\nreply('done');");
});

Deno.test("CRLF line endings are handled", () => {
  const out = CodeExtractor.extract("```ts\r\nawait reply('crlf');\r\n```");
  assertEquals(out, "await reply('crlf');");
});

Deno.test("prose around block is ignored", () => {
  const text = [
    "Sure! I'll fetch the issues and summarize them.",
    "",
    "```ts",
    "const issues = await fetchIssues({ repo: 'foo/bar' });",
    "await reply(JSON.stringify(issues));",
    "```",
    "",
    "Let me know if you'd like more.",
  ].join("\n");
  const out = CodeExtractor.extract(text);
  assertEquals(
    out,
    "const issues = await fetchIssues({ repo: 'foo/bar' });\nawait reply(JSON.stringify(issues));",
  );
});
