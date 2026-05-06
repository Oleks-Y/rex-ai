// ToolRegistry — owns the user's tool definitions and runs them in the
// parent process (per §7 Parent-RPC).
//
// Contract:
//   - Construction rejects reserved names (§17) and duplicates.
//   - `call(name, rawArgs)` validates args via zod; on failure returns
//     `{ ok: false, error, issues }` so the sandbox stub can throw a
//     ToolError carrying the zod issues (§11, §12).
//   - On success, serializes the result and enforces the per-tool result
//     size cap (§17). Oversize results come back as
//     `{ ok: false, error: "ToolResultTooLargeError: ..." }` so the
//     sandbox stub throws ToolResultTooLargeError.
//   - Handler exceptions are caught and surfaced as `{ ok: false, error }`.
//
// We also expose `describe()` so PromptBuilder can render the tool catalog.

import { z } from "zod";
import { RESERVED_NAMES, type ToolDefinition } from "./types.ts";

/**
 * Helper that lets TypeScript infer the args type from the zod schema, so
 * tool authors don't have to spell out generics.
 *
 *   const fetchIssues = defineTool({
 *     name: "fetchIssues",
 *     schema: z.object({ repo: z.string() }),
 *     handler: async ({ repo }) => { ... },   // repo: string ✓
 *   });
 */
export function defineTool<TSchema extends z.ZodTypeAny, TResult>(
  def: ToolDefinition<TSchema, TResult>,
): ToolDefinition<TSchema, TResult> {
  return def;
}

/** Result of a tool invocation that the parent will ship back over RPC. */
export type ToolCallOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: string; issues?: unknown };

export interface ToolDescription {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** Pre-rendered TS signature (if the tool supplied one). */
  tsSignature?: string;
}

export interface CallOptions {
  /** Max bytes for the JSON-serialized result. Required (caller decides). */
  maxResultBytes: number;
}

const RESERVED_SET = new Set<string>(RESERVED_NAMES);

const enc = new TextEncoder();

function describeIssues(err: z.ZodError): string {
  // Concise, deterministic, model-readable.
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

export class ToolRegistry {
  // deno-lint-ignore no-explicit-any
  readonly #tools = new Map<string, ToolDefinition<any, any>>();

  // deno-lint-ignore no-explicit-any
  constructor(tools: ToolDefinition<any, any>[] = []) {
    for (const t of tools) {
      if (typeof t.name !== "string" || t.name.length === 0) {
        throw new Error("tool name must be a non-empty string");
      }
      if (RESERVED_SET.has(t.name)) {
        throw new Error(
          `tool name "${t.name}" is reserved (one of: ${RESERVED_NAMES.join(", ")})`,
        );
      }
      // Reject `__*` names. The prelude emits each tool stub into the
      // same module scope as its own internals (`__rpcBuf`,
      // `__rpcReader`, `__rex`, etc.); a colliding identifier either
      // shadows them at runtime or fails to parse. Rather than
      // enumerate every internal, reserve the entire convention.
      if (t.name.startsWith("__")) {
        throw new Error(
          `tool name "${t.name}" is reserved: names starting with "__" are sandbox internals`,
        );
      }
      if (this.#tools.has(t.name)) {
        throw new Error(`duplicate tool name: ${t.name}`);
      }
      // Identifier check — the prelude turns each tool name into a function
      // identifier in the sandbox, so it must be a valid JS identifier.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t.name)) {
        throw new Error(
          `tool name "${t.name}" is not a valid JS identifier`,
        );
      }
      this.#tools.set(t.name, t);
    }
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  names(): string[] {
    return Array.from(this.#tools.keys());
  }

  describe(): ToolDescription[] {
    return Array.from(this.#tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.schema,
      tsSignature: t.tsSignature,
    }));
  }

  /**
   * Invoke a tool by name. Always resolves (never rejects) so the caller
   * can ship the outcome over RPC without a try/catch wrapper.
   */
  async call(name: string, rawArgs: unknown, opts: CallOptions): Promise<ToolCallOutcome> {
    const tool = this.#tools.get(name);
    if (!tool) {
      return { ok: false, error: `unknown tool: ${name}` };
    }

    // Zod validation. Produces a deterministic, structured error on failure.
    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid arguments for ${name}: ${describeIssues(parsed.error)}`,
        issues: parsed.error.issues,
      };
    }

    let value: unknown;
    try {
      value = await tool.handler(parsed.data);
    } catch (e) {
      // Surface the message; preserve the name so the LLM can reason about it.
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { ok: false, error: msg };
    }

    // Serialize once + enforce the result size cap before returning to the sandbox.
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch (e) {
      return {
        ok: false,
        error: `tool ${name} returned non-JSON-serializable value: ${(e as Error).message}`,
      };
    }
    if (json === undefined) {
      // Tool returned undefined (or a function/symbol that JSON.stringify drops).
      return { ok: true, value: null };
    }
    const size = enc.encode(json).length;
    if (size > opts.maxResultBytes) {
      return {
        ok: false,
        error:
          `ToolResultTooLargeError: ${name} returned ${size} bytes (cap ${opts.maxResultBytes})`,
      };
    }

    // Re-parse to a plain JSON value so the caller doesn't get back a
    // potentially live reference (e.g. a class instance with methods that
    // would survive .stringify-then-parse round-trip in unexpected ways).
    return { ok: true, value: JSON.parse(json) };
  }
}
