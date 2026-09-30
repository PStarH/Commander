import { BaseOpenAICompatibleProvider } from './baseOpenAICompatible';
import type { LLMRequest } from '../types';

export class AgnesProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'agnes';

  protected getDefaultBaseUrl(): string {
    return 'https://apihub.agnes-ai.com/v1';
  }

  protected getDefaultModel(): string {
    return 'agnes-2.5-flash';
  }

  protected getExtraBody(request: LLMRequest): Record<string, unknown> {
    const maxTokens = Math.min(request.maxTokens ?? 4096, 65_536);
    return {
      max_tokens: maxTokens,
      ...(request.reasoningConfig?.enabled
        ? { chat_template_kwargs: { enable_thinking: true } }
        : {}),
    };
  }
}
