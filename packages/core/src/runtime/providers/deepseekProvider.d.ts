import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
/**
 * DeepSeek Provider — DeepSeek's OpenAI-compatible API.
 * Endpoint: https://api.deepseek.com
 * Models: deepseek-v4-flash, deepseek-v4-pro, deepseek-chat, deepseek-reasoner
 *
 * DeepSeek-specific behavior:
 * - Reasoning models (deepseek-reasoner) return `reasoning_content` field.
 * - Uses standard OpenAI chat completions format.
 */
export declare class DeepSeekProvider implements LLMProvider {
    readonly name = "deepseek";
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
//# sourceMappingURL=deepseekProvider.d.ts.map