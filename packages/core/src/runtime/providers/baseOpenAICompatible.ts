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

import { reportSilentFailure } from '../../silentFailureReporter';
import type { LLMProvider, LLMRequest, LLMResponse, TokenUsage } from '../types';
import { FormatBridge } from '../formatBridge';
import { getGlobalLogger } from '../../logging';
import { assertSafeProviderBaseUrl } from './providerUrlPolicy';
import { parseTextToolCalls } from '../toolCallRepair';

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
      /** Standard reasoning/thinking field (DeepSeek, MiMo, etc.) */
      reasoning_content?: string;
      /**
       * OpenRouter reasoning field. OpenRouter streams reasoning content via
       * `delta.reasoning` instead of `delta.reasoning_content`. Read as a
       * fallback so OpenRouter-compatible reasoning models are captured.
       */
      reasoning?: string;
      tool_calls?: Array<{
        index?: number;
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
  /**
   * Optional URL builder override for chat-completions. Receives the configured
   * `baseUrl` and the resolved model name. Default is `${baseUrl}/chat/completions`.
   * Use providers like Azure OpenAI whose URL embeds the deployment name in the
   * path AND a query string for the api-version:
   *   `${baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${apiVersion}`
   */
  urlBuilder?: (baseUrl: string, model: string) => string;
  /**
   * Optional auth header name override. Default `Authorization`. Azure OpenAI
   * uses `api-key` instead, per the Azure OpenAI REST API contract.
   */
  authHeaderName?: string;
  /**
   * Optional auth header value prefix override. Default `Bearer ` (sends
   * `Authorization: Bearer <key>`). Azure OpenAI sends the key with no prefix
   * (`api-key: <key>`). Leave empty for that case.
   */
  authHeaderPrefix?: string;
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
  finishReason: string | null;
}> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OpenAI-compatible: No response body from streaming endpoint');

  let content = '';
  let reasoningContent = '';
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  const toolsByIndex = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: OpenAICompletionsUsage | null = null;
  let finishReason: string | null = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const toolIndexById = new Map<string, number>();
  let nextImplicitToolIndex = 0;
  let lastImplicitToolIndex: number | undefined;

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data: ')) return;
    const jsonStr = trimmed.slice(6);
    if (jsonStr === '[DONE]') return;

    try {
      const chunk: OpenAIStreamChunk = JSON.parse(jsonStr);
      if (chunk.usage) usage = chunk.usage;

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
        if (delta.reasoning) reasoningContent += delta.reasoning;
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const indexed = Number.isInteger(tc.index) ? tc.index : undefined;
            const identified = tc.id ? toolIndexById.get(tc.id) : undefined;
            const index =
              indexed ??
              identified ??
              (tc.id
                ? nextImplicitToolIndex++
                : (lastImplicitToolIndex ?? nextImplicitToolIndex++));
            if (tc.id) toolIndexById.set(tc.id, index);
            if (indexed === undefined) lastImplicitToolIndex = index;
            let tool = toolsByIndex.get(index);
            if (!tool) {
              tool = { id: tc.id ?? `tool_${index}`, name: '', arguments: '' };
              toolsByIndex.set(index, tool);
              toolCalls.push(tool);
            }
            if (tc.id) tool.id = tc.id;
            if (tc.function?.name) tool.name += tc.function.name;
            if (tc.function?.arguments) tool.arguments += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      logger.debug('BaseOpenAI', 'Skipping malformed stream chunk', {
        error: (e as Error)?.message,
      });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) processLine(line);
  }

  // Some proxies close the stream without a trailing newline. Process the
  // final buffered SSE record so the last argument/usage chunk is not lost.
  if (buffer.trim()) processLine(buffer);

  return {
    content,
    reasoningContent,
    toolCalls: dedupeStreamToolCalls(toolCalls),
    usage,
    finishReason,
  };
}

/**
 * Parse OpenAI non-streaming response into LLMResponse.
 */
interface OpenAIResponseChoice {
  message?: {
    content?: string;
    tool_calls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    /** Standard reasoning/thinking field (DeepSeek, MiMo, etc.) */
    reasoning_content?: string;
    /**
     * OpenRouter reasoning field. OpenRouter returns reasoning content via
     * `message.reasoning` instead of `message.reasoning_content`. Read as a
     * fallback so OpenRouter-compatible reasoning models are captured.
     */
    reasoning?: string;
  };
  finish_reason?: string;
}
interface OpenAIResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

type NormalizedToolCall = { id: string; name: string; arguments: Record<string, unknown> };

/** Stable enough for tool arguments, which are JSON values produced by providers. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

/**
 * Providers occasionally emit the same tool call more than once in one
 * assistant turn. Treat exact name+argument duplicates as one call so an
 * idempotency key cannot be defeated by provider-generated call IDs.
 */
function dedupeToolCalls(toolCalls: NormalizedToolCall[]): NormalizedToolCall[] {
  const seen = new Set<string>();
  return toolCalls.filter((toolCall) => {
    const key = `${toolCall.name}\n${stableJson(toolCall.arguments)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStreamToolCalls(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
): Array<{ id: string; name: string; arguments: string }> {
  const seen = new Set<string>();
  return toolCalls.filter((toolCall) => {
    let args: unknown = toolCall.arguments;
    try {
      args = JSON.parse(toolCall.arguments || '{}');
    } catch {
      // Keep the raw argument string as the identity when it is malformed.
    }
    const key = `${toolCall.name}\n${stableJson(args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeFinishReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): LLMResponse['finishReason'] {
  if (reason === 'length') return 'length';
  if (reason === 'error') return 'error';
  if (reason === 'tool_calls' || hasToolCalls) return 'tool_calls';
  return 'stop';
}

export function parseOpenAIResponse(
  data: { choices?: OpenAIResponseChoice[]; usage?: OpenAIResponseUsage },
  model: string,
  extractTextToolCalls?: (
    content: string,
  ) => Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null,
  responseFormat?: LLMRequest['responseFormat'],
): LLMResponse {
  const choice = data.choices?.[0];
  const message = choice?.message ?? {};

  const tokenUsage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
    cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };

  let content = message.content ?? '';
  let toolCalls = message.tool_calls?.map(
    (tc: { id: string; function: { name: string; arguments: string } }) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(tc.function.arguments || '{}');
      } catch (err) {
        reportSilentFailure(err, 'baseOpenAICompatible:178');
        try {
          parsed = JSON.parse(`{${tc.function.arguments}}`);
        } catch (err) {
          reportSilentFailure(err, 'baseOpenAICompatible:182');
          parsed = { raw: tc.function.arguments };
        }
      }
      return { id: tc.id, name: tc.function.name, arguments: parsed };
    },
  );

  // Some providers return tool calls as text (e.g. MiMo text format)
  if ((!toolCalls || toolCalls.length === 0) && content && extractTextToolCalls) {
    const parsed = extractTextToolCalls(content);
    if (parsed && parsed.length > 0) {
      toolCalls = parsed;
      content = '';
    }
  }

  if (toolCalls && toolCalls.length > 1) toolCalls = dedupeToolCalls(toolCalls);

  // Merge reasoning_content into content for models that put output there.
  // Prefer the standard `reasoning_content` field (DeepSeek/MiMo); fall back
  // to OpenRouter's `reasoning` field so reasoning is captured regardless of
  // which field the provider populates.
  const reasoningContent = message.reasoning_content ?? message.reasoning;
  if (!content && reasoningContent) {
    content = reasoningContent;
  }

  return {
    content,
    model,
    usage: tokenUsage,
    finishReason: normalizeFinishReason(choice?.finish_reason, !!toolCalls?.length),
    toolCalls,
    parsed: tryParseOpenAICompatibleStructured(content, responseFormat),
    reasoning_content: reasoningContent,
  };
}

function tryParseOpenAICompatibleStructured(
  content: string,
  responseFormat?: LLMRequest['responseFormat'],
): Record<string, unknown> | undefined {
  if (!responseFormat || responseFormat.type === 'text' || !content.trim()) return undefined;

  const trimmed = content.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch (err) {
    reportSilentFailure(err, 'baseOpenAICompatible:234');
    return undefined;
  }
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
  const messages = request.messages.map((m) => {
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
    const configuredParallelToolCalls = extra.parallel_tool_calls;
    body.parallel_tool_calls =
      typeof configuredParallelToolCalls === 'boolean'
        ? configuredParallelToolCalls
        : (request.parallelToolCalls ?? false);
  }

  // Provider-native structured output for OpenAI-compatible endpoints
  if (request.responseFormat) {
    if (request.responseFormat.type === 'json_schema' && request.responseFormat.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name ?? 'response',
          schema: request.responseFormat.schema,
          strict: true,
        },
      };
    } else if (request.responseFormat.type === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
  }

  // Propagate prompt_cache_key for providers that support OpenAI-style cache routing
  // (xAI, Groq, Together, etc.). Providers that don't support it will simply ignore
  // the unknown field per OpenAI-compatible API convention.
  if (request.cacheConfig?.promptCacheKey) {
    body.prompt_cache_key = request.cacheConfig.promptCacheKey;
  }

  // Apply reasoning configuration for providers that support it
  // (DeepSeek-Reasoner, Grok, etc.). Providers that don't support
  // reasoning_effort will ignore the unknown field.
  //
  // Some providers use a provider-specific reasoning envelope instead of the
  // flat `reasoning_effort`/`max_thinking_tokens` fields. For example,
  // OpenRouter expects `reasoning: { enabled, effort, max_tokens }`. When a
  // subclass supplies such an object via getExtraBody (present in `extra`),
  // the standard flat fields are suppressed to avoid emitting conflicting
  // reasoning directives. The subclass's `reasoning` object (spread into the
  // body above) already carries the equivalent configuration.
  const rc = request.reasoningConfig;
  if (
    rc?.enabled &&
    !('reasoning' in extra) &&
    !('chat_template_kwargs' in extra) &&
    !('thinking' in extra)
  ) {
    if (rc.effort) body.reasoning_effort = rc.effort;
    if (rc.budget && rc.budget > 0) body.max_thinking_tokens = rc.budget;
  }

  return body;
}

/**
 * Standard OpenAI-compatible API call.
 * Handles streaming and non-streaming, auto-detects which to use.
 *
 * Includes automatic retry for transient HTTP errors (429 rate limit, 5xx
 * server errors) with exponential backoff and Retry-After header respect.
 * This ensures the framework is resilient to provider rate limiting without
 * requiring callers to implement their own retry logic.
 */
export async function callOpenAICompatibleAPI(
  config: OpenAICompatibleConfig,
  request: LLMRequest,
  model: string,
  extractTextToolCalls?: (
    content: string,
  ) => Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null,
  extraBody?: Record<string, unknown>,
): Promise<LLMResponse> {
  const body = buildOpenAIBody(request, model, config.name, extraBody);

  // MCP-11: fail closed before any secret/prompt leaves the process if the
  // resolved base URL is plaintext or off the configured host allowlist.
  assertSafeProviderBaseUrl(config.baseUrl, { providerName: config.name, isLocal: config.isLocal });

  const useStreaming = request.cacheConfig?.useCacheControl ?? true;
  const logger = getGlobalLogger();

  // Providers can override the URL builder (e.g. Azure) and the auth header
  // scheme (e.g. Azure's `api-key` instead of `Authorization: Bearer`). These
  // are resolved once per call so the retry loop reuses the same endpoint —
  // recomputing per attempt would risk inconsistencies under provider rotation.
  const url = config.urlBuilder
    ? config.urlBuilder(config.baseUrl, model)
    : `${config.baseUrl}/chat/completions`;
  const authHeaderName = config.authHeaderName ?? 'Authorization';
  const authHeaderPrefix = config.authHeaderPrefix ?? 'Bearer ';

  // Retry transient HTTP and network errors at the provider level.
  // This catches rate limits before they bubble up to the runtime's
  // retry loop, which has limited error context.
  const MAX_HTTP_RETRIES = 4; // 5 total attempts
  const BASE_BACKOFF_MS = 1000;
  const MAX_BACKOFF_MS = 60000;

  let lastError: Error | undefined;

  for (let httpAttempt = 0; httpAttempt <= MAX_HTTP_RETRIES; httpAttempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [authHeaderName]: `${authHeaderPrefix}${config.apiKey}`,
          ...config.extraHeaders,
        },
        body: JSON.stringify({ ...body, stream: useStreaming }),
      });
    } catch (err) {
      if (!isRetryableNetworkError(err) || httpAttempt >= MAX_HTTP_RETRIES) throw err;

      const delayMs = computeHttpBackoff(httpAttempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
      logger.warn('BaseOpenAI', `Retrying ${config.name} after network failure`, {
        attempt: httpAttempt + 1,
        maxAttempts: MAX_HTTP_RETRIES + 1,
        delayMs,
        endpoint: url,
        error: err instanceof Error ? err.message : String(err),
      });
      await waitForRetry(delayMs);
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    if (response.ok) {
      // Success — parse the response
      if (useStreaming) {
        const streamed = await parseOpenAIStream(response, logger);
        const extractedTextToolCalls =
          streamed.toolCalls.length === 0 && streamed.content && extractTextToolCalls
            ? extractTextToolCalls(streamed.content)
            : null;
        const tokenUsage: TokenUsage = streamed.usage
          ? {
              promptTokens: streamed.usage.prompt_tokens,
              completionTokens: streamed.usage.completion_tokens,
              totalTokens: streamed.usage.total_tokens,
              cacheReadTokens: streamed.usage.prompt_tokens_details?.cached_tokens ?? 0,
            }
          : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        const normalizedToolCalls =
          streamed.toolCalls.length > 0
            ? streamed.toolCalls.map((tc) => {
                let parsed: Record<string, unknown> = {};
                try {
                  parsed = JSON.parse(tc.arguments || '{}');
                } catch (err) {
                  reportSilentFailure(err, 'baseOpenAICompatible:347');
                  try {
                    parsed = JSON.parse(`{${tc.arguments}}`);
                  } catch (err) {
                    reportSilentFailure(err, 'baseOpenAICompatible:351');
                    parsed = { raw: tc.arguments };
                  }
                }
                return { id: tc.id, name: tc.name, arguments: parsed };
              })
            : (extractedTextToolCalls ?? []);

        const toolCalls =
          normalizedToolCalls.length > 0 ? dedupeToolCalls(normalizedToolCalls) : undefined;
        return {
          content: toolCalls?.length ? '' : streamed.content,
          model,
          usage: tokenUsage,
          finishReason: normalizeFinishReason(streamed.finishReason, !!toolCalls?.length),
          toolCalls,
          parsed: tryParseOpenAICompatibleStructured(
            toolCalls?.length ? '' : streamed.content,
            request.responseFormat,
          ),
          reasoning_content: streamed.reasoningContent || undefined,
        };
      }

      const data = await response.json();
      return parseOpenAIResponse(data, model, extractTextToolCalls, request.responseFormat);
    }

    // Non-OK response: check if retryable
    const errorBody = await response.text();
    const isRateLimit = response.status === 429;
    const isServerError = response.status >= 500 && response.status < 600;

    if ((isRateLimit || isServerError) && httpAttempt < MAX_HTTP_RETRIES) {
      // Respect Retry-After header for 429s
      const retryAfterHeader =
        response.headers.get('retry-after') ?? response.headers.get('Retry-After');
      let delayMs: number;
      if (retryAfterHeader) {
        const retryAfterSec = parseInt(retryAfterHeader, 10);
        delayMs = isNaN(retryAfterSec)
          ? computeHttpBackoff(httpAttempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS)
          : retryAfterSec * 1000;
      } else {
        delayMs = computeHttpBackoff(httpAttempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
      }

      logger.warn('BaseOpenAI', `Retrying ${config.name} after ${response.status}`, {
        attempt: httpAttempt + 1,
        maxAttempts: MAX_HTTP_RETRIES + 1,
        delayMs,
        endpoint: url,
      });

      await waitForRetry(delayMs);

      lastError = new Error(`${config.name} API error ${response.status}: ${errorBody}`);
      continue;
    }

    // Non-retryable error or retries exhausted
    throw new Error(`${config.name} API error ${response.status}: ${errorBody}`);
  }

  // All HTTP retries exhausted
  throw lastError ?? new Error(`${config.name} API: all retry attempts exhausted`);
}

function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as { name?: unknown; message?: unknown; code?: unknown };
  if (error.name === 'AbortError') return false;
  const message = `${String(error.message ?? '')} ${String(error.code ?? '')}`;
  return /fetch failed|network|econnreset|econnrefused|enotfound|eai_again|etimedout|esockettimedout|socket hang up|epipe/i.test(
    message,
  );
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/** Exponential backoff with jitter for HTTP-level retries. */
function computeHttpBackoff(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = exponential * 0.2 * (Math.random() - 0.5);
  return Math.min(Math.round(exponential + jitter), maxMs);
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
      this.config.name =
        (this.constructor as { name: string }).name?.replace('Provider', '').toLowerCase() ||
        this.config.name;
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
  protected extractTextToolCalls(
    content: string,
  ): Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null {
    const parsed = parseTextToolCalls(content);
    return parsed.length > 0 ? parsed : null;
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
