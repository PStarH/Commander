import type { LLMProvider, LLMRequest, LLMResponse, TokenUsage, CacheConfig } from '../types';

interface AnthropicContent {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  cache_control?: { type: 'ephemeral' };
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContent[];
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
    this.defaultModel = config.defaultModel ?? 'claude-3-5-sonnet-20241022';
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.defaultModel;
    const anthropicMessages = this.buildMessages(request);
    const systemWithCache = this.buildSystemWithCache(request);
    const useStreaming = request.cacheConfig?.useCacheControl ?? true;

    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 8192,
      messages: anthropicMessages,
    };

    if (systemWithCache) {
      body.system = systemWithCache;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        ...(request.cacheConfig?.cacheTools ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }));
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        ...(useStreaming ? { 'accept': 'text/event-stream' } : {}),
      },
      body: JSON.stringify(useStreaming ? { ...body, stream: true } : body),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${err}`);
    }

    if (useStreaming) {
      return this.handleStreamingResponse(response, model);
    }

    const data = await response.json();
    return this.parseResponse(data, model);
  }

  private buildMessages(request: LLMRequest): AnthropicMessage[] {
    const msgs: AnthropicMessage[] = [];
    let currentRole: string | null = null;
    let currentContent: AnthropicContent[] = [];

    for (const m of request.messages) {
      if (m.role === 'system') continue;

      if (m.role !== currentRole && currentContent.length > 0) {
        msgs.push({ role: currentRole as 'user' | 'assistant', content: currentContent });
        currentContent = [];
      }
      currentRole = m.role;

      if (m.role === 'tool') {
        currentContent.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: m.content,
        });
      } else if (m.tool_call_id) {
        currentContent.push({
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: m.content,
        });
      } else {
        currentContent.push({ type: 'text', text: m.content });
      }
    }

    if (currentContent.length > 0 && currentRole) {
      msgs.push({ role: currentRole as 'user' | 'assistant', content: currentContent });
    }

    return msgs;
  }

  private buildSystemWithCache(request: LLMRequest): AnthropicContent[] | undefined {
    const systemMsg = request.messages.find(m => m.role === 'system');
    if (!systemMsg) return undefined;

    const blocks: AnthropicContent[] = [
      {
        type: 'text',
        text: systemMsg.content,
      },
    ];

    if (request.cacheConfig?.cacheSystemPrompt) {
      blocks[0].cache_control = { type: 'ephemeral' };
    }

    return blocks;
  }

  private async handleStreamingResponse(response: Response, model: string): Promise<LLMResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let currentToolBlock: { id: string; name: string; inputBuffer: string } | null = null;
    let usage: AnthropicUsage | null = null;
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
        if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) continue;

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);
          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'content_block_delta' && event.delta?.text) {
              content += event.delta.text;
            }
            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
              currentToolBlock = {
                id: event.content_block.id,
                name: event.content_block.name,
                inputBuffer: '',
              };
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && currentToolBlock) {
              currentToolBlock.inputBuffer += event.delta.partial_json;
            }
            if (event.type === 'content_block_stop' && currentToolBlock) {
              try {
                toolCalls.push({
                  id: currentToolBlock.id,
                  name: currentToolBlock.name,
                  arguments: JSON.parse(currentToolBlock.inputBuffer || '{}'),
                });
              } catch { /* skip malformed tool args */ }
              currentToolBlock = null;
            }
            if (event.type === 'message_delta' && event.usage) {
              usage = event.usage;
            }
            if (event.type === 'message_start' && event.message?.usage) {
              usage = event.message.usage;
            }
          } catch { /* skip malformed events */ }
        }
      }
    }

    const tokenUsage: TokenUsage = {
      promptTokens: usage?.input_tokens ?? 0,
      completionTokens: usage?.output_tokens ?? 0,
      totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    };

    return {
      content,
      model,
      usage: tokenUsage,
      finishReason: 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private parseResponse(data: any, model: string): LLMResponse {
    const content = data.content ?? [];
    const textBlocks = content.filter((c: any) => c.type === 'text');
    const toolBlocks = content.filter((c: any) => c.type === 'tool_use');

    const usage: TokenUsage = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    };

    return {
      content: textBlocks.map((b: any) => b.text).join(''),
      model,
      usage,
      finishReason: 'stop',
      toolCalls: toolBlocks.map((b: any) => ({
        id: b.id,
        name: b.name,
        arguments: b.input ?? {},
      })),
    };
  }
}
