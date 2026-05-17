import type { LLMProvider, LLMRequest, LLMResponse, TokenUsage, CacheConfig } from '../types';
import { FormatBridge } from '../formatBridge';

interface OpenAICompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIStreamChunk {
  choices: Array<{
    delta: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; type: string; function: { name?: string; arguments?: string } }> };
    finish_reason: string | null;
  }>;
  usage?: OpenAICompletionUsage;
}

/**
 * DeepSeek Provider — DeepSeek's OpenAI-compatible API.
 * Endpoint: https://api.deepseek.com
 * Models: deepseek-v4-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner
 *
 * DeepSeek-specific behavior:
 * - Reasoning models (deepseek-reasoner) return `reasoning_content` field.
 * - Uses standard OpenAI chat completions format.
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.deepseek.com';
    this.defaultModel = config.defaultModel ?? 'deepseek-v4-flash';
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const model = this.defaultModel || request.model;
    const body = this.buildBody(request, model);

    const lastAssistant = [...request.messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant?.tool_calls) {
      body.tool_calls = lastAssistant.tool_calls;
    }

    const useStreaming = request.cacheConfig?.useCacheControl ?? true;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: useStreaming }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${err}`);
    }

    if (useStreaming) {
      return this.handleStreamingResponse(response, model);
    }

    const data = await response.json();
    return this.parseResponse(data, model);
  }

  private buildBody(request: LLMRequest, model: string): Record<string, unknown> {
    const messages = request.messages.map(m => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
      if (m.name) msg.name = m.name;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      return msg;
    });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = FormatBridge.adaptToolsForProvider(request.tools, 'deepseek');
      body.parallel_tool_calls = true;
    }

    return body;
  }

  private async handleStreamingResponse(response: Response, model: string): Promise<LLMResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    let content = '';
    let reasoningContent = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let currentTool: { id: string; name: string; arguments: string } | null = null;
    let usage: OpenAICompletionUsage | null = null;
    let buffer = '';

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);
        if (jsonStr === '[DONE]') break;

        try {
          const chunk: OpenAIStreamChunk = JSON.parse(jsonStr);
          if (chunk.usage) usage = chunk.usage;

          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            if (delta.content) content += delta.content;
            if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  currentTool = { id: tc.id, name: tc.function?.name ?? '', arguments: '' };
                  toolCalls.push(currentTool);
                }
                if (currentTool && tc.function?.arguments) {
                  currentTool.arguments += tc.function.arguments;
                }
              }
            }
          }
        } catch { /* skip malformed chunks */ }
      }
    }

    const tokenUsage: TokenUsage = usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    return {
      content,
      model,
      usage: tokenUsage,
      finishReason: 'stop',
      toolCalls: toolCalls.length > 0
        ? toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments || '{}'),
          }))
        : undefined,
      reasoning_content: reasoningContent || undefined,
    };
  }

  private parseResponse(data: any, model: string): LLMResponse {
    const choice = data.choices?.[0];
    const message = choice?.message ?? {};

    const tokenUsage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };

    const toolCalls = message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));

    return {
      content: message.content ?? '',
      model,
      usage: tokenUsage,
      finishReason: choice?.finish_reason ?? 'stop',
      toolCalls,
      reasoning_content: message.reasoning_content,
    };
  }
}