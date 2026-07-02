/**
 * Provider Registry — single source of truth for LLM provider metadata + factory.
 *
 * Adding a new provider is a ONE-STEP operation: append a `registerProvider()`
 * call below. Previously this data was spread across 6 hard-coded Records
 * (PROVIDER_ORDER / ENV_MAP / DEFAULT_URLS / DEFAULT_MODELS / DISPLAY_NAMES /
 * API_TYPE) plus a 24-case switch in httpServer.ts — touching 8+ files across
 * 2 packages. The registry centralizes all of it here.
 *
 * Consumers derive their data via the typed accessors:
 *   - `getProviderOrder()`      → replaces PROVIDER_ORDER
 *   - `getEnvMap()`             → replaces ENV_MAP
 *   - `getDefaultUrls()`        → replaces DEFAULT_URLS
 *   - `getDefaultModels()`      → replaces DEFAULT_MODELS
 *   - `getDisplayNames()`       → replaces DISPLAY_NAMES
 *   - `getApiTypes()`           → replaces API_TYPE
 *   - `createProvider(type)`    → replaces the getDefaultProvider switch
 */

import type { LLMProvider } from '../types';
import { resolveSecureApiKey } from '../../security/secureApiKeyResolver';

import { OpenAIProvider } from './openaiProvider';
import { AnthropicProvider } from './anthropicProvider';
import { GoogleProvider } from './googleProvider';
import { OpenRouterProvider } from './openRouterProvider';
import { DeepSeekProvider } from './deepseekProvider';
import { GLMProvider } from './glmProvider';
import { MiMoProvider } from './mimoProvider';
import { XiaomiProvider } from './xiaomiProvider';
import { OllamaProvider } from './ollamaProvider';
import { VLLMProvider } from './vllmProvider';
import { CohereProvider } from './cohereProvider';
import { MistralProvider } from './mistralProvider';
import { GroqProvider } from './groqProvider';
import { TogetherProvider } from './togetherProvider';
import { PerplexityProvider } from './perplexityProvider';
import { FireworksProvider } from './fireworksProvider';
import { ReplicateProvider } from './replicateProvider';
import { BedrockProvider } from './bedrockProvider';
import { XAIProvider } from './xaiProvider';
import { AnyscaleProvider } from './anyscaleProvider';
import { DeepInfraProvider } from './deepinfraProvider';
import { AgnesProvider } from './agnesProvider';
import { StepFunProvider } from './stepfunProvider';
import { MiniMaxProvider } from './minimaxProvider';

export type ProviderApiType = 'openai' | 'anthropic' | 'google';

/** Static metadata for a provider (env keys, defaults, display info). */
export interface ProviderMetadata {
  type: string;
  /** Env var holding the API key (primary). */
  envKey: string;
  /** Env var holding the base URL override. */
  envBaseUrlKey: string;
  /** Env var holding the model override. */
  envModelKey: string;
  /** Default base URL when no env override is set. */
  defaultUrl: string;
  /** Default model when no env override is set. */
  defaultModel: string;
  /** Human-readable name for UI / config dumps. */
  displayName: string;
  /** Wire protocol family — determines request/response shaping. */
  apiType: ProviderApiType;
}

/** Full registration = metadata + factory that constructs the provider. */
interface ProviderRegistration extends ProviderMetadata {
  /** Constructs the provider instance, resolving its own credentials via
   *  resolveSecureApiKey (with fallback env vars where applicable). */
  factory: () => LLMProvider;
}

const registry = new Map<string, ProviderRegistration>();
const insertionOrder: string[] = [];

/** Register a provider. Exported so external packages can add providers
 *  without modifying this file (true extensibility). */
export function registerProvider(reg: ProviderRegistration): void {
  if (!registry.has(reg.type)) insertionOrder.push(reg.type);
  registry.set(reg.type, reg);
}

/** Lookup metadata + factory by provider type. */
export function getProviderRegistration(type: string): ProviderRegistration | undefined {
  return registry.get(type);
}

/** Does a provider type exist in the registry? */
export function hasProvider(type: string): boolean {
  return registry.has(type);
}

/** All registered provider types in insertion order. */
export function listProviderTypes(): string[] {
  return [...insertionOrder];
}

// ============================================================================
// Built-in provider registrations
// ============================================================================
// NOTE: order matters for auto-detection priority (PROVIDER_ORDER). Local
// providers (ollama/vllm) are listed first so auto-detect prefers them when
// configured, then cloud providers, with the most reliable (openai) last.

registerProvider({
  type: 'ollama',
  envKey: 'OLLAMA_API_KEY',
  envBaseUrlKey: 'OLLAMA_BASE_URL',
  envModelKey: 'OLLAMA_MODEL',
  defaultUrl: 'http://localhost:11434/v1',
  defaultModel: 'llama3.2',
  displayName: 'Ollama (Local)',
  apiType: 'openai',
  factory: () => new OllamaProvider({}),
});

registerProvider({
  type: 'vllm',
  envKey: 'VLLM_API_KEY',
  envBaseUrlKey: 'VLLM_BASE_URL',
  envModelKey: 'VLLM_MODEL',
  defaultUrl: 'http://localhost:8000/v1',
  defaultModel: 'meta-llama/Llama-3.2-3B-Instruct',
  displayName: 'vLLM (Local)',
  apiType: 'openai',
  factory: () => new VLLMProvider({}),
});

registerProvider({
  type: 'deepinfra',
  envKey: 'DEEPINFRA_API_KEY',
  envBaseUrlKey: 'DEEPINFRA_BASE_URL',
  envModelKey: 'DEEPINFRA_MODEL',
  defaultUrl: 'https://api.deepinfra.com/v1/openai',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  displayName: 'DeepInfra',
  apiType: 'openai',
  factory: () => new DeepInfraProvider({ apiKey: resolveSecureApiKey('DEEPINFRA_API_KEY') }),
});

registerProvider({
  type: 'anyscale',
  envKey: 'ANYSCALE_API_KEY',
  envBaseUrlKey: 'ANYSCALE_BASE_URL',
  envModelKey: 'ANYSCALE_MODEL',
  defaultUrl: 'https://api.endpoints.anyscale.com/v1',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
  displayName: 'Anyscale',
  apiType: 'openai',
  factory: () => new AnyscaleProvider({ apiKey: resolveSecureApiKey('ANYSCALE_API_KEY') }),
});

registerProvider({
  type: 'replicate',
  envKey: 'REPLICATE_API_TOKEN',
  envBaseUrlKey: 'REPLICATE_BASE_URL',
  envModelKey: 'REPLICATE_MODEL',
  defaultUrl: 'https://api.replicate.com/v1',
  defaultModel: 'meta/meta-llama-3.3-70b-instruct',
  displayName: 'Replicate',
  apiType: 'openai',
  factory: () =>
    new ReplicateProvider({
      apiKey:
        resolveSecureApiKey('REPLICATE_API_TOKEN') || resolveSecureApiKey('REPLICATE_API_KEY'),
    }),
});

registerProvider({
  type: 'cohere',
  envKey: 'CO_API_KEY',
  envBaseUrlKey: 'COHERE_BASE_URL',
  envModelKey: 'COHERE_MODEL',
  defaultUrl: 'https://api.cohere.com',
  defaultModel: 'command-a-plus-05-2026',
  displayName: 'Cohere',
  apiType: 'openai',
  factory: () =>
    new CohereProvider({
      apiKey: resolveSecureApiKey('CO_API_KEY') || resolveSecureApiKey('COHERE_API_KEY'),
    }),
});

registerProvider({
  type: 'mistral',
  envKey: 'MISTRAL_API_KEY',
  envBaseUrlKey: 'MISTRAL_BASE_URL',
  envModelKey: 'MISTRAL_MODEL',
  defaultUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-large-latest',
  displayName: 'Mistral AI',
  apiType: 'openai',
  factory: () => new MistralProvider({ apiKey: resolveSecureApiKey('MISTRAL_API_KEY') }),
});

registerProvider({
  type: 'groq',
  envKey: 'GROQ_API_KEY',
  envBaseUrlKey: 'GROQ_BASE_URL',
  envModelKey: 'GROQ_MODEL',
  defaultUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
  displayName: 'Groq',
  apiType: 'openai',
  factory: () => new GroqProvider({ apiKey: resolveSecureApiKey('GROQ_API_KEY') }),
});

registerProvider({
  type: 'together',
  envKey: 'TOGETHER_API_KEY',
  envBaseUrlKey: 'TOGETHER_BASE_URL',
  envModelKey: 'TOGETHER_MODEL',
  defaultUrl: 'https://api.together.ai/v1',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  displayName: 'Together AI',
  apiType: 'openai',
  factory: () => new TogetherProvider({ apiKey: resolveSecureApiKey('TOGETHER_API_KEY') }),
});

registerProvider({
  type: 'perplexity',
  envKey: 'PERPLEXITY_API_KEY',
  envBaseUrlKey: 'PERPLEXITY_BASE_URL',
  envModelKey: 'PERPLEXITY_MODEL',
  defaultUrl: 'https://api.perplexity.ai/v1',
  defaultModel: 'sonar-pro',
  displayName: 'Perplexity',
  apiType: 'openai',
  factory: () =>
    new PerplexityProvider({
      apiKey: resolveSecureApiKey('PERPLEXITY_API_KEY') || resolveSecureApiKey('PPLX_API_KEY'),
    }),
});

registerProvider({
  type: 'fireworks',
  envKey: 'FIREWORKS_API_KEY',
  envBaseUrlKey: 'FIREWORKS_BASE_URL',
  envModelKey: 'FIREWORKS_MODEL',
  defaultUrl: 'https://api.fireworks.ai/inference/v1',
  defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  displayName: 'Fireworks AI',
  apiType: 'openai',
  factory: () => new FireworksProvider({ apiKey: resolveSecureApiKey('FIREWORKS_API_KEY') }),
});

registerProvider({
  type: 'xiaomi',
  envKey: 'XIAOMI_API_KEY',
  envBaseUrlKey: 'XIAOMI_BASE_URL',
  envModelKey: 'XIAOMI_MODEL',
  defaultUrl: 'https://api.xiaomimimo.com/v1',
  defaultModel: 'mimo-v2-flash',
  displayName: 'Xiaomi MiMo',
  apiType: 'openai',
  factory: () => new XiaomiProvider({ apiKey: resolveSecureApiKey('XIAOMI_API_KEY') }),
});

registerProvider({
  type: 'mimo',
  envKey: 'MIMO_API_KEY',
  envBaseUrlKey: 'MIMO_BASE_URL',
  envModelKey: 'MIMO_MODEL',
  defaultUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
  defaultModel: 'mimo-v2.5',
  displayName: 'MiMo',
  apiType: 'openai',
  factory: () => new MiMoProvider({ apiKey: resolveSecureApiKey('MIMO_API_KEY') }),
});

registerProvider({
  type: 'deepseek',
  envKey: 'DEEPSEEK_API_KEY',
  envBaseUrlKey: 'DEEPSEEK_BASE_URL',
  envModelKey: 'DEEPSEEK_MODEL',
  defaultUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-flash',
  displayName: 'DeepSeek',
  apiType: 'openai',
  factory: () => new DeepSeekProvider({ apiKey: resolveSecureApiKey('DEEPSEEK_API_KEY') }),
});

registerProvider({
  type: 'glm',
  envKey: 'ZHIPU_API_KEY',
  envBaseUrlKey: 'ZHIPU_BASE_URL',
  envModelKey: 'ZHIPU_MODEL',
  defaultUrl: 'https://open.bigmodel.cn/api/paas/v4',
  defaultModel: 'glm-4.7',
  displayName: 'GLM (Zhipu AI)',
  apiType: 'openai',
  factory: () => new GLMProvider({ apiKey: resolveSecureApiKey('ZHIPU_API_KEY') }),
});

registerProvider({
  type: 'xai',
  envKey: 'XAI_API_KEY',
  envBaseUrlKey: 'XAI_BASE_URL',
  envModelKey: 'XAI_MODEL',
  defaultUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-2-latest',
  displayName: 'xAI (Grok)',
  apiType: 'openai',
  factory: () => new XAIProvider({ apiKey: resolveSecureApiKey('XAI_API_KEY') }),
});

registerProvider({
  type: 'bedrock',
  envKey: 'AWS_ACCESS_KEY_ID',
  envBaseUrlKey: 'AWS_BASE_URL',
  envModelKey: 'BEDROCK_MODEL',
  defaultUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  defaultModel: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  displayName: 'AWS Bedrock',
  apiType: 'openai',
  factory: () => new BedrockProvider({}),
});

registerProvider({
  type: 'agnes',
  envKey: 'AGNES_API_KEY',
  envBaseUrlKey: 'AGNES_BASE_URL',
  envModelKey: 'AGNES_MODEL',
  defaultUrl: 'https://apihub.agnes-ai.com/v1',
  defaultModel: 'agnes-2.0-flash',
  displayName: 'Agnes AI',
  apiType: 'openai',
  factory: () => new AgnesProvider({ apiKey: resolveSecureApiKey('AGNES_API_KEY') }),
});

registerProvider({
  type: 'stepfun',
  envKey: 'STEPFUN_API_KEY',
  envBaseUrlKey: 'STEPFUN_BASE_URL',
  envModelKey: 'STEPFUN_MODEL',
  defaultUrl: 'https://api.stepfun.com/step_plan/v1',
  defaultModel: 'step-3.7-flash',
  displayName: 'StepFun',
  apiType: 'openai',
  factory: () => new StepFunProvider({ apiKey: resolveSecureApiKey('STEPFUN_API_KEY') }),
});

registerProvider({
  type: 'minimax',
  envKey: 'MINIMAX_API_KEY',
  envBaseUrlKey: 'MINIMAX_BASE_URL',
  envModelKey: 'MINIMAX_MODEL',
  defaultUrl: 'https://api.minimax.io/v1',
  defaultModel: 'MiniMax-M3',
  displayName: 'MiniMax',
  apiType: 'openai',
  factory: () => new MiniMaxProvider({ apiKey: resolveSecureApiKey('MINIMAX_API_KEY') }),
});

registerProvider({
  type: 'openrouter',
  envKey: 'OPENROUTER_API_KEY',
  envBaseUrlKey: 'OPENROUTER_BASE_URL',
  envModelKey: 'OPENROUTER_MODEL',
  defaultUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openai/gpt-4o-mini',
  displayName: 'OpenRouter',
  apiType: 'openai',
  factory: () => new OpenRouterProvider({ apiKey: resolveSecureApiKey('OPENROUTER_API_KEY') }),
});

registerProvider({
  type: 'anthropic',
  envKey: 'ANTHROPIC_API_KEY',
  envBaseUrlKey: 'ANTHROPIC_BASE_URL',
  envModelKey: 'ANTHROPIC_MODEL',
  defaultUrl: 'https://api.anthropic.com/v1',
  defaultModel: 'claude-3-5-sonnet-20241022',
  displayName: 'Anthropic',
  apiType: 'anthropic',
  factory: () => new AnthropicProvider({ apiKey: resolveSecureApiKey('ANTHROPIC_API_KEY') }),
});

registerProvider({
  type: 'google',
  envKey: 'GOOGLE_API_KEY',
  envBaseUrlKey: 'GOOGLE_BASE_URL',
  envModelKey: 'GOOGLE_MODEL',
  defaultUrl: 'https://generativelanguage.googleapis.com/v1beta',
  defaultModel: 'gemini-2.0-flash',
  displayName: 'Google Gemini',
  apiType: 'google',
  factory: () => new GoogleProvider({ apiKey: resolveSecureApiKey('GOOGLE_API_KEY') }),
});

registerProvider({
  type: 'openai',
  envKey: 'OPENAI_API_KEY',
  envBaseUrlKey: 'OPENAI_BASE_URL',
  envModelKey: 'OPENAI_MODEL',
  defaultUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o',
  displayName: 'OpenAI',
  apiType: 'openai',
  factory: () => new OpenAIProvider({ apiKey: resolveSecureApiKey('OPENAI_API_KEY') }),
});

// ============================================================================
// Derived accessors (replace the 6 hard-coded Records)
// ============================================================================

/** Ordered list of provider types — replaces PROVIDER_ORDER. */
export function getProviderOrder(): string[] {
  return listProviderTypes();
}

/** Env var map — replaces ENV_MAP. */
export function getEnvMap(): Record<string, { key: string; url: string; model: string }> {
  const out: Record<string, { key: string; url: string; model: string }> = {};
  for (const type of insertionOrder) {
    const reg = registry.get(type)!;
    out[type] = { key: reg.envKey, url: reg.envBaseUrlKey, model: reg.envModelKey };
  }
  return out;
}

/** Default base URLs — replaces DEFAULT_URLS. */
export function getDefaultUrls(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const type of insertionOrder) out[type] = registry.get(type)!.defaultUrl;
  return out;
}

/** Default models — replaces DEFAULT_MODELS. */
export function getDefaultModels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const type of insertionOrder) out[type] = registry.get(type)!.defaultModel;
  return out;
}

/** Display names — replaces DISPLAY_NAMES. */
export function getDisplayNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const type of insertionOrder) out[type] = registry.get(type)!.displayName;
  return out;
}

/** API types — replaces API_TYPE. */
export function getApiTypes(): Record<string, ProviderApiType> {
  const out: Record<string, ProviderApiType> = {};
  for (const type of insertionOrder) out[type] = registry.get(type)!.apiType;
  return out;
}

/**
 * Construct a provider instance by type. Replaces the 24-case switch in
 * httpServer.ts#getDefaultProvider. Falls back to OpenAI when unknown.
 */
export function createProvider(type: string): LLMProvider {
  const reg = registry.get(type);
  if (reg) return reg.factory();
  // Fallback: OpenAI (preserves prior default-case behavior).
  return new OpenAIProvider({ apiKey: resolveSecureApiKey('OPENAI_API_KEY') });
}
