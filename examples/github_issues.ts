// Example: have the agent fetch GitHub issues and summarize them.
//
// Run:  OPENAI_API_KEY=... deno run --allow-read --allow-write \
//         --allow-env --allow-sys --allow-run --allow-net \
//         examples/github_issues.ts <owner/repo>
//
// The agent itself runs with: net=api.github.com only, no fs writes,
// no subprocess, no env. Tools (fetchIssues) execute in the parent with
// full host privileges.

import { Agent, defineTool } from "../src/mod.ts";
import { openai } from "npm:@ai-sdk/openai@2";
import { z } from "zod";

const repo = Deno.args[0] ?? "denoland/deno";

const fetchIssues = defineTool({
  name: "fetchIssues",
  description: "Fetch open issues for a GitHub repo. Returns title + number.",
  schema: z.object({
    repo: z.string().describe("owner/name"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  handler: async ({ repo, limit }) => {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/issues?state=open&per_page=${limit}`,
      { headers: { "Accept": "application/vnd.github+json" } },
    );
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${await r.text()}`);
    const issues = await r.json() as Array<{ number: number; title: string }>;
    return issues.map((i) => ({ number: i.number, title: i.title }));
  },
});

const result = await new Agent({
  model: openai("gpt-5-nano"),
  task: `Summarize the latest open issues in ${repo}. Use the fetchIssues tool.`,
  tools: [fetchIssues],
  permissions: { net: ["api.github.com"] },
  maxSteps: 4,
}).run();

console.log(result);
