import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMResponse, LLMRequest } from '../types';
/**
 * Ollama Provider — local LLM inference via Ollama.
 *
 * Features:
 * - Auto-detects running Ollama instance (no API key needed)
 * - Lists available models via /api/tags
 * - OpenAI-compatible API at /v1/chat/completions
 * - Supports tool calling (Ollama 0.3.0+)
 * - Falls back gracefully if Ollama is not running
 *
 * Env: OLLAMA_HOST (primary, official Ollama env var, e.g. 127.0.0.1:11434)
 *       OLLAMA_BASE_URL (fallback, full URL, e.g. http://localhost:11434/v1)
 *       OLLAMA_MODEL (optional, default: llama3.2)
 *
 * Models: llama3.2, gpt-oss, mistral, codellama, qwen2.5, deepseek-coder, etc.
 */
/**
 * Resolve Ollama's base URL from environment.
 * - OLLAMA_HOST is the official Ollama env var (e.g. "127.0.0.1:11434")
 * - OLLAMA_BASE_URL is a common third-party convention (e.g. "http://localhost:11434/v1")
 */
export declare function resolveOllamaBaseUrl(): string;
export declare class OllamaProvider extends BaseOpenAICompatibleProvider {
    readonly name = "ollama";
    constructor(config: {
        apiKey?: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
    /**
     * Check if Ollama is running and accessible.
     * Tries the /api/tags endpoint (Ollama-native, no auth needed).
     */
    static isRunning(baseUrl?: string): Promise<boolean>;
    /**
     * List models available in the local Ollama instance.
     */
    static listModels(baseUrl?: string): Promise<string[]>;
    /**
     * Auto-detect Ollama: check if running, and if so, pick a sensible default model.
     * Returns the provider config or null if not available.
     */
    static autoDetect(): Promise<{
        baseUrl: string;
        defaultModel: string;
    } | null>;
    private static healthCache;
    private static readonly HEALTH_TTL_MS;
    call(request: LLMRequest): Promise<LLMResponse>;
}
//# sourceMappingURL=ollamaProvider.d.ts.map