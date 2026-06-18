// ============================================================================
// LLM Provider Abstraction
// ============================================================================

import type { TokenUsage } from './shared';
import type { ToolDefinition, ToolCall } from './tool';

/**
 * A single message in a conversation with an LLM.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  /** MiMo reasoning models put internal reasoning here. Must be passed back on follow-up calls. */
  reasoning_content?: string;
  /** OpenAI-format tool calls for assistant messages */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Reasoning/thinking configuration for LLM providers that support it.
 * Controls whether the model performs internal reasoning before answering.
 */
export interface ReasoningConfig {
  /** Enable reasoning/thinking tokens (default: model-dependent) */
  enabled: boolean;
  /** Maximum tokens for reasoning/thinking (0 = use provider default) */
  budget?: number;
  /** Effort level — some providers support low/medium/high reasoning effort */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Request payload sent to an LLM provider.
 */
export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  cacheConfig?: CacheConfig;
  /** Reasoning/thinking config for supported providers (e.g. MiMo, OpenAI o-series) */
  reasoningConfig?: ReasoningConfig;
  /** Provider-native structured output format. */
  responseFormat?: {
    type: 'json_object' | 'json_schema' | 'text';
    /** JSON Schema for json_schema mode. */
    schema?: Record<string, unknown>;
    /** Name for the structured output schema (OpenAI json_schema). */
    name?: string;
  };
}

/**
 * Record of a single LLM API call for audit/provenance purposes.
 * Written to samples store for every call.
 */
export interface ApiCallRecord {
  /** Schema version for forward-compatible deserialization */
  schemaVersion?: number;
  /** Unique call ID */
  callId: string;
  /** Run/mission context */
  runId?: string;
  agentId?: string;
  /** Request snapshot */
  model: string;
  provider: string;
  temperature?: number;
  maxTokens?: number;
  reasoningConfig?: ReasoningConfig;
  /** Token usage */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Performance */
  durationMs: number;
  finishReason: string;
  /** Whether this was a retry */
  attemptNumber: number;
  /** Truncated content for audit (first 500 chars) */
  contentPrefix: string;
  /** Extracted code solution (eval context: function body or full solution from response) */
  extractedCode?: string;
  /** Error if any */
  error?: string;
  /** Evaluation task ID (e.g. "HumanEval/64") */
  taskId?: string;
  /** Full request messages for full prompt/response replay (debugging) */
  fullMessages?: unknown[];
  /** Full LLM response object (replay/audit) */
  fullResponse?: unknown;
  /** Reasoning / chain-of-thought content from extended-thinking providers */
  reasoningContent?: string;
  /** Tenant that owns this call (multi-tenant isolation) */
  tenantId?: string;
  /** Parent runId for sub-agent correlation */
  parentRunId?: string;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Configuration for prompt caching across providers.
 *
 * Provider details:
 * - Anthropic: cache_control markers on system prompt or tool defs. 90% off reads.
 *   Min 1024 tokens for cache write. 1.25x write premium (5min), 2x (1hr TTL).
 * - OpenAI: automatic on prompts >1024 tokens. 50% off reads. 5-10min TTL.
 * - Gemini: automatic on prompts >4K tokens. 90% off reads. Configurable TTL.
 */
export interface CacheConfig {
  /** Mark the system prompt block as cacheable */
  cacheSystemPrompt: boolean;
  /** Mark tool definitions as cacheable */
  cacheTools: boolean;
  /** Mark the conversation history (up to N messages) as cacheable */
  cacheHistory?: number;
  /** Explicit cache_control markers (Anthropic-style) */
  useCacheControl: boolean;
  /** Anthropic cache TTL: '5m' (default, 1.25x write) or '1h' (2x write, 90% off reads) */
  cacheTtl?: '5m' | '1h';
  /** OpenAI prompt_cache_key for routing stickiness across requests */
  promptCacheKey?: string;
  /**
   * Google Gemini server-side cachedContent resource name (e.g. "cachedContents/abc123").
   * When set, the provider references the pre-created cached content and Gemini bills
   * cached tokens at 90% discount on payloads >4K tokens. See geminiCacheManager.ts.
   */
  geminiCachedContentName?: string;
  /** When true, provider should use batch API mode for 50% cost savings (24h turnaround). */
  isBatch?: boolean;
}

export interface SemanticCacheRuntimeConfig {
  enabled: boolean;
  similarityThreshold?: number;
  maxEntries?: number;
  defaultTtlMs?: number;
  maxBucketSize?: number;
  cacheStochastic?: boolean;
  cacheToolCalls?: boolean;
  pruneIntervalMs?: number;
  openaiApiKey?: string;
  embeddingModel?: string;
  embeddingBaseUrl?: string;
}

export interface SingleFlightRuntimeConfig {
  enabled: boolean;
  maxInFlight?: number;
}

/**
 * Configuration for the Google Gemini cachedContent manager.
 * Manages server-side cached content resource lifecycle (create + LRU + eviction).
 * Default: enabled with 100 max entries, 5-minute TTL.
 */
export interface GeminiCacheRuntimeConfig {
  /** When false, getOrCreate is a no-op (no network call, no cached name returned). */
  enabled?: boolean;
  /** LRU cap on cached content names. Default 100. */
  maxEntries?: number;
  /** TTL sent to Gemini at create time. Default 300s (5m). Max 86400 (24h). */
  defaultTtlSeconds?: number;
  /** Per-create request timeout in ms. Default 30s. */
  fetchTimeoutMs?: number;
}

export interface CacheUsage {
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Response from an LLM provider.
 */
export interface LLMResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  toolCalls?: ToolCall[];
  /** Provider-native parsed structured output, when responseFormat was used. */
  parsed?: Record<string, unknown>;
  /** MiMo reasoning models put internal reasoning here. Present on responses from reasoning models. */
  reasoning_content?: string;
}

/**
 * Provider-native streaming event. Providers may expose this in addition to
 * call() when they need protocol-specific streaming behavior.
 */
export interface LLMStreamChunk {
  contentDelta?: string;
  toolCallDelta?: Partial<ToolCall>;
  usage?: Partial<TokenUsage>;
  done?: boolean;
}

/**
 * Abstract LLM provider interface.
 * Implementations: OpenAI, Anthropic, Google, MockLLMProvider
 */
export interface LLMProvider {
  readonly name: string;
  call(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}
