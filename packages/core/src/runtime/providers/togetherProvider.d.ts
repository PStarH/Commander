import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
/**
 * Together AI Provider — broad model selection via Together API (OpenAI-compatible).
 *
 * Endpoint: https://api.together.ai/v1
 * Models: meta-llama/Llama-3.3-70B-Instruct, deepseek-ai/DeepSeek-V3,
 *         Qwen/Qwen2.5-72B-Instruct, mistralai/Mixtral-8x22B-Instruct-v0.1,
 *         google/gemma-2-27b-it, microsoft/Phi-3.5-mini-instruct
 *
 * Note: Model IDs use <provider>/<model> namespace (not flat names).
 * No Assistants/Threads API — use chat+function calling for agents.
 *
 * Env: TOGETHER_API_KEY (required)
 *       TOGETHER_BASE_URL (optional)
 *       TOGETHER_MODEL (optional)
 */
export declare class TogetherProvider extends BaseOpenAICompatibleProvider {
    readonly name = "together";
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
}
//# sourceMappingURL=togetherProvider.d.ts.map