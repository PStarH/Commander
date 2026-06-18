/**
 * Code extraction utilities for evalplus-compatible sample generation.
 *
 * Extracts clean solution code from raw LLM responses by stripping
 * conversational preamble, markdown fences, and other non-code content.
 * Handles multiple response formats seen across providers.
 */

/**
 * Extract clean solution code from an LLM response string.
 *
 * Strategy (tried in order):
 * 1. ```python / ```fenced code block (most common)
 * 2. Fenced block without language tag
 * 3. Raw code if nothing else matches
 */
export function extractCode(responseContent: string): string {
  if (!responseContent) return '';

  // Strategy 1: ```python ... ``` block
  const pythonBlock = extractFencedBlock(responseContent, 'python');
  if (pythonBlock) return pythonBlock;

  // Strategy 2: Any fenced code block
  const anyBlock = extractFencedBlock(responseContent, null);
  if (anyBlock) return anyBlock;

  // Strategy 3: Return raw content trimmed (no code block found)
  return responseContent.trim();
}

/**
 * Extract content from a fenced code block with optional language tag.
 */
function extractFencedBlock(content: string, lang: string | null): string | null {
  const fence = '```';
  // Build closing pattern — same opening tag means same closing tag
  const langTag = lang ? lang : '[a-zA-Z0-9]*';
  const pattern = new RegExp(
    `${fence}${langTag ? '\\s*' + langTag : ''}\\s*\\n([\\s\\S]*?)\\n\\s*${fence}`,
    'i',
  );
  const match = content.match(pattern);
  if (match && match[1] && match[1].trim().length > 0) {
    return match[1].trim();
  }
  return null;
}

/**
 * Extract the task_id from a HumanEval-style prompt string.
 * Looks for patterns like "HumanEval/64" or "HumanEval_64".
 */
export function extractTaskId(prompt: string): string | null {
  if (!prompt) return null;

  // Pattern: HumanEval/123 or HumanEval_123 or humaneval/123
  const pattern = /(?:HumanEval|humaneval)[\/_]\d+/;
  const match = prompt.match(pattern);
  if (match) {
    // Normalize to forward-slash format
    return match[0].replace(/_/, '/');
  }

  return null;
}

/**
 * Check whether a given code string is suitable as an evalplus solution
 * (has at least a function definition or class definition).
 */
export function isValidSolution(code: string): boolean {
  if (!code || code.trim().length < 10) return false;
  return /\b(def |class |async def |FIX\s*=|from \w+ import|\breturn\b)/.test(code);
}
