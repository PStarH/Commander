import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
/**
 * GLM Provider — Zhipu AI's OpenAI-compatible API (via LiteLLM-compatible endpoint).
 * Endpoint: https://open.bigmodel.cn/api/paas/v4
 * Models: glm-4.7, glm-4.7-flash, glm-5.1, glm-5, glm-5-turbo, glm-4.6, glm-4.5
 *
 * GLM-specific behavior:
 * - Uses OpenAI-compatible chat completions format at /v4 endpoint.
 * - Some GLM models support reasoning_content in responses.
 */
export declare class GLMProvider implements LLMProvider {
    readonly name = "glm";
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
    private handleStreamingResponse;
    private parseResponse;
}
//# sourceMappingURL=glmProvider.d.ts.map