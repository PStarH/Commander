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
import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
import { getGlobalLogger } from '../../logging';
export interface OpenAICompletionsUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
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
                function: {
                    name?: string;
                    arguments?: string;
                };
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
/**
 * Parse OpenAI SSE stream into content, reasoning, tool calls, and usage.
 */
export declare function parseOpenAIStream(response: Response, logger: ReturnType<typeof getGlobalLogger>): Promise<{
    content: string;
    reasoningContent: string;
    toolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
    }>;
    usage: OpenAICompletionsUsage | null;
}>;
/**
 * Parse OpenAI non-streaming response into LLMResponse.
 */
interface OpenAIResponseChoice {
    message?: {
        content?: string;
        tool_calls?: Array<{
            id: string;
            function: {
                name: string;
                arguments: string;
            };
        }>;
        reasoning_content?: string;
    };
    finish_reason?: string;
}
interface OpenAIResponseUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
}
export declare function parseOpenAIResponse(data: {
    choices?: OpenAIResponseChoice[];
    usage?: OpenAIResponseUsage;
}, model: string, extractTextToolCalls?: (content: string) => Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}> | null, responseFormat?: LLMRequest['responseFormat']): LLMResponse;
/**
 * Build the standard OpenAI-compatible request body.
 */
export declare function buildOpenAIBody(request: LLMRequest, model: string, providerName: string, extra?: Record<string, unknown>): Record<string, unknown>;
/**
 * Standard OpenAI-compatible API call.
 * Handles streaming and non-streaming, auto-detects which to use.
 */
export declare function callOpenAICompatibleAPI(config: OpenAICompatibleConfig, request: LLMRequest, model: string, extractTextToolCalls?: (content: string) => Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}> | null, extraBody?: Record<string, unknown>): Promise<LLMResponse>;
export declare abstract class BaseOpenAICompatibleProvider implements LLMProvider {
    abstract readonly name: string;
    protected config: OpenAICompatibleConfig;
    constructor(config: {
        apiKey: string;
        baseUrl?: string;
        defaultModel?: string;
        name?: string;
    });
    /** Override to provide the default base URL */
    protected abstract getDefaultBaseUrl(): string;
    /** Override to provide the default model name */
    protected abstract getDefaultModel(): string;
    /** Override to provide extra config (headers, isLocal, etc.) */
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
    /** Override to provide extra body fields per-request */
    protected getExtraBody(_request: LLMRequest): Record<string, unknown>;
    /** Override for providers that emit text-format tool calls */
    protected extractTextToolCalls(_content: string): Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }> | null;
    call(request: LLMRequest): Promise<LLMResponse>;
}
export {};
//# sourceMappingURL=baseOpenAICompatible.d.ts.map