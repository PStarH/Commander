import type { LLMProvider, LLMRequest, LLMResponse } from '../types';
/**
 * Optional Google Gemini cachedContent wiring.
 * When `cachedContentName` is present in `request.cacheConfig`, the provider references
 * the server-side cached content resource (created via POST /v1beta/cachedContents) in the
 * generateContent body, achieving 90% cost reduction on cached tokens (>4K token payloads).
 * See geminiCacheManager.ts for the lifecycle manager that creates these names.
 */
export interface GeminiCacheConfig {
    /** Server-side cached content resource name (e.g. "cachedContents/abc123"). */
    cachedContentName?: string;
}
export declare class GoogleProvider implements LLMProvider {
    readonly name = "google";
    private apiKey;
    private baseUrl;
    private defaultModel;
    constructor(config: {
        apiKey: string;
        baseUrl?: string;
        defaultModel?: string;
    });
    call(request: LLMRequest): Promise<LLMResponse>;
    private buildContents;
    private buildSystemInstruction;
    private parseResponse;
}
//# sourceMappingURL=googleProvider.d.ts.map