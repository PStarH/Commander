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
export declare function extractCode(responseContent: string): string;
/**
 * Extract the task_id from a HumanEval-style prompt string.
 * Looks for patterns like "HumanEval/64" or "HumanEval_64".
 */
export declare function extractTaskId(prompt: string): string | null;
/**
 * Check whether a given code string is suitable as an evalplus solution
 * (has at least a function definition or class definition).
 */
export declare function isValidSolution(code: string): boolean;
//# sourceMappingURL=codeExtractor.d.ts.map