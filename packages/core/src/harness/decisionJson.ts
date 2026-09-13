/**
 * Decision JSON extraction for LLM judge/guardian responses.
 *
 * A greedy `/\{[\s\S]*\}/` match spans every brace in the response: when a model
 * emits more than one JSON object (prose examples, echoed tool output, or a
 * decoy planted via an attacker-influenced conversation) the span fails to
 * parse and callers historically fail-opened to "approved"/"satisfied".
 *
 * This scanner walks balanced braces and returns the FIRST parseable JSON object
 * that carries the requested decision key. A later decoy therefore cannot flip
 * an earlier verdict, and an unparseable response yields `null` (callers must
 * treat that as "no decision" and fail closed).
 */

function tryParseObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not valid JSON at this brace span — not an error, keep scanning.
  }
  return null;
}

export function extractDecisionObject(
  content: string,
  decisionKey: string,
): Record<string, unknown> | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = content.slice(start, i + 1);
        start = -1;
        const parsed = tryParseObject(candidate);
        if (parsed && decisionKey in parsed) {
          return parsed;
        }
      }
    }
  }
  return null;
}
