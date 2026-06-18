import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
/**
 * Replicate Provider — Run open-source models via Replicate's API.
 *
 * Endpoint: https://api.replicate.com/v1
 * Models: meta/meta-llama-3.3-70b-instruct, mistralai/mistral-7b-instruct,
 *         google-deepmind/gemma-2-27b-it
 *
 * Note: Replicate uses a different API format than OpenAI.
 * Each model has its own input schema. We use the chat/compat endpoint
 * for models that support it, falling back to the prediction API.
 *
 * Env: REPLICATE_API_TOKEN (primary, official Replicate env var)
 *       REPLICATE_API_KEY (fallback)
 *       REPLICATE_BASE_URL (optional)
 *       REPLICATE_MODEL (optional)
 */
export declare class ReplicateProvider implements LLMProvider {
    readonly name = "replicate";
    private apiKey;
    private baseUrl;
    private defaultModel;
    constructor(config: {
        apiKey: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    call(request: LLMRequest): Promise<LLMResponse>;
    private callChatCompat;
    private callPrediction;
    private pollPrediction;
}
//# sourceMappingURL=replicateProvider.d.ts.map