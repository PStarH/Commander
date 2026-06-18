import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
export declare class OpenAIProvider implements LLMProvider {
    readonly name = "openai";
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
//# sourceMappingURL=openaiProvider.d.ts.map