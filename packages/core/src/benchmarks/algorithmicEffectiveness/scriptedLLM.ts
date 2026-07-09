import type { LLMClient, SamplingOptions, TokenUsage } from './types';

export interface ScriptedLLMOptions {
  responses: Record<string, string>;
  defaultResponse?: string;
  useRegex?: boolean;
  model?: string;
}

function estimateTokens(text: string): TokenUsage {
  // Rough approximation: 1 token ~= 4 chars for English; keeps tests deterministic
  const total = Math.max(1, Math.ceil(text.length / 4));
  return {
    input: 0,
    output: total,
    total,
    cached: 0,
    reasoning: 0,
  };
}

export function createScriptedLLM(options: ScriptedLLMOptions): LLMClient {
  const { responses = {}, defaultResponse = '', useRegex = false, model = 'scripted' } = options;

  return {
    async complete(prompt: string, _opts?: SamplingOptions): Promise<{ text: string; tokens: TokenUsage }> {
      let text = defaultResponse;

      if (useRegex) {
        for (const [pattern, response] of Object.entries(responses)) {
          const normalizedPattern = pattern.replace(/^\/(.*)\/$/, '$1');
          const re = new RegExp(normalizedPattern);
          if (re.test(prompt)) {
            text = response;
            break;
          }
        }
      } else {
        // Exact match first, then substring match
        if (responses[prompt] !== undefined) {
          text = responses[prompt];
        } else {
          for (const [key, response] of Object.entries(responses)) {
            if (prompt.includes(key)) {
              text = response;
              break;
            }
          }
        }
      }

      return { text, tokens: estimateTokens(text) };
    },
  };
}
