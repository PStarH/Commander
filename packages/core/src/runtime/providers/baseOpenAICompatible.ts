/**
 * Base class for OpenAI-compatible LLM providers.
 *
 * Many providers (DeepSeek, GLM, MiMo, Xiaomi, Ollama, vLLM, Groq,
 * Together AI, Perplexity, Mistral, Fireworks, etc.) use the OpenAI
 * chat completions format. This base eliminates duplication of:
 * - Streaming SSE parsing
 * - Tool call handling (JSON + text-format)
 * - Error handling
 * - Body construction
 *
 * Subclasses need only set their default config and optionally override
 * buildBody() or parseResponse() for provider-specific behavior.
 */

import type { LLMProvider, LLMRequest, LLMResponse, TokenUsage } from '../types';
import { FormatBridge } from '../formatBridge';
import { getGlobalLogger } from '../../logging';

// ============================================================================
// Shared Types
// ============================================================================

export interface OpenAICompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface OpenAIStreamChunk {
  choices: Array<{
    delta: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type: string;
        function: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: OpenAICompletionsUsage;
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /** Provider name tag used in logs/headers */
  name: string;
  /** Whether this is a local provider (no API key required) */
  isLocal?: boolean;
  /** Extra headers to send with every request */
  extraHeaders?: Record<string, string>;
}

// ============================================================================
// Shared utilities
// ============================================================================

/**
 * Parse OpenAI SSE stream into content, reasoning, tool calls, and usage.
 */
export async function parseOpenAIStream(
  response: Response,
  logger: ReturnType<typeof getGlobalLogger>,
): Promise<{
  content: string;
  reasoningContent: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: OpenAICompletionsUsage | null;
}> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OpenAI-compatible: No response body from streaming endpoint');

  let content = '';
  let reasoningContent = '';
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let currentTool: { id: string; name: string; arguments: string } | null = null;
  let usage: OpenAICompletionsUsage | null = null;
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
      if (jsonStr === '[DONE]') continue;

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
      } catch (e) {
        logger.debug('BaseOpenAI', 'Skipping malformed stream chunk', {
          error: (e as Error)?.message,
        });
      }
    }
  }

  return { content, reasoningContent, toolCalls, usage };
}

/**
 * Parse OpenAI non-streaming response into LLMResponse.
 */
export function parseOpenAIResponse(
  data: any,
  model: string,
  extractTextToolCalls?: (content: string) => Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null,
): LLMResponse {
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};

  const tokenUsage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };

  let content = message.content ?? '';
  let toolCalls = message.tool_calls?.map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments || '{}'),
  }));

  // Some providers return tool calls as text (e.g. MiMo text format)
  if ((!toolCalls || toolCalls.length === 0) && content && extractTextToolCalls) {
    const parsed = extractTextToolCalls(content);
    if (parsed && parsed.length > 0) {
      toolCalls = parsed;
      content = '';
    }
  }

  // Merge reasoning_content into content for models that put output there
  if (!content && message.reasoning_content) {
    content = message.reasoning_content;
  }

  return {
    content,
    model,
    usage: tokenUsage,
    finishReason: choice?.finish_reason === 'stop' ? 'stop'
      : choice?.finish_reason === 'tool_calls' ? 'tool_calls'
      : choice?.finish_reason === 'length' ? 'length'
      : 'stop',
    toolCalls,
    reasoning_content: message.reasoning_content,
  };
}

/**
 * Build the standard OpenAI-compatible request body.
 */
export function buildOpenAIBody(
  request: LLMRequest,
  model: string,
  providerName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
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
    ...extra,
  };

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.stop && request.stop.length > 0) body.stop = request.stop;

  if (request.tools && request.tools.length > 0) {
    body.tools = FormatBridge.adaptToolsForProvider(request.tools, providerName);
    body.parallel_tool_calls = true;
  }

  return body;
}

/**
 * Standard OpenAI-compatible API call.
 * Handles streaming and non-streaming, auto-detects which to use.
 */
export async function callOpenAICompatibleAPI(
  config: OpenAICompatibleConfig,
  request: LLMRequest,
  model: string,
  extractTextToolCalls?: (content: string) => Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null,
  extraBody?: Record<string, unknown>,
): Promise<LLMResponse> {
  const body = buildOpenAIBody(request, model, config.name, extraBody);

  // Include tool_calls from last assistant message (for multi-turn)
  const lastAssistant = [...request.messages].reverse().find(m => m.role === 'assistant');
  if (lastAssistant?.tool_calls) {
    body.tool_calls = lastAssistant.tool_calls;
  }

  const useStreaming = request.cacheConfig?.useCacheControl ?? true;
  const logger = getGlobalLogger();

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
      ...config.extraHeaders,
    },
    body: JSON.stringify({ ...body, stream: useStreaming }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`${config.name} API error ${response.status}: ${err}`);
  }

  if (useStreaming) {
    const streamed = await parseOpenAIStream(response, logger);
    const tokenUsage: TokenUsage = streamed.usage
      ? {
          promptTokens: streamed.usage.prompt_tokens,
          completionTokens: streamed.usage.completion_tokens,
          totalTokens: streamed.usage.total_tokens,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    return {
      content: streamed.content,
      model,
      usage: tokenUsage,
      finishReason: 'stop',
      toolCalls: streamed.toolCalls.length > 0
        ? streamed.toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.parse(tc.arguments || '{}'),
          }))
        : undefined,
      reasoning_content: streamed.reasoningContent || undefined,
    };
  }

  const data = await response.json();
  return parseOpenAIResponse(data, model, extractTextToolCalls);
}

// ============================================================================
// Abstract base class
// ============================================================================

export abstract class BaseOpenAICompatibleProvider implements LLMProvider {
  abstract readonly name: string;
  protected config: OpenAICompatibleConfig;

  constructor(config: { apiKey: string; baseUrl?: string; defaultModel?: string; name?: string }) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl ?? this.getDefaultBaseUrl(),
      defaultModel: config.defaultModel ?? this.getDefaultModel(),
      name: config.name ?? 'unknown',
      ...this.getExtraConfig(),
    };
    // Override config.name with the concrete class's name (avoid abstract in constructor)
    if (!config.name) {
      this.config.name = (this.constructor as any).name?.replace('Provider', '').toLowerCase() || this.config.name;
    }
  }

  /** Override to provide the default base URL */
  protected abstract getDefaultBaseUrl(): string;
  /** Override to provide the default model name */
  protected abstract getDefaultModel(): string;
  /** Override to provide extra config (headers, isLocal, etc.) */
  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {};
  }
  /** Override to provide extra body fields per-request */
  protected getExtraBody(_request: LLMRequest): Record<string, unknown> {
    return {};
  }
  /** Override for providers that emit text-format tool calls */
  protected extractTextToolCalls(_content: string): Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null {
    return null;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    const model = request.model || this.config.defaultModel;
    return callOpenAICompatibleAPI(
      this.config,
      request,
      model,
      (content: string) => this.extractTextToolCalls(content),
      this.getExtraBody(request),
    );
  }
}
