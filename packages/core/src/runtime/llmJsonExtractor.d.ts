/**
 * LLM JSON Extractor — Robust JSON extraction from LLM responses.
 *
 * Handles common LLM response quirks:
 * - Markdown code fences (```json ... ```)
 * - Text before/after the JSON object
 * - Reasoning models that put output in reasoning_content
 * - MiMo/DeepSeek-R style responses with reasoning + final answer
 */
import type { LLMProvider } from './types';
/**
 * Extract a JSON object from an LLM response string.
 * Tries multiple strategies:
 * 1. Direct JSON.parse
 * 2. Strip markdown code fences
 * 3. Find first {...} block
 * 4. Find last {...} block (some models put reasoning first)
 */
export declare function extractJSON<T>(raw: string): T | null;
/**
 * Call an LLM and extract a JSON response.
 * Handles reasoning models (MiMo, DeepSeek-R) that put output in reasoning_content.
 */
export declare function callLLMJSON<T>(provider: LLMProvider, model: string, systemPrompt: string, userMessage: string, opts?: {
    temperature?: number;
    maxTokens?: number;
}): Promise<{
    data: T;
    tokens: number;
} | null>;
//# sourceMappingURL=llmJsonExtractor.d.ts.map