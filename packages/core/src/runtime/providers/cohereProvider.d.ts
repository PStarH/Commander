import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
/**
 * Cohere Provider — Cohere's native API.
 *
 * Endpoint (chat): https://api.cohere.com/v2/chat
 * Models: command-a-plus-05-2026, command-a-03-2025, command-r-08-2024, command-r-plus-08-2024
 *
 * Cohere uses a multi-turn chat format with tool support.
 * This adapter maps Commander's LLMRequest to Cohere's API.
 *
 * Env: CO_API_KEY (primary, official Python SDK default)
 *       COHERE_API_KEY (fallback)
 *       COHERE_BASE_URL (optional)
 *       COHERE_MODEL (optional)
 */
export declare class CohereProvider implements LLMProvider {
    readonly name = "cohere";
    private apiKey;
    private baseUrl;
    private defaultModel;
    constructor(config: {
        apiKey: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    call(request: LLMRequest): Promise<LLMResponse>;
    private buildBody;
    private cohereParameterDefs;
    private parseResponse;
}
//# sourceMappingURL=cohereProvider.d.ts.map