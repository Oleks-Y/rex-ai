// PermissionCompiler — translate the user's permission config + module
// allowlist into the exact CLI flags + import map we hand to `deno run`.
//
// Per §9 + §14a:
//   - net/read/write are allowlists; empty array → flag with empty value (no
//     hosts/paths) which is *more* restrictive than omitting the flag, but
//     still allowlist-style. We treat empty same as undefined: omit the flag.
//   - run is a boolean (MVP doesn't allowlist binaries).
//   - The session dir (.rex/sessions/<id>) is auto-added to --allow-read so
//     `import { ... } from "session:lib"` resolves. The agent never gets
//     write to its own lib.ts via fs; writes go through the writeLib RPC.
//   - We always pass --no-prompt (sandbox must never sit waiting for a
//     human) and --no-remote (block ad-hoc fetches outside the import map).
//   - Import map merges the user's `modules` allowlist with `session:lib`.
//
// `env` is intentionally absent from MVP (§9).

import type { PermissionsConfig } from "./types.ts";

export interface CompiledPermissions {
  /** CLI flags to pass after `deno run`. */
  flags: string[];
  /** JSON content of the per-step import map. */
  importMap: { imports: Record<string, string> };
}

export interface CompileInput {
  permissions: PermissionsConfig | undefined;
  /** Absolute (or cwd-relative) path to .rex/sessions/<id>/. */
  sessionDir: string;
  /** Path to lib.ts inside the session dir. Used for the `session:lib` mapping. */
  sessionLibPath: string;
  /** Additional read-only paths spliced into `--allow-read`. Used by the
   *  dreaming-agents subsystem to mount a parent session dir read-only on
   *  a dreamer's sandbox without polluting the dreamer's user-declared
   *  `permissions.read`. The caller is responsible for ensuring these
   *  paths are NOT also present in `permissions.write` (writeable parent
   *  state would break the readonly invariant — `defineDreamer` enforces
   *  that side). */
  extraReadOnlyPaths?: string[];
}

/** Whitespace and shell metachars that would let a value escape its flag. */
function assertSafeAllowlistEntry(kind: string, value: string): void {
  // Values are joined with `,` and passed as a single CLI argv, so embedded
  // commas would silently extend the allowlist. We refuse anything weird up
  // front rather than silently swallow it.
  if (value.includes(",")) {
    throw new Error(`permissions.${kind}: comma not allowed in entry: ${JSON.stringify(value)}`);
  }
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error(
      `permissions.${kind}: control character not allowed in entry: ${JSON.stringify(value)}`,
    );
  }
  if (value.length === 0) {
    throw new Error(`permissions.${kind}: empty entry not allowed`);
  }
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

export const PermissionCompiler = {
  compile(input: CompileInput): CompiledPermissions {
    const p = input.permissions ?? {};
    const flags: string[] = [];

    // Net allowlist
    if (p.net && p.net.length > 0) {
      for (const h of p.net) assertSafeAllowlistEntry("net", h);
      flags.push(`--allow-net=${dedupe(p.net).join(",")}`);
    }

    // Read allowlist — always includes the session dir so `session:lib`
    // resolves. Dedupe so a user who also lists the session dir doesn't
    // produce a duplicate entry. `extraReadOnlyPaths` (dreamer-side) is
    // spliced in here so the resulting flag still goes through the same
    // safety check and dedupe.
    const readPaths = dedupe([
      input.sessionDir,
      ...(p.read ?? []),
      ...(input.extraReadOnlyPaths ?? []),
    ]);
    for (const r of readPaths) assertSafeAllowlistEntry("read", r);
    flags.push(`--allow-read=${readPaths.join(",")}`);

    // Write allowlist
    if (p.write && p.write.length > 0) {
      for (const w of p.write) assertSafeAllowlistEntry("write", w);
      flags.push(`--allow-write=${dedupe(p.write).join(",")}`);
    }

    // Run (boolean)
    if (p.run === true) {
      flags.push("--allow-run");
    }

    // Hardening: never prompt, never fetch outside the import map.
    flags.push("--no-prompt");
    flags.push("--no-remote");

    // Import map: user's allowed modules + session:lib.
    // We don't validate the URLs here — the caller (Agent) decides what's
    // allowed. The AST scan in ModuleGuard is the second line of defense.
    const imports: Record<string, string> = {};
    for (const spec of p.modules ?? []) {
      // Sanity: don't let users override session:lib via the modules list.
      if (spec === "session:lib") {
        throw new Error('permissions.modules: "session:lib" is reserved');
      }
      // Map each allowed specifier to itself — Deno will resolve npm:/jsr:/
      // https: as usual *only if* the specifier is in this map. With
      // --no-remote, anything not in the map is blocked.
      imports[spec] = spec;
    }
    imports["session:lib"] = input.sessionLibPath;

    return {
      flags,
      importMap: { imports },
    };
  },
};
