import { ResourceGovernor } from '../../security/securityPrimitives';
import type { LLMClient, SamplingOptions, TokenUsage } from './types';

export interface LiveLLMOptions {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

function getApiKey(provider: 'openai' | 'anthropic'): string {
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error(`Missing API key for provider ${provider}`);
  return key;
}

function buildOpenAIRequest(prompt: string, options: SamplingOptions) {
  return {
    model: options.model ?? 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.7,
    top_p: options.topP,
    max_tokens: options.maxTokens,
  };
}

function buildAnthropicRequest(prompt: string, options: SamplingOptions) {
  return {
    model: options.model ?? 'claude-3-5-haiku',
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.7,
    top_p: options.topP,
    max_tokens: options.maxTokens ?? 1024,
  };
}

export function createLiveLLM(options: LiveLLMOptions): LLMClient {
  const provider = options.provider;
  const model = options.model;
  const apiKey = options.apiKey ?? getApiKey(provider);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const baseUrl =
    options.baseUrl ??
    (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1');

  return {
    async complete(
      prompt: string,
      opts: SamplingOptions = {},
    ): Promise<{ text: string; tokens: TokenUsage }> {
      const mergedModel = opts.model ?? model;
      const body =
        provider === 'openai'
          ? buildOpenAIRequest(prompt, { ...opts, model: mergedModel })
          : buildAnthropicRequest(prompt, { ...opts, model: mergedModel });

      const url = provider === 'openai' ? `${baseUrl}/chat/completions` : `${baseUrl}/messages`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (provider === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
      }

      const response = await ResourceGovernor.withTimeout(
        async () =>
          fetchImpl(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }),
        30_000,
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM API error ${response.status}: ${text}`);
      }

      const data = (await response.json()) as Record<string, unknown>;

      if (provider === 'openai') {
        const choice = (data.choices as Array<{ message: { content: string } }>)[0];
        const usage = data.usage as { prompt_tokens: number; completion_tokens: number };
        return {
          text: choice.message.content,
          tokens: {
            input: usage.prompt_tokens,
            output: usage.completion_tokens,
            total: usage.prompt_tokens + usage.completion_tokens,
            cached: 0,
            reasoning: 0,
          },
        };
      }

      // Anthropic
      const content = (data.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === 'text',
      );
      const usage = data.usage as { input_tokens: number; output_tokens: number };
      return {
        text: content?.text ?? '',
        tokens: {
          input: usage.input_tokens,
          output: usage.output_tokens,
          total: usage.input_tokens + usage.output_tokens,
          cached: 0,
          reasoning: 0,
        },
      };
    },
  };
}
