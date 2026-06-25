import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { FormatBridge } from '../formatBridge';
import { getGlobalLogger } from '../../logging';

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.defaultModel = config.defaultModel ?? 'openai/gpt-4o-mini';
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      temperature: request.temperature ?? 0.7,
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = FormatBridge.adaptToolsForProvider(request.tools, 'openrouter');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/PStarH/Commander',
        'X-Title': 'Commander',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    return this.parseResponse(data, model);
  }

  private parseResponse(
    data: {
      model?: string;
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          reasoning?: string;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    },
    model: string,
  ): LLMResponse {
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};

    return {
      content: message.content ?? '',
      model: data.model ?? model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      finishReason:
        choice?.finish_reason === 'stop'
          ? 'stop'
          : choice?.finish_reason === 'tool_calls'
            ? 'tool_calls'
            : choice?.finish_reason === 'length'
              ? 'length'
              : 'stop',
      toolCalls: message.tool_calls?.map(
        (tc: { id: string; function?: { name?: string; arguments?: string } }) => ({
          id: tc.id,
          name: tc.function?.name ?? '',
          arguments: (() => {
            try {
              return JSON.parse(tc.function?.arguments ?? '{}');
            } catch (e) {
              getGlobalLogger().debug('OpenRouterProvider', 'Skipping malformed tool arguments', {
                error: (e as Error)?.message,
              });
              return {};
            }
          })(),
        }),
      ),
      reasoning_content: message.reasoning,
    };
  }
}
