// CodeExtractor — pull the TS code block out of an LLM completion.
//
// Per §10/§13:
//   - accept fences ```ts and ```typescript (case-insensitive on the tag)
//   - if multiple matching fences exist, last wins (matches the §16 test)
//   - any other shape (no fence, wrong tag) → NoCodeBlockError
//
// NoCodeBlockError is recoverable: callers catch it, record a synthetic
// `throw` SandboxEvent via `noCodeBlockEvent()`, and let the model retry
// on the next turn. The model sees the prior step's error (including a
// preview of what it emitted) and is expected to retry with a proper
// fence. `maxSteps` still caps a chronically broken model.

import { NoCodeBlockError, type SandboxEvent } from "./types.ts";

/**
 * Matches a fenced code block opened with ```ts or ```typescript (the tag
 * may be followed by whitespace before the newline). Captures the inner code.
 *
 * Notes on the regex:
 *   - We anchor the opener with `(?:^|\n)` so a fence inside another line
 *     doesn't trigger.
 *   - We require the tag to be exactly `ts` or `typescript` (case-insensitive)
 *     followed by EOL. We do not accept `tsx`, `javascript`, etc. — those
 *     would be a model contract violation worth surfacing.
 *   - We accept either a closing fence on its own line *or* end-of-string,
 *     so a model that streams without a trailing fence still parses.
 */
const FENCE_RE = /(?:^|\n)```(ts|typescript)[ \t]*\r?\n([\s\S]*?)(?:\r?\n```|$)/gi;

export const CodeExtractor = {
  /**
   * Extract the TS code from `text`. If multiple matching fences exist,
   * the **last** one wins (the model's most recent thought).
   *
   * @throws NoCodeBlockError if no ts/typescript fence is found.
   */
  extract(text: string): string {
    let last: string | null = null;
    for (const m of text.matchAll(FENCE_RE)) {
      last = m[2];
    }
    if (last === null) {
      throw new NoCodeBlockError();
    }
    return last;
  },
};

/** Build a synthetic `throw` SandboxEvent describing a missing code-fence.
 *  The error message includes a (truncated) preview of the model's output
 *  so the next prompt's prior-steps section gives the model enough context
 *  to self-correct. */
export function noCodeBlockEvent(modelOutput: string): SandboxEvent {
  const PREVIEW = 800;
  const preview = modelOutput.length > PREVIEW
    ? modelOutput.slice(0, PREVIEW) + `…(+${modelOutput.length - PREVIEW} chars)`
    : modelOutput;
  return {
    kind: "throw",
    error:
      "no ts/typescript code block found in your output. Wrap your code " +
      "in a ```ts ... ``` (or ```typescript ... ```) fence on its own " +
      "lines. Your previous output was:\n" + preview,
    logs: [],
  };
}
