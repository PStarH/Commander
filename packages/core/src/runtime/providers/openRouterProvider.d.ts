import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
export declare class OpenRouterProvider implements LLMProvider {
    readonly name = "openrouter";
    private apiKey;
    private baseUrl;
    private defaultModel;
    constructor(config: {
        apiKey: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    call(request: LLMRequest): Promise<LLMResponse>;
    private parseResponse;
}
//# sourceMappingURL=openRouterProvider.d.ts.map