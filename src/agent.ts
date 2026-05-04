// Agent — orchestrates the code-action loop.
//
// Per §4:
//   step = 0; while step < maxSteps:
//     completion = generateText({ model, prompt })
//     code = CodeExtractor.extract(completion.text)
//     event = await Sandbox.run(code, ...)
//     dispatch on event.kind:
//       reply      → return { kind: "reply", ... }
//       abort      → return { kind: "abort", ... }
//       reflect / permission_denied / throw → record step, ++step, loop
//   return { kind: "exhausted", steps }
//
// History strategy is option B from §8: re-render the full prompt each
// step with the accumulated prior steps + current session state. We use the
// AI SDK's simple `prompt` form rather than chat messages — the prompt
// builder already produces the complete instruction.

import { generateText } from "ai";
import { CodeExtractor } from "./extractor.ts";
import { PromptBuilder, type PriorStep, type SessionSnapshot } from "./prompt.ts";
import { Sandbox } from "./sandbox.ts";
import { SessionStore } from "./session.ts";
import { ToolRegistry } from "./tools.ts";
import {
  type AgentOptions,
  DEFAULT_SIZE_CAPS,
  type RunResult,
  type SizeCaps,
} from "./types.ts";

export class Agent {
  readonly #opts: AgentOptions;
  readonly #tools: ToolRegistry;
  readonly #sizeCaps: SizeCaps;
  readonly #maxSteps: number;

  constructor(opts: AgentOptions) {
    if (typeof opts.task !== "string" || opts.task.length === 0) {
      throw new Error("Agent: `task` must be a non-empty string");
    }
    if (!opts.model) {
      throw new Error("Agent: `model` is required");
    }
    this.#opts = opts;
    // ToolRegistry constructor enforces reserved names + dupes + identifier rules.
    this.#tools = new ToolRegistry(opts.tools ?? []);
    this.#sizeCaps = { ...DEFAULT_SIZE_CAPS, ...(opts.sizeCaps ?? {}) };
    const ms = opts.maxSteps ?? 8;
    if (!Number.isInteger(ms) || ms < 1) {
      throw new Error("Agent: `maxSteps` must be a positive integer");
    }
    this.#maxSteps = ms;
  }

  async run(): Promise<RunResult> {
    const session = await SessionStore.open({
      sessionId: this.#opts.sessionId,
      rootDir: this.#opts.sessionsRoot,
      sizeCaps: this.#sizeCaps,
    });

    try {
      const priorSteps: PriorStep[] = [];

      for (let step = 0; step < this.#maxSteps; step++) {
        const snapshot = await this.#sessionSnapshot(session);
        const prompt = PromptBuilder.build({
          task: this.#opts.task,
          tools: this.#tools.describe(),
          permissions: this.#opts.permissions,
          session: snapshot,
          priorSteps,
        });

        const completion = await generateText({
          model: this.#opts.model,
          prompt,
        });

        // CodeExtractor throws NoCodeBlockError on missing fence — that's a
        // hard fail per §10. Caller catches if they want to.
        const code = CodeExtractor.extract(completion.text);

        const event = await Sandbox.run({
          llmCode: code,
          tools: this.#tools,
          session,
          permissions: this.#opts.permissions,
          sizeCaps: this.#sizeCaps,
        });

        // Always log the step to the transcript for resume / audit.
        await session.appendTranscript({
          step: step + 1,
          code,
          event: { kind: event.kind, ...summarizeEvent(event) },
        });

        if (event.kind === "reply") {
          return { kind: "reply", message: event.message };
        }
        if (event.kind === "abort") {
          return { kind: "abort", error: event.error };
        }
        // Non-terminal: record and loop.
        priorSteps.push({ code, event });
      }

      return { kind: "exhausted", steps: this.#maxSteps };
    } finally {
      await session.close();
    }
  }

  async #sessionSnapshot(session: SessionStore): Promise<SessionSnapshot> {
    const [libSource, libExports] = await Promise.all([
      session.readLib(),
      session.libExports(),
    ]);
    return {
      libExports,
      libSource,
      storageKeys: session.storageKeys(),
    };
  }
}

/** Strip the heavy `logs` field from transcript entries — they go to the
 *  prompt for the *next* step, but persisting them in the JSONL transcript
 *  adds bulk without much resume value. Keep one summary per kind. */
// deno-lint-ignore no-explicit-any
function summarizeEvent(ev: import("./types.ts").SandboxEvent): Record<string, any> {
  switch (ev.kind) {
    case "reply":
      return { message: ev.message };
    case "abort":
      return { error: ev.error };
    case "reflect":
      return { state: ev.state };
    case "permission_denied":
      return { permission: ev.permission, target: ev.target };
    case "throw":
      return { error: ev.error };
  }
}
