import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';

export class AnyscaleProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'anyscale';

  protected getDefaultBaseUrl(): string {
    return process.env.ANYSCALE_BASE_URL || 'https://api.endpoints.anyscale.com/v1';
  }

  protected getDefaultModel(): string {
    return process.env.ANYSCALE_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {};
  }
}
