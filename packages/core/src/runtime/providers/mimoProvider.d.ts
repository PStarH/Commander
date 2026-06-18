import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
/**
 * MiMo Provider — Xiaomi's reasoning model API.
 * Endpoint: https://token-plan-sgp.xiaomimimo.com/v1
 * Models: mimo-v2.5, mimo-v2.5-pro, mimo-v2-pro, mimo-v2-omni
 *
 * MiMo-specific behavior:
 * - Reasoning models return `reasoning_content` field that MUST be passed back
 *   on follow-up calls to maintain chain-of-thought continuity.
 * - Uses OpenAI-compatible chat completions format.
 */
export declare class MiMoProvider implements LLMProvider {
    readonly name = "mimo";
    private apiKey;
    private baseUrl;
    private defaultModel;
    constructor(config: {
        apiKey: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    private static readonly MAX_RETRIES;
    private static readonly BASE_DELAY_MS;
    call(request: LLMRequest): Promise<LLMResponse>;
    private buildBody;
    private handleStreamingResponse;
    private parseResponse;
}
/**
 * Parse MiMo's text-format tool calls into structured format.
 *
 * Input:  "<tool_call>\n<function=web_search>\n<parameter=query>AI news</parameter>\n</function>\n</tool_call>"
 * Output: [{ id: "call_xxx", name: "web_search", arguments: { query: "AI news" } }]
 */
export declare function parseMiMoTextToolCalls(content: string): Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}>;
//# sourceMappingURL=mimoProvider.d.ts.map