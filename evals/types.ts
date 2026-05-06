// Shared types for the rex-ai evaluation suite.
//
// One JSONL row schema serves both L1 (in-repo golden tasks) and L2
// (BFCL via @ai-sdk-tool/eval). Keep the surface small and explicit —
// the runner is the only writer; score.ts and CI are the readers.

export type GraderType =
  | "exact_match"
  | "numeric_match"
  | "json_match"
  | "regex_match"
  | "llm_judge";

export interface GraderConfig {
  type: GraderType;
  // exact_match (string | string[]); numeric_match (number | numeric string);
  // json_match (any JSON-compatible structure).
  expected?: unknown;
  normalize?: "strict" | "loose";
  // numeric_match
  tolerance?: number;
  op?: "==" | ">=" | "<=" | "range";
  range?: [number, number];
  // json_match
  subset?: boolean;
  // regex_match
  pattern?: string;
  flags?: string;
  // llm_judge
  rubric?: string;
}

export interface TaskPermissionOverrides {
  /** Override hosts for the `web` agent (defaults to ["*"]). Empty array
   *  disables net entirely (useful for testing permission_denied paths). */
  allowHosts?: string[];
}

export interface TaskDef {
  id: string;
  task: string;
  grader: GraderConfig;
  agent: string;
  max_steps?: number;
  tags?: string[];
  /** Per-task permission overrides — currently the `web` agent's allowHosts. */
  permissions?: TaskPermissionOverrides;
}

export interface SourceMeta {
  name: string;
  url: string;
  license: string;
  pulled_at?: string;
  pinned_revision?: string;
}

export interface TaskFile {
  source: SourceMeta;
  agent?: string;
  tasks: TaskDef[];
}

export interface TrajectoryStep {
  step: number;
  code?: string;
  // deno-lint-ignore no-explicit-any
  tool_calls?: any[];
  // deno-lint-ignore no-explicit-any
  observation?: any;
}

export type FinishReason = "reply" | "abort" | "exhausted" | "error";

export interface RunResultRow {
  // identity
  run_id: string;
  layer: "l1" | "l2";
  source: string;
  task_id: string;
  seed: number;
  // config
  model: string;
  agent: string;
  // result
  score: number;
  grader_type: GraderType | "bfcl";
  judge_rationale?: string;
  reply: string;
  trajectory: TrajectoryStep[];
  // metrics
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  steps: number;
  wall_ms: number;
  // failure
  error?: string;
  finish_reason: FinishReason;
  // env
  rex_ai_commit: string;
  ts: string;
}

export interface RunnerOptions {
  layer: "l1" | "l2";
  files?: string[];
  models: string[];
  limit?: number;
  seeds?: number;
  concurrency?: number;
  budgetUsd?: number;
  perTaskBudgetUsd?: number;
  temperature?: number;
  outDir: string;
}
