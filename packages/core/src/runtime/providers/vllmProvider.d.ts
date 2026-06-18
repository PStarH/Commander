import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMRequest, LLMResponse } from '../types';
/**
 * vLLM Provider — local/self-hosted LLM inference via vLLM.
 *
 * Features:
 * - Auto-detects running vLLM instance via /health endpoint
 * - OpenAI-compatible API
 * - Supports tool calling
 * - Configurable via env vars
 *
 * Env: VLLM_BASE_URL (default: http://localhost:8000/v1)
 *       VLLM_MODEL (default: auto-detect or first model from /v1/models)
 *       VLLM_API_KEY (optional, for authenticated endpoints)
 *
 * Common models: meta-llama/Llama-3.2-3B-Instruct, mistralai/Mistral-7B-Instruct,
 *                Qwen/Qwen2.5-7B-Instruct, deepseek-coder
 */
export declare class VLLMProvider extends BaseOpenAICompatibleProvider {
    readonly name = "vllm";
    constructor(config: {
        apiKey?: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
    /**
     * Check if vLLM server is running and healthy.
     */
    static isRunning(baseUrl?: string): Promise<boolean>;
    /**
     * List models available on the vLLM server (OpenAI-compatible /v1/models endpoint).
     */
    static listModels(baseUrl?: string): Promise<string[]>;
    /**
     * Auto-detect vLLM: check if running and available models.
     */
    static autoDetect(): Promise<{
        baseUrl: string;
        defaultModel: string;
    } | null>;
    private static healthCache;
    private static readonly HEALTH_TTL_MS;
    call(request: LLMRequest): Promise<LLMResponse>;
}
//# sourceMappingURL=vllmProvider.d.ts.map