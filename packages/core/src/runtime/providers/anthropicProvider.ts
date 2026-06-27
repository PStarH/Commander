import type { LLMProvider, LLMRequest, LLMResponse, TokenUsage } from '../types';
import { FormatBridge } from '../formatBridge';
import { getGlobalLogger } from '../../logging';
import { executeViaBatchAPI, supportsNativeBatchAPI, type BatchAPIConfig } from '../batchApiClient';

interface AnthropicContent {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
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

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
    this.defaultModel = config.defaultModel ?? 'claude-3-5-sonnet-20241022';
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    // ── Batch API path (50% cost discount for non-urgent tasks) ──
    // When isBatch flag is set, try native batch API first.
    // Fail-closed: if batch fails or times out, fall back to standard API.
    if (request.cacheConfig?.isBatch && supportsNativeBatchAPI(this.name)) {
      const batchConfig: BatchAPIConfig = {
        pollIntervalMs: 10000,
        maxPollAttempts: 60, // 10 min max wait
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
      };
      const batchResult = await executeViaBatchAPI(request, this.name, batchConfig);
      if (batchResult) {
        batchResult.model = request.model || this.defaultModel;
        return batchResult;
      }
      getGlobalLogger().warn('AnthropicProvider', 'Batch API failed, falling back to standard API');
    }

    // ── Standard API path ──
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
      body.tools = FormatBridge.adaptToolsForProvider(request.tools, 'anthropic');
      if (request.cacheConfig?.cacheTools) {
        const toolCacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' } = { type: 'ephemeral' };
        if (request.cacheConfig?.cacheTtl) toolCacheControl.ttl = request.cacheConfig.cacheTtl;
        (body.tools as Record<string, unknown>[]).forEach((t: Record<string, unknown>) => {
          t.cache_control = toolCacheControl;
        });
      }
    }

    // Anthropic recommends top-level cache_control for automatic breakpoint management.
    // This auto-manages cache breakpoints as the conversation grows, eliminating the
    // need for manual cache_control markers on individual content blocks.
    // We use it when cacheSystemPrompt is enabled; the system block cache_control above
    // is still compatible and provides the initial breakpoint.
    if (request.cacheConfig?.cacheSystemPrompt && request.cacheConfig?.useCacheControl) {
      const topLevelCache: { type: string; ttl?: string } = { type: 'ephemeral' };
      if (request.cacheConfig?.cacheTtl) topLevelCache.ttl = request.cacheConfig.cacheTtl;
      body.cache_control = topLevelCache;
    }

    // Extended Thinking with tool use (beta feature).
    // Enables Claude's internal chain-of-thought reasoning before responding.
    // Requires anthropic-beta header: "interleaved-thinking-2025-05-14"
    const rc = request.reasoningConfig;
    if (rc?.enabled) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: rc.budget ?? 4096,
      };
    }

    // Anthropic does not support response_format natively. Use a dummy tool
    // with the output schema as its input_schema so the model can emit
    // structured data via tool_use.
    if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
      const structuredTool = {
        name: 'structured_output',
        description: 'Emit the final answer as structured JSON matching the requested schema.',
        input_schema: request.responseFormat.schema,
      };
      if (!body.tools) body.tools = [];
      (body.tools as Record<string, unknown>[]).push(structuredTool);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
      ...(useStreaming ? { accept: 'text/event-stream' } : {}),
    };
    // Extended Thinking requires beta header
    if (request.reasoningConfig?.enabled) {
      headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers,
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
    const systemMsg = request.messages.find((m) => m.role === 'system');
    if (!systemMsg) return undefined;

    const blocks: AnthropicContent[] = [
      {
        type: 'text',
        text: systemMsg.content,
      },
    ];

    if (request.cacheConfig?.cacheSystemPrompt) {
      blocks[0].cache_control = { type: 'ephemeral' };
      if (request.cacheConfig?.cacheTtl)
        blocks[0].cache_control!.ttl = request.cacheConfig.cacheTtl;
    }

    return blocks;
  }

  private async handleStreamingResponse(response: Response, model: string): Promise<LLMResponse> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Anthropic: No response body from streaming endpoint');

    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    let currentToolBlock: { id: string; name: string; inputBuffer: string } | null = null;
    let usage: AnthropicUsage | null = null;
    let stopReason: string | null = null;
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
            if (
              event.type === 'content_block_delta' &&
              event.delta?.type === 'input_json_delta' &&
              currentToolBlock
            ) {
              currentToolBlock.inputBuffer += event.delta.partial_json;
            }
            if (event.type === 'content_block_stop' && currentToolBlock) {
              try {
                toolCalls.push({
                  id: currentToolBlock.id,
                  name: currentToolBlock.name,
                  arguments: JSON.parse(currentToolBlock.inputBuffer || '{}'),
                });
              } catch (e) {
                getGlobalLogger().debug('AnthropicProvider', 'Skipping malformed tool args', {
                  error: (e as Error)?.message,
                });
              }
              currentToolBlock = null;
            }
            if (event.type === 'message_delta') {
              if (event.usage) usage = event.usage;
              if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
            }
            if (event.type === 'message_start' && event.message?.usage) {
              usage = event.message.usage;
            }
          } catch (e) {
            getGlobalLogger().debug('AnthropicProvider', 'Skipping malformed stream event', {
              error: (e as Error)?.message,
            });
          }
        }
      }
    }

    const tokenUsage: TokenUsage = {
      promptTokens: usage?.input_tokens ?? 0,
      completionTokens: usage?.output_tokens ?? 0,
      totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    };

    const structuredTool = toolCalls.find((tc) => tc.name === 'structured_output');
    const parsed = structuredTool?.arguments;
    const normalToolCalls = toolCalls.filter((tc) => tc.name !== 'structured_output');

    return {
      content,
      model,
      usage: tokenUsage,
      finishReason:
        stopReason === 'end_turn'
          ? 'stop'
          : stopReason === 'max_tokens'
            ? 'length'
            : stopReason === 'tool_use'
              ? 'tool_calls'
              : 'stop',
      toolCalls: normalToolCalls.length > 0 ? normalToolCalls : undefined,
      parsed,
    };
  }

  private parseResponse(
    data: {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string | null;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    },
    model: string,
  ): LLMResponse {
    const content = data.content ?? [];
    const textBlocks = content.filter((c): c is typeof c & { text: string } => c.type === 'text');
    const toolBlocks = content.filter(
      (c): c is typeof c & { id: string; name: string; input: unknown } => c.type === 'tool_use',
    );

    const usage: TokenUsage = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    };

    const structuredTool = toolBlocks.find((b) => b.name === 'structured_output');
    const parsed =
      structuredTool?.input && typeof structuredTool.input === 'object'
        ? (structuredTool.input as Record<string, unknown>)
        : undefined;
    const normalToolCalls = toolBlocks
      .filter((b) => b.name !== 'structured_output')
      .map((b) => ({
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}) as Record<string, unknown>,
      }));

    const stopReason = data.stop_reason ?? 'end_turn';
    return {
      content: textBlocks.map((b) => b.text).join(''),
      model,
      usage,
      finishReason:
        stopReason === 'end_turn'
          ? 'stop'
          : stopReason === 'max_tokens'
            ? 'length'
            : stopReason === 'tool_use'
              ? 'tool_calls'
              : 'stop',
      toolCalls: normalToolCalls.length > 0 ? normalToolCalls : undefined,
      parsed,
    };
  }
}
