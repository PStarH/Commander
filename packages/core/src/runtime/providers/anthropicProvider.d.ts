import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
export declare class AnthropicProvider implements LLMProvider {
    readonly name = "anthropic";
    private apiKey;
    private baseUrl;
    private defaultModel;
    constructor(config: {
        apiKey: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    call(request: LLMRequest): Promise<LLMResponse>;
    private buildMessages;
    private buildSystemWithCache;
    private handleStreamingResponse;
    private parseResponse;
}
//# sourceMappingURL=anthropicProvider.d.ts.map