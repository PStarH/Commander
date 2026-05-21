import { BaseOpenAICompatibleProvider, type OpenAICompatibleConfig } from './baseOpenAICompatible';

export class DeepInfraProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'deepinfra';

  protected getDefaultBaseUrl(): string {
    return process.env.DEEPINFRA_BASE_URL || 'https://api.deepinfra.com/v1/openai';
  }

  protected getDefaultModel(): string {
    return process.env.DEEPINFRA_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
  }

  protected getExtraConfig(): Partial<OpenAICompatibleConfig> {
    return {};
  }
}
