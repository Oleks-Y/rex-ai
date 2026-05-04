import { assertEquals, assertStringIncludes } from "@std/assert";
import { ModuleGuard } from "../../src/module_guard.ts";

function scan(source: string, allowed: string[] = []) {
  return ModuleGuard.scan({ source, allowed });
}

Deno.test("no imports → ok", () => {
  const r = scan("await reply('hi');");
  assertEquals(r.ok, true);
});

Deno.test("static import in allowlist → ok", () => {
  const r = scan('import { foo } from "jsr:@std/encoding";', ["jsr:@std/encoding"]);
  assertEquals(r.ok, true);
});

Deno.test("static import NOT in allowlist → reject", () => {
  const r = scan('import { spawn } from "node:child_process";', ["jsr:@std/encoding"]);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason!, "node:child_process");
  assertStringIncludes(r.reason!, "not in allowlist");
});

Deno.test("session:lib is always allowed (even with empty allowlist)", () => {
  const r = scan('import { helper } from "session:lib";', []);
  assertEquals(r.ok, true);
});

Deno.test("relative import rejected", () => {
  const r = scan('import x from "./evil.ts";', []);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason!, "relative import");
});

Deno.test("parent-relative import rejected", () => {
  const r = scan('import x from "../escape.ts";', []);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason!, "relative import");
});

Deno.test("side-effect import enforced", () => {
  const ok = scan('import "session:lib";', []);
  assertEquals(ok.ok, true);
  const bad = scan('import "npm:evil@1";', []);
  assertEquals(bad.ok, false);
});

Deno.test("named re-export enforced", () => {
  const ok = scan('export { x } from "session:lib";', []);
  assertEquals(ok.ok, true);
  const bad = scan('export { x } from "npm:evil@1";', []);
  assertEquals(bad.ok, false);
});

Deno.test("star re-export enforced", () => {
  const bad = scan('export * from "npm:evil@1";', []);
  assertEquals(bad.ok, false);
  assertStringIncludes(bad.reason!, "npm:evil@1");
});

Deno.test("dynamic import with allowed literal → ok", () => {
  const r = scan(
    'const m = await import("jsr:@std/encoding"); reply("ok");',
    ["jsr:@std/encoding"],
  );
  assertEquals(r.ok, true);
});

Deno.test("dynamic import with disallowed literal → reject", () => {
  const r = scan('await import("npm:evil@1");', []);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason!, "npm:evil@1");
});

Deno.test("dynamic import with non-literal argument rejected", () => {
  const r = scan(
    'const spec = "jsr:@std/encoding"; await import(spec);',
    ["jsr:@std/encoding"],
  );
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason!, "string literal");
});

Deno.test("dynamic import with template literal rejected (not a plain string literal)", () => {
  const r = scan('await import(`jsr:@std/encoding`);', ["jsr:@std/encoding"]);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason!, "string literal");
});

Deno.test("import equals rejected", () => {
  const r = scan('import x = require("session:lib");', []);
  assertEquals(r.ok, false);
  assertStringIncludes(r.reason!, "import-equals");
});

Deno.test("multiple imports — first violation wins, ok if all allowed", () => {
  const ok = scan(
    [
      'import { a } from "jsr:@std/encoding";',
      'import { b } from "session:lib";',
      "await reply('ok');",
    ].join("\n"),
    ["jsr:@std/encoding"],
  );
  assertEquals(ok.ok, true);

  const bad = scan(
    [
      'import { a } from "jsr:@std/encoding";',
      'import { b } from "npm:evil@1";',
    ].join("\n"),
    ["jsr:@std/encoding"],
  );
  assertEquals(bad.ok, false);
  assertStringIncludes(bad.reason!, "npm:evil@1");
});
