import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';
import type { LLMRequest } from '../types/llm';

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
export class MistralProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'mistral';

  protected getDefaultBaseUrl(): string {
    return process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1';
  }

  protected getDefaultModel(): string {
    return process.env.MISTRAL_MODEL || 'mistral-large-latest';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {};
  }

  protected getExtraBody(request: LLMRequest): Record<string, unknown> {
    const extra: Record<string, unknown> = {};
    // Mistral safe_prompt: enables additional safety moderation
    if (request.safePrompt) {
      extra.safe_prompt = true;
    }
    return extra;
  }
}
