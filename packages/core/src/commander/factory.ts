/**
 * factory.ts — RuntimeFactory that wires up a Commander instance based on
 * resolved tier configuration.
 *
 * Takes a ResolvedConfig from tier.ts and creates the necessary runtime
 * components: TenantProvider, AgentRuntime, Provider registration, etc.
 */

import { AgentRuntime } from '../runtime/agentRuntime';
import { ModelRouter, getModelRouter } from '../runtime/modelRouter';
import {
  NullTenantProvider,
  SimpleTenantProvider,
  setGlobalTenantProvider,
} from '../runtime/tenantProvider';
import { getGlobalLogger } from '../logging';
import { createAllTools } from '../tools/index';
import type { ResolvedConfig } from './tier';

// Provider map — lazy-loaded to avoid bundling all providers in every import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROVIDER_FACTORIES: Record<string, () => Promise<{ new (...args: any[]): any }>> = {
  openai: async () => (await import('../runtime/providers/openaiProvider')).OpenAIProvider,
  anthropic: async () => (await import('../runtime/providers/anthropicProvider')).AnthropicProvider,
  google: async () => (await import('../runtime/providers/googleProvider')).GoogleProvider,
  deepseek: async () => (await import('../runtime/providers/deepseekProvider')).DeepSeekProvider,
  glm: async () => (await import('../runtime/providers/glmProvider')).GLMProvider,
  mimo: async () => (await import('../runtime/providers/mimoProvider')).MiMoProvider,
  xiaomi: async () => (await import('../runtime/providers/xiaomiProvider')).XiaomiProvider,
  ollama: async () => (await import('../runtime/providers/ollamaProvider')).OllamaProvider,
  vllm: async () => (await import('../runtime/providers/vllmProvider')).VLLMProvider,
  cohere: async () => (await import('../runtime/providers/cohereProvider')).CohereProvider,
  mistral: async () => (await import('../runtime/providers/mistralProvider')).MistralProvider,
  groq: async () => (await import('../runtime/providers/groqProvider')).GroqProvider,
  together: async () => (await import('../runtime/providers/togetherProvider')).TogetherProvider,
  perplexity: async () =>
    (await import('../runtime/providers/perplexityProvider')).PerplexityProvider,
  fireworks: async () => (await import('../runtime/providers/fireworksProvider')).FireworksProvider,
  replicate: async () => (await import('../runtime/providers/replicateProvider')).ReplicateProvider,
  bedrock: async () => (await import('../runtime/providers/bedrockProvider')).BedrockProvider,
  xai: async () => (await import('../runtime/providers/xaiProvider')).XAIProvider,
  anyscale: async () => (await import('../runtime/providers/anyscaleProvider')).AnyscaleProvider,
  deepinfra: async () => (await import('../runtime/providers/deepinfraProvider')).DeepInfraProvider,
};

export interface WiredRuntime {
  runtime: AgentRuntime;
  tier: ResolvedConfig['tier'];
  features: ResolvedConfig['features'];
}

/**
 * Create and wire a complete runtime based on resolved configuration.
 *
 * This is the single entry point that assembles:
 *   1. TenantProvider (null/simple/multi based on tier)
 *   2. AgentRuntime with tier-appropriate config
 *   3. LLM Provider registration (lazy-loaded by provider type)
 *   4. Tool registration (all built-in tools)
 *   5. Model registration in the router
 */
export async function createWiredRuntime(config: ResolvedConfig): Promise<WiredRuntime> {
  const logger = getGlobalLogger();

  // ── 1. Tenant Provider ─────────────────────────────────────────────────
  if (config.tenant.provider === 'multi') {
    // In production, MultiTenantProvider would be dynamically configured
    // For now, use SimpleTenantProvider as the enterprise base
    setGlobalTenantProvider(new SimpleTenantProvider(config.tenant.configs ?? []));
  } else if (config.tenant.provider === 'simple') {
    setGlobalTenantProvider(new SimpleTenantProvider());
  }
  // null → already the default (NullTenantProvider)

  // ── 2. AgentRuntime ────────────────────────────────────────────────────
  const runtime = new AgentRuntime({
    ...config.runtime,
    otelExporter: config.features.otelExport
      ? { enabled: true, serviceName: 'commander' }
      : { enabled: false },
  });

  // ── 3. Register Provider ───────────────────────────────────────────────
  if (config.provider) {
    const factory = PROVIDER_FACTORIES[config.provider.type];
    if (factory) {
      try {
        const ProviderClass = await factory();
        runtime.registerProvider(
          config.provider.type,
          new ProviderClass({
            apiKey: config.provider.apiKey ?? '',
            baseUrl: config.provider.baseUrl,
            defaultModel: config.provider.defaultModel,
          }),
        );

        // Register model in the router
        const router = getModelRouter();
        const modelId = config.provider.defaultModel ?? 'gpt-4o';
        for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
          router.registerModel({
            id: `${modelId}@${tier}`,
            provider: config.provider.type,
            tier,
            costPer1MInput: 1,
            costPer1MOutput: 3,
            capabilities: ['code', 'reasoning', 'analysis'],
            contextWindow: 128000,
            priority: 0,
          });
        }
      } catch (err) {
        logger.warn('RuntimeFactory', `Failed to register provider: ${config.provider.type}`, {
          error: (err as Error)?.message,
        });
      }
    } else {
      logger.warn('RuntimeFactory', `Unknown provider type: ${config.provider.type}`);
    }
  }

  // ── 4. Register Tools ──────────────────────────────────────────────────
  const allTools = createAllTools();
  for (const [name, tool] of allTools) {
    runtime.registerTool(name, tool);
  }

  logger.info('RuntimeFactory', `Wired runtime for tier: ${config.tier}`, {
    provider: config.provider?.type ?? 'none',
    features: Object.entries(config.features)
      .filter(([, v]) => v)
      .map(([k]) => k),
  });

  return {
    runtime,
    tier: config.tier,
    features: config.features,
  };
}
