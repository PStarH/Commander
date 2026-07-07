import { BaseOpenAICompatibleProvider } from './baseOpenAICompatible';
import type { LLMRequest, LLMResponse } from '../types';

/**
 * Azure OpenAI Provider — native fetch, no @azure SDK.
 *
 * Endpoint shape (Azure REST contract):
 *   {baseUrl}/openai/deployments/{deployment}/chat/completions?api-version={apiVersion}
 *
 * Auth uses the Azure-specific `api-key` header (not `Authorization: Bearer`).
 *
 * Inherits OpenAI-compatible payload building, SSE stream parsing, and the
 * HTTP-retry + `Retry-After` policy from `BaseOpenAICompatibleProvider`.
 * Network-shape differences are injected via three opt-in fields on
 * `OpenAICompatibleConfig`:
 *   - `urlBuilder` (per-model deployment URL with `?api-version=` query)
 *   - `authHeaderName` (`api-key` instead of `Authorization`)
 *   - `authHeaderPrefix` (empty string instead of `Bearer `)
 *
 * Azure OpenAI rejects unknown body fields strictly (vanilla OpenAI tolerates
 * them), so `call()` strips OpenAI-only body fields the Azure REST contract
 * does not recognize (currently `prompt_cache_key` and `prompt_cache_retention`).
 * Add more here if the base grows new Azure-incompatible body fields.
 *
 * Env:
 *   AZURE_OPENAI_API_KEY
 *   AZURE_OPENAI_BASE_URL  (e.g. https://{resource}.openai.azure.com)
 *   AZURE_OPENAI_MODEL     (deployment name, e.g. gpt-4o)
 *   AZURE_OPENAI_API_VERSION (optional, default 2024-06-01)
 */
export class AzureOpenAIProvider extends BaseOpenAICompatibleProvider {
  readonly name = 'azure';
  private apiVersion: string;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
    apiVersion?: string;
  }) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      defaultModel: config.defaultModel,
      name: 'azure',
    });

    this.apiVersion = config.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? '2024-06-01';

    // Plug the Azure-specific network shape into the inherited config — all
    // OpenAI-compatible fetch/streaming/retry behavior comes from the base.
    // encodeURIComponent on both the model name and the api-version guards
    // against any future deployment name or api-version containing reserved
    // URL characters (e.g. &, #, /).
    this.config.urlBuilder = (baseUrl: string, model: string) =>
      `${baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`;
    this.config.authHeaderName = 'api-key';
    this.config.authHeaderPrefix = '';
  }

  protected getDefaultBaseUrl(): string {
    return process.env.AZURE_OPENAI_BASE_URL ?? 'https://your-resource.openai.azure.com';
  }

  protected getDefaultModel(): string {
    return process.env.AZURE_OPENAI_MODEL ?? 'gpt-4o';
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    // Azure OpenAI rejects unknown body fields strictly, so suppress the
    // OpenAI-specific `prompt_cache_key` and `prompt_cache_retention` fields
    // that `buildOpenAIBody` would otherwise emit. `buildOpenAIBody` uses a
    // truthy check so setting these to undefined is enough to drop the field.
    if (
      request.cacheConfig?.promptCacheKey !== undefined ||
      request.cacheConfig?.promptCacheRetention !== undefined
    ) {
      const { promptCacheKey: _k, promptCacheRetention: _r, ...rest } = request.cacheConfig;
      return super.call({ ...request, cacheConfig: { ...rest } });
    }
    return super.call(request);
  }
}
