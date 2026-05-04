// CodeExtractor — pull the TS code block out of an LLM completion.
//
// Per §10/§13:
//   - accept fences ```ts and ```typescript (case-insensitive on the tag)
//   - if multiple matching fences exist, last wins (matches the §16 test)
//   - any other shape (no fence, wrong tag) → NoCodeBlockError
//
// We deliberately do not try to "recover" from missing fences — the prompt
// instructs the model to wrap code in a fence; failure is a hard fail of
// agent.run(). Surfacing this back to the LLM as a step error is post-MVP.

import { NoCodeBlockError } from "./types.ts";

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
