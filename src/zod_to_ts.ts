// Tiny zod-to-ts converter for the subset PromptBuilder needs.
//
// Per §12 the supported subset is:
//   string / number / boolean / array / object / optional / nullable /
//   default / enum / literal / union / tuple / null / undefined /
//   any / unknown.
//
// Anything outside this returns "unknown" with a comment hint, rather than
// throwing — better to give the LLM a slightly loose signature than to
// hard-fail prompt construction on a tool author's exotic schema.
//
// We use zod 4's `def.type` introspection (probed against npm:zod@4).

import type { z } from "zod";

// We deliberately use `any` here — zod's internal def shapes vary by node
// type and proper typing would require importing every zod-internal symbol.
// deno-lint-ignore no-explicit-any
type AnySchema = any;

function literalToTs(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return "unknown";
}

function isIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

function objectKey(k: string): string {
  return isIdentifier(k) ? k : JSON.stringify(k);
}

function isOptional(schema: AnySchema): boolean {
  const t = schema?.def?.type;
  return t === "optional" || t === "default";
}

export function zodToTs(schema: AnySchema): string {
  if (!schema || !schema.def) return "unknown";
  const def = schema.def;
  switch (def.type) {
    case "string":
      return "string";
    case "number":
    case "int":
    case "bigint":
      return def.type === "bigint" ? "bigint" : "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "any":
      return "any";
    case "unknown":
      return "unknown";
    case "literal": {
      const vals = def.values as unknown[];
      if (vals.length === 1) return literalToTs(vals[0]);
      return vals.map(literalToTs).join(" | ");
    }
    case "enum": {
      // entries: { key: value }
      const values = Object.values(def.entries as Record<string, unknown>);
      return values.map(literalToTs).join(" | ");
    }
    case "optional":
      return `${zodToTs(def.innerType)} | undefined`;
    case "nullable":
      return `${zodToTs(def.innerType)} | null`;
    case "default":
      // Default is transparent at the type level — caller can omit the field.
      return zodToTs(def.innerType);
    case "array":
      return `Array<${zodToTs(def.element)}>`;
    case "tuple": {
      const inner = (def.items as AnySchema[]).map(zodToTs);
      const rest = def.rest ? `, ...${zodToTs(def.rest)}[]` : "";
      return `[${inner.join(", ")}${rest}]`;
    }
    case "union":
      return (def.options as AnySchema[]).map(zodToTs).join(" | ");
    case "object": {
      const shape = def.shape as Record<string, AnySchema>;
      const lines: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        const opt = isOptional(v) ? "?" : "";
        lines.push(`  ${objectKey(k)}${opt}: ${zodToTs(v)};`);
      }
      if (lines.length === 0) return "{}";
      return `{\n${lines.join("\n")}\n}`;
    }
    case "record": {
      const v = def.valueType ?? def.value;
      return `Record<string, ${v ? zodToTs(v) : "unknown"}>`;
    }
    default:
      return `unknown /* zod:${String(def.type)} */`;
  }
}
