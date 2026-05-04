import { assertEquals, assertThrows } from "@std/assert";
import { PermissionCompiler } from "../../src/permissions.ts";
import type { PermissionsConfig } from "../../src/types.ts";

const SESSION_DIR = ".rex/sessions/abc";
const LIB_PATH = ".rex/sessions/abc/lib.ts";

function compile(p: PermissionsConfig | undefined) {
  return PermissionCompiler.compile({
    permissions: p,
    sessionDir: SESSION_DIR,
    sessionLibPath: LIB_PATH,
  });
}

Deno.test("default (undefined permissions) → only auto-read of session dir + hardening", () => {
  const out = compile(undefined);
  assertEquals(out.flags, [
    "--allow-read=.rex/sessions/abc",
    "--no-prompt",
    "--no-remote",
  ]);
  assertEquals(out.importMap, { imports: { "session:lib": LIB_PATH } });
});

Deno.test("net allowlist", () => {
  const out = compile({ net: ["api.github.com", "example.com"] });
  assertEquals(
    out.flags[0],
    "--allow-net=api.github.com,example.com",
  );
});

Deno.test("net empty array → no flag", () => {
  const out = compile({ net: [] });
  assertEquals(out.flags.includes("--allow-net="), false);
  assertEquals(out.flags.find((f) => f.startsWith("--allow-net")), undefined);
});

Deno.test("read merges user paths + session dir, dedupes", () => {
  const out = compile({ read: ["./cache", SESSION_DIR, "./other"] });
  assertEquals(
    out.flags.find((f) => f.startsWith("--allow-read")),
    `--allow-read=${SESSION_DIR},./cache,./other`,
  );
});

Deno.test("write allowlist", () => {
  const out = compile({ write: ["./out"] });
  assertEquals(out.flags.includes("--allow-write=./out"), true);
});

Deno.test("write empty array → no flag", () => {
  const out = compile({ write: [] });
  assertEquals(out.flags.find((f) => f.startsWith("--allow-write")), undefined);
});

Deno.test("run: true → --allow-run", () => {
  const out = compile({ run: true });
  assertEquals(out.flags.includes("--allow-run"), true);
});

Deno.test("run: false (or absent) → no --allow-run", () => {
  const out = compile({ run: false });
  assertEquals(out.flags.includes("--allow-run"), false);
});

Deno.test("modules → import map entries; session:lib is always present", () => {
  const out = compile({ modules: ["jsr:@std/encoding", "npm:zod@4"] });
  assertEquals(out.importMap.imports, {
    "jsr:@std/encoding": "jsr:@std/encoding",
    "npm:zod@4": "npm:zod@4",
    "session:lib": LIB_PATH,
  });
});

Deno.test("comma in allowlist entry rejected (would silently extend allowlist)", () => {
  assertThrows(
    () => compile({ net: ["api.github.com,evil.com"] }),
    Error,
    "comma not allowed",
  );
});

Deno.test("control character in allowlist entry rejected", () => {
  assertThrows(
    () => compile({ read: ["./cache\nfoo"] }),
    Error,
    "control character",
  );
});

Deno.test("empty string entry rejected", () => {
  assertThrows(
    () => compile({ net: [""] }),
    Error,
    "empty entry",
  );
});

Deno.test('user cannot override "session:lib" via modules', () => {
  assertThrows(
    () => compile({ modules: ["session:lib"] }),
    Error,
    "reserved",
  );
});

Deno.test("--no-prompt and --no-remote are always present (hardening)", () => {
  const out = compile({});
  assertEquals(out.flags.includes("--no-prompt"), true);
  assertEquals(out.flags.includes("--no-remote"), true);
});

Deno.test("dedup in net entries", () => {
  const out = compile({ net: ["a.com", "a.com", "b.com"] });
  assertEquals(out.flags.find((f) => f.startsWith("--allow-net")), "--allow-net=a.com,b.com");
});
