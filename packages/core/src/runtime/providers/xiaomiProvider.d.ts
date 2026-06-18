import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
/**
 * Xiaomi MiMo Provider — Xiaomi's own MiMo API (separate from MiMo's token-plan endpoint).
 * Endpoint: https://api.xiaomimimo.com/v1
 * Models: mimo-v2-flash, mimo-v2-pro, mimo-v2-omni
 *
 * This is the Xiaomi-hosted version of MiMo, distinct from the token-plan endpoint
 * used by MiMoProvider. Use XIAOMI_API_KEY to activate.
 *
 * Xiaomi-specific behavior:
 * - Uses OpenAI-compatible chat completions format.
 * - Reasoning models return `reasoning_content`.
 */
export declare class XiaomiProvider implements LLMProvider {
    readonly name = "xiaomi";
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
//# sourceMappingURL=xiaomiProvider.d.ts.map