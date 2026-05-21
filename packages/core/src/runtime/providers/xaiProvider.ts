import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';

export class XAIProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'xai';

  protected getDefaultBaseUrl(): string {
    return process.env.XAI_BASE_URL || 'https://api.x.ai/v1';
  }

  protected getDefaultModel(): string {
    return process.env.XAI_MODEL || 'grok-2-latest';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {};
  }
}
