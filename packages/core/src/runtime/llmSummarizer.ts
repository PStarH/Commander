import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse } from './types';

export interface LLMSummarizerDeps {
  providers: Map<string, LLMProvider>;
  defaultModel: string;
  defaultMaxTokens: number;
  /** Optional override of the provider name for the summary model. If not given, derived from model id. */
  resolveProvider?: (modelId: string) => string;
}

const PROVIDER_HINTS: Array<{ match: RegExp; provider: string }> = [
  { match: /claude|haiku|sonnet|opus/i, provider: 'anthropic' },
  { match: /gpt-|o[1-9]|openai/i, provider: 'openai' },
  { match: /gemini/i, provider: 'google' },
  { match: /deepseek/i, provider: 'deepseek' },
  { match: /glm/i, provider: 'glm' },
  { match: /mimo/i, provider: 'mimo' },
  { match: /llama|grok|command|sonar|mistral/i, provider: 'openrouter' },
];

function inferProvider(modelId: string): string {
  for (const hint of PROVIDER_HINTS) {
    if (hint.match.test(modelId)) return hint.provider;
  }
  return 'anthropic';
}

/**
 * LLMSummarizerImpl — uses the registered providers to summarize messages for compaction.
 * Picks an eco-tier model by default. Hard-timeouts are enforced by the compactor via AbortSignal.
 */
export class LLMSummarizerImpl {
  readonly backend: string;
  private deps: LLMSummarizerDeps;

  constructor(deps: LLMSummarizerDeps) {
    this.deps = deps;
    this.backend = `eco-summary:${deps.defaultModel}`;
  }

  async summarize(
    messages: LLMMessage[],
    options: { model?: string; maxTokens?: number; signal?: AbortSignal },
  ): Promise<string> {
    const model = options.model ?? this.deps.defaultModel;
    const providerName = this.deps.resolveProvider
      ? this.deps.resolveProvider(model)
      : inferProvider(model);
    const provider = this.deps.providers.get(providerName);
    if (!provider) {
      throw new Error(`LLMSummarizer: no provider for model ${model} (provider ${providerName})`);
    }

    const request: LLMRequest = {
      model,
      messages,
      maxTokens: options.maxTokens ?? this.deps.defaultMaxTokens,
      temperature: 0,
    };

    if (options.signal?.aborted) {
      throw new Error('LLMSummarizer: aborted before call');
    }

    const response: LLMResponse = options.signal
      ? await this.callWithAbort(provider, request, options.signal)
      : await provider.call(request);

    if (options.signal?.aborted) {
      throw new Error('LLMSummarizer: aborted after call');
    }

    return response.content;
  }

  private async callWithAbort(provider: LLMProvider, request: LLMRequest, signal: AbortSignal): Promise<LLMResponse> {
    return await new Promise<LLMResponse>((resolve, reject) => {
      const onAbort = () => reject(new Error('LLMSummarizer: aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      provider.call(request).then(
        (resp) => { signal.removeEventListener('abort', onAbort); resolve(resp); },
        (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
      );
    });
  }
}
