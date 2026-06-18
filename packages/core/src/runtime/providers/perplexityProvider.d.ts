import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMRequest, LLMResponse } from '../types';
/**
 * Perplexity Provider — Perplexity AI's sonar models (OpenAI-compatible).
 *
 * Endpoint: https://api.perplexity.ai/v1
 * Models: sonar-pro, sonar, sonar-reasoning, sonar-reasoning-pro,
 *         sonar-deep-research, r1-1776
 *
 * Note: Perplexity models are optimized for research and answer accuracy.
 * The Sonar API does NOT support tool/function calling — use the Agent API
 * (/v1/responses) if tool support is needed.
 *
 * Env: PERPLEXITY_API_KEY (primary, required)
 *       PPLX_API_KEY (fallback)
 *       PERPLEXITY_BASE_URL (optional)
 *       PERPLEXITY_MODEL (optional)
 */
export declare class PerplexityProvider extends BaseOpenAICompatibleProvider {
    readonly name = "perplexity";
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
    call(request: LLMRequest): Promise<LLMResponse>;
}
//# sourceMappingURL=perplexityProvider.d.ts.map