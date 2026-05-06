// Factory dispatch: pick an agent by name from the YAML's `agent:` field.

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { Agent, defineTool } from "../../src/mod.ts";
import type { StepRecord } from "../../src/types.ts";
import { z } from "zod";
import { resolveModel } from "../models.ts";

export type AgentName = "generic" | "web" | "math";

export interface BuildArgs {
  agent: AgentName | string;
  modelAlias: string;
  task: string;
  maxSteps?: number;
  onStep?: (s: StepRecord) => void | Promise<void>;
  /** Test injection — bypass the model registry. */
  modelOverride?: LanguageModelV2;
  /** Override hosts for the `web` agent (defaults to ["*"]). */
  allowHosts?: string[];
}

const webFetch = defineTool({
  name: "webFetch",
  description: "Fetch a URL and return { status, contentType, text }. Body is " +
    "truncated to 32 KB.",
  schema: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  handler: async ({ url, method, headers, body }) => {
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const MAX = 32 * 1024;
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text: text.length > MAX ? text.slice(0, MAX) + "…[truncated]" : text,
    };
  },
});

export function buildAgent(args: BuildArgs): Agent {
  const model = args.modelOverride ?? resolveModel(args.modelAlias).model;
  const common = {
    model,
    task: args.task,
    onStep: args.onStep,
  };
  switch (args.agent) {
    case "generic":
      return new Agent({
        ...common,
        permissions: {},
        maxSteps: args.maxSteps ?? 4,
      });
    case "web":
      return new Agent({
        ...common,
        tools: [webFetch],
        permissions: { net: args.allowHosts ?? ["*"] },
        maxSteps: args.maxSteps ?? 6,
      });
    case "math":
      return new Agent({
        ...common,
        permissions: { modules: ["jsr:@std/math", "npm:mathjs"] },
        maxSteps: args.maxSteps ?? 4,
      });
    default:
      throw new Error(
        `unknown eval agent factory "${args.agent}" (expected: generic|web|math)`,
      );
  }
}
