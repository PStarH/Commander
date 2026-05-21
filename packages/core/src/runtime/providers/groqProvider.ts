import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';

/**
 * Groq Provider — ultra-fast inference via Groq Cloud (OpenAI-compatible).
 *
 * Endpoint: https://api.groq.com/openai/v1
 * Models: llama3-70b-8192, llama3-8b-8192, mixtral-8x7b-32768,
 *         gemma2-9b-it, llama-3.1-70b-versatile, llama-3.1-8b-instant,
 *         llama-guard-3-8b, llama3-70b-8192-tool-use-preview
 *
 * Env: GROQ_API_KEY (required)
 *       GROQ_BASE_URL (optional)
 *       GROQ_MODEL (optional)
 */
export class GroqProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'groq';

  protected getDefaultBaseUrl(): string {
    return process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
  }

  protected getDefaultModel(): string {
    return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {};
  }
}
