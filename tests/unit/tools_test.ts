import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../../src/tools.ts";
import { RESERVED_NAMES } from "../../src/types.ts";

const fetchIssues = defineTool({
  name: "fetchIssues",
  description: "Fetch issues for a repo.",
  schema: z.object({
    repo: z.string(),
    limit: z.number().int().positive().default(10),
  }),
  handler: ({ repo, limit }) => [{ id: 1, repo, limit }],
});

Deno.test("constructor: rejects each reserved name", () => {
  for (const name of RESERVED_NAMES) {
    assertThrows(
      () => new ToolRegistry([{ ...fetchIssues, name }]),
      Error,
      "reserved",
    );
  }
});

Deno.test("constructor: rejects duplicates", () => {
  assertThrows(
    () => new ToolRegistry([fetchIssues, { ...fetchIssues }]),
    Error,
    "duplicate",
  );
});

Deno.test("constructor: rejects non-identifier names", () => {
  assertThrows(
    () => new ToolRegistry([{ ...fetchIssues, name: "fetch-issues" }]),
    Error,
    "identifier",
  );
  assertThrows(
    () => new ToolRegistry([{ ...fetchIssues, name: "1bad" }]),
    Error,
    "identifier",
  );
  assertThrows(
    () => new ToolRegistry([{ ...fetchIssues, name: "" }]),
    Error,
    "non-empty",
  );
});

Deno.test("describe: returns name/description/schema/tsSignature", () => {
  const reg = new ToolRegistry([{ ...fetchIssues, tsSignature: "(args: { repo: string }): any" }]);
  const d = reg.describe();
  assertEquals(d.length, 1);
  assertEquals(d[0].name, "fetchIssues");
  assertEquals(d[0].tsSignature, "(args: { repo: string }): any");
});

Deno.test("call: unknown tool returns failure (does not throw)", async () => {
  const reg = new ToolRegistry([fetchIssues]);
  const r = await reg.call("nope", {}, { maxResultBytes: 1024 });
  assertEquals(r.ok, false);
  assertStringIncludes(r.ok ? "" : r.error, "unknown tool");
});

Deno.test("call: validation failure returns issues, not handler call", async () => {
  let handlerCalled = false;
  const reg = new ToolRegistry([{
    ...fetchIssues,
    handler: () => {
      handlerCalled = true;
      return [];
    },
  }]);
  const r = await reg.call("fetchIssues", { repo: 123 }, { maxResultBytes: 1024 });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertStringIncludes(r.error, "invalid arguments for fetchIssues");
    assertEquals(Array.isArray(r.issues), true);
  }
  assertEquals(handlerCalled, false);
});

Deno.test("call: successful invocation returns plain JSON value", async () => {
  const reg = new ToolRegistry([fetchIssues]);
  const r = await reg.call("fetchIssues", { repo: "a/b" }, { maxResultBytes: 1024 });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value, [{ id: 1, repo: "a/b", limit: 10 }]);
});

Deno.test("call: handler throw is caught and surfaced", async () => {
  const reg = new ToolRegistry([{
    ...fetchIssues,
    handler: () => {
      throw new TypeError("nope");
    },
  }]);
  const r = await reg.call("fetchIssues", { repo: "x" }, { maxResultBytes: 1024 });
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.error, "TypeError: nope");
});

Deno.test("call: oversize result rejected with ToolResultTooLargeError-shaped error", async () => {
  const big = "x".repeat(2000);
  const reg = new ToolRegistry([{
    name: "big",
    description: "",
    schema: z.object({}),
    handler: () => ({ payload: big }),
  }]);
  const r = await reg.call("big", {}, { maxResultBytes: 100 });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertStringIncludes(r.error, "ToolResultTooLargeError");
    assertStringIncludes(r.error, "cap 100");
  }
});

Deno.test("call: handler returning undefined comes back as null (round-trippable)", async () => {
  const reg = new ToolRegistry([{
    name: "noop",
    description: "",
    schema: z.object({}),
    handler: () => undefined,
  }]);
  const r = await reg.call("noop", {}, { maxResultBytes: 1024 });
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.value, null);
});

Deno.test("call: BigInt return value rejected as non-serializable", async () => {
  const reg = new ToolRegistry([{
    name: "bignum",
    description: "",
    schema: z.object({}),
    handler: () => ({ x: 1n }),
  }]);
  const r = await reg.call("bignum", {}, { maxResultBytes: 1024 });
  assertEquals(r.ok, false);
  if (!r.ok) assertStringIncludes(r.error, "non-JSON-serializable");
});

Deno.test("has / names reflect registered tools", () => {
  const reg = new ToolRegistry([fetchIssues]);
  assertEquals(reg.has("fetchIssues"), true);
  assertEquals(reg.has("missing"), false);
  assertEquals(reg.names(), ["fetchIssues"]);
});
