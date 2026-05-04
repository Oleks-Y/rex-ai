// ModuleGuard — AST-level enforcement of the module allowlist.
//
// Per §6 (option C: import map + AST scan):
//   - Static imports/re-exports must reference an allowed specifier.
//   - Dynamic imports with a string-literal argument must reference an
//     allowed specifier.
//   - Dynamic imports with a non-literal argument (`import(x)`) are rejected
//     outright — we can't statically verify them, and allowing them would
//     undermine the allowlist.
//   - Relative imports (`./foo`, `../bar`) are rejected — they would only
//     work for files the agent already had read access to, which it doesn't,
//     and `session:lib` is the supported way to use agent-authored helpers.
//   - `session:lib` is always allowed.
//
// We use `npm:typescript` because it is the canonical TS parser and we need
// it to be syntactically correct on every TS construct an LLM might emit.
// We don't run typecheck — just parse + walk.

import ts from "typescript";

export interface GuardInput {
  source: string;
  /**
   * Allowed module specifiers (exact match). `session:lib` is always added
   * by the guard so the caller doesn't have to remember.
   */
  allowed: string[];
  /** Filename used for parser diagnostics. Cosmetic. */
  filename?: string;
}

export interface GuardResult {
  ok: boolean;
  /** First violation, or empty when ok. */
  reason?: string;
}

const ALWAYS_ALLOWED = new Set(["session:lib"]);

/** Sentinel returned to the visitor when a violation is found. */
type Violation = { reason: string };

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
}

function checkSpecifier(spec: string, allowed: Set<string>): Violation | null {
  if (ALWAYS_ALLOWED.has(spec)) return null;
  if (allowed.has(spec)) return null;
  if (isRelative(spec)) {
    return { reason: `relative import not allowed: ${JSON.stringify(spec)}` };
  }
  return { reason: `module not in allowlist: ${JSON.stringify(spec)}` };
}

export const ModuleGuard = {
  /**
   * Scan `source` for imports. Returns `{ ok: true }` or
   * `{ ok: false, reason }` on the first violation.
   */
  scan(input: GuardInput): GuardResult {
    const allowed = new Set(input.allowed);
    const sf = ts.createSourceFile(
      input.filename ?? "agent_code.ts",
      input.source,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ false,
      ts.ScriptKind.TS,
    );

    let violation: Violation | null = null;

    const visit = (node: ts.Node): void => {
      if (violation) return;

      // Static import:  import ... from "spec"   |   import "spec"
      if (ts.isImportDeclaration(node)) {
        const lit = node.moduleSpecifier;
        if (ts.isStringLiteral(lit)) {
          violation = checkSpecifier(lit.text, allowed);
          if (violation) return;
        } else {
          violation = { reason: "import specifier must be a string literal" };
          return;
        }
      }

      // Re-export:  export { x } from "spec"  |  export * from "spec"
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const lit = node.moduleSpecifier;
        if (ts.isStringLiteral(lit)) {
          violation = checkSpecifier(lit.text, allowed);
          if (violation) return;
        } else {
          violation = { reason: "re-export specifier must be a string literal" };
          return;
        }
      }

      // Import equals:  import x = require("spec")  — Deno doesn't honour this
      // and we don't want to either. Reject if we ever see it.
      if (ts.isImportEqualsDeclaration(node)) {
        violation = { reason: "import-equals declarations are not allowed" };
        return;
      }

      // Dynamic import:  import("spec")   |   import(variable)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (!arg || !ts.isStringLiteral(arg)) {
          violation = { reason: "dynamic import argument must be a string literal" };
          return;
        }
        violation = checkSpecifier(arg.text, allowed);
        if (violation) return;
      }

      ts.forEachChild(node, visit);
    };

    ts.forEachChild(sf, visit);

    const v = violation as Violation | null;
    if (v) {
      return { ok: false, reason: v.reason };
    }
    return { ok: true };
  },
};
