import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
/**
 * Mistral AI Provider — Mistral's API (OpenAI-compatible).
 *
 * Endpoint: https://api.mistral.ai/v1
 * Models: mistral-large-latest, mistral-small-latest, codestral-latest,
 *         open-mistral-nemo, open-mixtral-8x22b, open-codestral-mamba
 *
 * Env: MISTRAL_API_KEY (required)
 *       MISTRAL_BASE_URL (optional)
 *       MISTRAL_MODEL (optional)
 */
export declare class MistralProvider extends BaseOpenAICompatibleProvider {
    readonly name = "mistral";
    protected getDefaultBaseUrl(): string;
    protected getDefaultModel(): string;
    protected getExtraConfig(): Partial<OpenAICompatibleConfig>;
}
//# sourceMappingURL=mistralProvider.d.ts.map