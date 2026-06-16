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
import { getGlobalLogger } from '../logging';

/**
 * Extract a JSON object from an LLM response string.
 * Tries multiple strategies:
 * 1. Direct JSON.parse
 * 2. Strip markdown code fences
 * 3. Find first {...} block
 * 4. Find last {...} block (some models put reasoning first)
 */
export function extractJSON<T>(raw: string): T | null {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();

  // Strategy 1: Direct parse
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* continue */
  }

  // Strategy 2: Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      /* continue */
    }
  }

  // Strategy 3: Find first balanced {...} block
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = firstBrace; i < trimmed.length; i++) {
      if (trimmed[i] === '{') depth++;
      if (trimmed[i] === '}') depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    if (end > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, end + 1)) as T;
      } catch {
        /* continue */
      }
    }
  }

  // Strategy 4: Find last {...} block (reasoning models often put text first)
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace > 0) {
    let depth = 0;
    let start = -1;
    for (let i = lastBrace; i >= 0; i--) {
      if (trimmed[i] === '}') depth++;
      if (trimmed[i] === '{') depth--;
      if (depth === 0) {
        start = i;
        break;
      }
    }
    if (start >= 0 && start < lastBrace) {
      try {
        return JSON.parse(trimmed.slice(start, lastBrace + 1)) as T;
      } catch {
        /* continue */
      }
    }
  }

  return null;
}

/**
 * Call an LLM and extract a JSON response.
 * Handles reasoning models (MiMo, DeepSeek-R) that put output in reasoning_content.
 */
export async function callLLMJSON<T>(
  provider: LLMProvider,
  model: string,
  systemPrompt: string,
  userMessage: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<{ data: T; tokens: number } | null> {
  try {
    const response = await provider.call({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: opts?.temperature ?? 0.2,
      maxTokens: opts?.maxTokens ?? 2048,
    });

    // Try content first, then reasoning_content (for reasoning models)
    const raw =
      response.content || (response as { reasoning_content?: string }).reasoning_content || '';
    const data = extractJSON<T>(raw);

    if (!data) {
      getGlobalLogger().warn('LLMJsonExtractor', 'Failed to extract JSON from LLM response', {
        responseLength: raw.length,
        preview: raw.slice(0, 200),
      });
      return null;
    }

    return { data, tokens: response.usage?.totalTokens ?? 0 };
  } catch (err) {
    getGlobalLogger().error('LLMJsonExtractor', 'LLM call failed', err as Error);
    return null;
  }
}
