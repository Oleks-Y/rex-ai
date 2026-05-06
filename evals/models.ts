// Model registry for evals. We pin every model to a *dated* id so a
// JSONL row written today stays interpretable when the alias points
// somewhere new in 6 months.
//
// To add a model: add the entry, set `pricePerMillion`, point the
// provider at the correct factory.

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { openai } from "npm:@ai-sdk/openai@2";
import { anthropic } from "npm:@ai-sdk/anthropic@2";

export interface ModelEntry {
  alias: string;
  /** Dated id we record in the JSONL — provider-specific. */
  id: string;
  provider: "openai" | "anthropic";
  /** USD per 1M input / output tokens. Conservative defaults. */
  pricePerMillion: { input: number; output: number };
}

// Curated registry of well-known aliases. The `id` is the actual string
// passed to the provider — if you want to pin to a specific dated
// snapshot, change `id` here (e.g. "gpt-5-nano-2026-03-17"). If you
// pass `--models <alias>` and the alias isn't in this map, we fall back
// to a heuristic provider lookup based on the prefix, so unrecognized
// dated ids work too (`gpt-...` → openai, `claude-...` → anthropic).
export const MODELS: Record<string, ModelEntry> = {
  "gpt-5-nano": {
    alias: "gpt-5-nano",
    id: "gpt-5-nano",
    provider: "openai",
    pricePerMillion: { input: 0.05, output: 0.40 },
  },
  "gpt-5-mini": {
    alias: "gpt-5-mini",
    id: "gpt-5-mini",
    provider: "openai",
    pricePerMillion: { input: 0.25, output: 2.00 },
  },
  "gpt-5": {
    alias: "gpt-5",
    id: "gpt-5",
    provider: "openai",
    pricePerMillion: { input: 1.25, output: 10.00 },
  },
  "claude-haiku-4-5": {
    alias: "claude-haiku-4-5",
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    pricePerMillion: { input: 1.00, output: 5.00 },
  },
  "claude-sonnet-4-6": {
    alias: "claude-sonnet-4-6",
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    pricePerMillion: { input: 3.00, output: 15.00 },
  },
  "claude-opus-4-7": {
    alias: "claude-opus-4-7",
    id: "claude-opus-4-7",
    provider: "anthropic",
    pricePerMillion: { input: 15.00, output: 75.00 },
  },
};

export const JUDGE_MODEL_ALIAS = "claude-haiku-4-5";

function inferProvider(id: string): "openai" | "anthropic" | null {
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")) {
    return "openai";
  }
  if (id.startsWith("claude-")) return "anthropic";
  return null;
}

/** Resolve `--models <alias>` to a provider model. Tries the registry
 *  first; falls back to treating the alias as a raw provider model id
 *  (so dated snapshots like `gpt-5-nano-2026-03-17` work without an
 *  edit to this file). */
export function resolveModel(alias: string): {
  entry: ModelEntry;
  model: LanguageModelV2;
} {
  let entry = MODELS[alias];
  if (!entry) {
    const provider = inferProvider(alias);
    if (!provider) {
      const known = Object.keys(MODELS).join(", ");
      throw new Error(
        `unknown model "${alias}". Add it to evals/models.ts or use a ` +
          `provider-prefixed id (gpt-..., o1-..., claude-...). Known: ${known}`,
      );
    }
    entry = {
      alias,
      id: alias,
      provider,
      pricePerMillion: { input: 0, output: 0 },
    };
  }
  let model: LanguageModelV2;
  switch (entry.provider) {
    case "openai":
      model = openai(entry.id) as unknown as LanguageModelV2;
      break;
    case "anthropic":
      model = anthropic(entry.id) as unknown as LanguageModelV2;
      break;
  }
  return { entry, model };
}

export function estimateCostUsd(
  alias: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const entry = MODELS[alias];
  if (!entry) return 0; // Unknown alias = no price → cost reported as 0.
  const inUsd = (tokensIn / 1_000_000) * entry.pricePerMillion.input;
  const outUsd = (tokensOut / 1_000_000) * entry.pricePerMillion.output;
  return inUsd + outUsd;
}
