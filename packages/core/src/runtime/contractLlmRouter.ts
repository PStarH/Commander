/**
 * LLM Router — O(1) model selection with provider health tracking
 *
 * Implements the ILLMRouter contract from Pillar II.
 *
 * This contract implementation delegates to the production ModelRouter
 * for real model routing, cost estimation, and provider health tracking.
 * The ModelRouter has 29+ models across 12+ providers with real pricing.
 *
 * Features:
 * - Delegates routing to ModelRouter for real model selection
 * - Auto-syncs all registered models from ModelRouter
 * - Provider health monitoring via ModelRouter's latency index
 * - Real cost estimation from ModelRouter pricing
 * - Fallback chains via ModelRouter's cascade/escalation
 *
 * Per constraint NFR-PERF-02, routing must be O(1) time complexity.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { ILLMRouter, IModelSelection, ProviderHealth } from '../contracts/pillarII';
import { getModelRouter } from './modelRouter';
import type { ModelConfig, RoutingDecision } from './types';

// ============================================================================
// Types
// ============================================================================

interface Provider {
  id: string;
  models: Array<{
    modelId: string;
    inputCostPer1k: number;
    outputCostPer1k: number;
    avgLatencyMs: number;
    maxTokens: number;
  }>;
  health: ProviderHealth;
  priority: number;
  enabled: boolean;
}

interface RoutingTableEntry {
  modelId: string;
  providerId: string;
  estimatedCost: number;
  estimatedLatency: number;
}

// ============================================================================
// ContractLlmRouter Implementation — delegates to ModelRouter
// ============================================================================

export class ContractLlmRouter implements ILLMRouter {
  private providers: Map<string, Provider> = new Map();
  private routingTable: Map<string, RoutingTableEntry> = new Map();
  private fallbackChains: Map<string, string[]> = new Map();
  private requestCount = 0;
  private errorCount = 0;
  private syncedFromModelRouter = false;

  constructor() {
    // Auto-sync models from the production ModelRouter on construction
    this.syncFromModelRouter();
  }

  /**
   * Synchronize providers from the production ModelRouter.
   * Pulls all registered models (29+ across 12+ providers) and registers
   * them as contract providers, ensuring the contract router is never
   * empty (the original stub had 0 providers).
   */
  syncFromModelRouter(): void {
    const modelRouter = getModelRouter();
    const allModels = modelRouter.listModels();

    for (const model of allModels) {
      const providerId = model.provider;

      // Get or create provider
      if (!this.providers.has(providerId)) {
        this.providers.set(providerId, {
          id: providerId,
          models: [],
          health: {
            providerId,
            state: 'HEALTHY',
            averageLatency: 0,
            errorRate: 0,
            circuitBreakerOpen: false,
          },
          priority: model.tier === 'eco' ? 1 : model.tier === 'standard' ? 2 : 3,
          enabled: true,
        });
      }

      const provider = this.providers.get(providerId)!;

      // Add model if not already present
      if (!provider.models.some((m) => m.modelId === model.id)) {
        provider.models.push({
          modelId: model.id,
          inputCostPer1k: model.costPer1MInput / 1000,
          outputCostPer1k: model.costPer1MOutput / 1000,
          avgLatencyMs: 1000, // Default estimate; updated by recordSuccess
          maxTokens: model.contextWindow,
        });
      }

      // Sync latency data from ModelRouter if available
      const latency = modelRouter.getLatency(providerId, model.id);
      if (latency) {
        provider.health.averageLatency = latency.ewmaTTFT + latency.ewmaTPOT;
        provider.health.errorRate = latency.errorRate;
        if (latency.errorRate > 0.5) {
          provider.health.state = 'UNHEALTHY';
          provider.health.circuitBreakerOpen = true;
        } else if (latency.errorRate > 0.2) {
          provider.health.state = 'DEGRADED';
        }
      }
    }

    // Rebuild routing table with real models
    this.rebuildRoutingTable();
    this.syncedFromModelRouter = true;

    getGlobalLogger().info('ContractLlmRouter', 'Synced from ModelRouter', {
      providerCount: this.providers.size,
      modelCount: allModels.length,
    });
  }

  /**
   * Register a provider with its models.
   * Also registers models in the production ModelRouter for consistency.
   */
  registerProvider(provider: unknown): void {
    const p = provider as Provider;

    if (!p.id) {
      throw new Error('Provider must have an id');
    }

    // If provider already exists (e.g., auto-synced from ModelRouter),
    // merge new models into the existing provider instead of throwing.
    if (this.providers.has(p.id)) {
      const existing = this.providers.get(p.id)!;
      for (const model of p.models ?? []) {
        if (!existing.models.some((m) => m.modelId === model.modelId)) {
          existing.models.push(model);
        }
      }
      // Update health if provided
      if (p.health) {
        existing.health = p.health;
      }
      this.rebuildRoutingTable();
      return;
    }

    // Initialize health if not provided
    if (!p.health) {
      p.health = {
        providerId: p.id,
        state: 'HEALTHY',
        averageLatency: 0,
        errorRate: 0,
        circuitBreakerOpen: false,
      };
    }

    this.providers.set(p.id, p);
    this.rebuildRoutingTable();

    getGlobalLogger().info('ContractLlmRouter', 'Provider registered', {
      providerId: p.id,
      modelCount: p.models?.length ?? 0,
    });
  }

  /**
   * Route a request to the best model+provider.
   *
   * Strategy:
   * 1. Check the contract's own routing table first (respects fallback chains
   *    and provider enabled/disabled state set by callers)
   * 2. If the model is not in the contract table, delegate to ModelRouter
   *    for real model selection with production pricing/latency data
   * 3. If neither has the model, pick the first available provider
   */
  route(request: unknown): IModelSelection {
    const req = request as {
      modelId?: string;
      category?: string;
      inputTokens?: number;
      outputTokens?: number;
      goal?: string;
      taskType?: string;
    };

    const inputTokens = req.inputTokens ?? 1000;
    const outputTokens = req.outputTokens ?? 500;

    // Step 1: Check contract's own routing table (respects fallback chains)
    const routingKey = req.modelId ?? req.category ?? 'default';
    const entry = this.routingTable.get(routingKey);

    if (entry) {
      const provider = this.providers.get(entry.providerId);

      // Check if primary provider is available
      if (provider && provider.enabled && !provider.health.circuitBreakerOpen) {
        this.requestCount++;
        const model = provider.models.find((m) => m.modelId === entry.modelId);
        return {
          modelId: entry.modelId,
          providerId: entry.providerId,
          estimatedCost: model
            ? this.computeCost(model, inputTokens, outputTokens)
            : entry.estimatedCost,
          estimatedLatency: entry.estimatedLatency,
          confidence: provider.health.state === 'HEALTHY' ? 0.9 : 0.6,
        };
      }

      // Primary is down — try fallback chain
      const chain = this.fallbackChains.get(routingKey) ?? [];
      for (const fallbackProviderId of chain) {
        const fallbackProvider = this.providers.get(fallbackProviderId);
        if (
          fallbackProvider &&
          fallbackProvider.enabled &&
          !fallbackProvider.health.circuitBreakerOpen
        ) {
          const model =
            fallbackProvider.models.find((m) => m.modelId === entry.modelId) ??
            fallbackProvider.models[0];
          if (model) {
            this.requestCount++;
            return {
              modelId: model.modelId,
              providerId: fallbackProviderId,
              estimatedCost: this.computeCost(model, inputTokens, outputTokens),
              estimatedLatency: model.avgLatencyMs,
              confidence: 0.7,
            };
          }
        }
      }
    }

    // Step 2: Delegate to ModelRouter for real model selection
    if (req.modelId) {
      const modelRouter = getModelRouter();
      const model = modelRouter.getModel(req.modelId);
      if (model) {
        const cost =
          (inputTokens / 1_000_000) * model.costPer1MInput +
          (outputTokens / 1_000_000) * model.costPer1MOutput;
        const latency = modelRouter.getLatency(model.provider, model.id);
        const avgLatency = latency ? latency.ewmaTTFT + latency.ewmaTPOT : 1000;
        const errorRate = latency?.errorRate ?? 0;
        const confidence = Math.max(0.3, 1 - errorRate);

        this.requestCount++;
        return {
          modelId: model.id,
          providerId: model.provider,
          estimatedCost: cost,
          estimatedLatency: avgLatency,
          confidence,
        };
      }
    }

    // Step 3: If goal is provided, use ModelRouter's full routing
    if (req.goal) {
      const modelRouter = getModelRouter();
      try {
        const ctx = {
          goal: req.goal,
          messages: [],
          availableTools: [],
          sessionId: 'contract-router',
          agentId: 'contract-router',
          projectId: 'contract-router',
          contextData: {},
          maxSteps: 1,
          tokenBudget: 4096,
          turn: 0,
          userTier: 'paid' as const,
        };
        const decision: RoutingDecision = modelRouter.route(ctx);
        const model = modelRouter.getModel(decision.modelId);
        const cost = model
          ? (inputTokens / 1_000_000) * model.costPer1MInput +
            (outputTokens / 1_000_000) * model.costPer1MOutput
          : decision.estimatedCost;

        this.requestCount++;
        return {
          modelId: decision.modelId,
          providerId: decision.provider,
          estimatedCost: cost,
          estimatedLatency: 1000,
          confidence: 0.85,
        };
      } catch (err) {
        reportSilentFailure(err, 'contractLlmRouter:route:delegate');
      }
    }

    // Step 4: Pick first available provider
    for (const [providerId, provider] of this.providers) {
      if (!provider.enabled || provider.health.circuitBreakerOpen) continue;
      const model = provider.models[0];
      if (model) {
        this.requestCount++;
        return {
          modelId: model.modelId,
          providerId,
          estimatedCost: this.computeCost(model, inputTokens, outputTokens),
          estimatedLatency: model.avgLatencyMs,
          confidence: 0.5,
        };
      }
    }

    throw new Error(`No routing entry for '${routingKey}' and no providers available`);
  }

  /**
   * Stream a response via SSE multiplexing.
   *
   * Routes the request first, then yields chunks. In production,
   * the actual streaming would be handled by the provider adapter
   * (packages/core/src/runtime/providers/).
   */
  async *stream(request: unknown): AsyncIterable<unknown> {
    const selection = this.route(request);
    const provider = this.providers.get(selection.providerId);

    if (!provider) {
      // Delegate to ModelRouter to find the right provider adapter
      const modelRouter = getModelRouter();
      const model = modelRouter.getModel(selection.modelId);
      if (model) {
        yield {
          type: 'chunk',
          content: `[${model.provider}/${selection.modelId}] Streaming via production router`,
          model: selection.modelId,
          provider: selection.providerId,
        };
        yield {
          type: 'done',
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
        };
        return;
      }

      throw new Error(`Provider '${selection.providerId}' not found`);
    }

    const req = request as { prompt?: string };
    const prompt = req.prompt ?? '';

    // Stream response chunks
    const words = prompt.split(' ').concat(['Generated', 'response', 'from', selection.modelId]);
    for (const word of words) {
      yield {
        type: 'chunk',
        content: word,
        model: selection.modelId,
        provider: selection.providerId,
      };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    yield {
      type: 'done',
      usage: {
        promptTokens: words.length,
        completionTokens: words.length,
        totalTokens: words.length * 2,
      },
    };
  }

  /**
   * Get provider health status.
   * Syncs from ModelRouter's latency index for real-time data.
   */
  getProviderHealth(providerId: string): ProviderHealth {
    // Try ModelRouter's latency data first
    const modelRouter = getModelRouter();
    const latencies = modelRouter.getAllLatencies().filter((l) => l.provider === providerId);

    if (latencies.length > 0) {
      const avgLatency =
        latencies.reduce((sum, l) => sum + l.ewmaTTFT + l.ewmaTPOT, 0) / latencies.length;
      const avgErrorRate = latencies.reduce((sum, l) => sum + l.errorRate, 0) / latencies.length;

      let state: ProviderHealth['state'] = 'HEALTHY';
      let circuitBreakerOpen = false;
      if (avgErrorRate > 0.5) {
        state = 'UNHEALTHY';
        circuitBreakerOpen = true;
      } else if (avgErrorRate > 0.2) {
        state = 'DEGRADED';
      }

      return {
        providerId,
        state,
        averageLatency: avgLatency,
        errorRate: avgErrorRate,
        circuitBreakerOpen,
      };
    }

    // Fall back to contract's own health tracking
    const provider = this.providers.get(providerId);
    if (!provider) {
      return {
        providerId,
        state: 'UNHEALTHY',
        averageLatency: 0,
        errorRate: 1,
        circuitBreakerOpen: true,
      };
    }
    return { ...provider.health };
  }

  /**
   * Estimate cost for a request using ModelRouter's real pricing.
   */
  estimateCost(request: unknown): number {
    const req = request as { modelId?: string; inputTokens?: number; outputTokens?: number };
    const inputTokens = req.inputTokens ?? 1000;
    const outputTokens = req.outputTokens ?? 500;

    // Use ModelRouter's pricing (single source of truth via CostModel)
    if (req.modelId) {
      const modelRouter = getModelRouter();
      const model = modelRouter.getModel(req.modelId);
      if (model) {
        return (
          (inputTokens / 1_000_000) * model.costPer1MInput +
          (outputTokens / 1_000_000) * model.costPer1MOutput
        );
      }
    }

    // Fall back to contract routing table
    const routingKey = req.modelId ?? 'default';
    const entry = this.routingTable.get(routingKey);

    if (entry) {
      const provider = this.providers.get(entry.providerId);
      const model = provider?.models.find((m) => m.modelId === entry.modelId);
      if (model) {
        return this.computeCost(model, inputTokens, outputTokens);
      }
    }

    return 0;
  }

  // ------------------------------------------------------------------------
  // Health tracking methods
  // ------------------------------------------------------------------------

  /**
   * Record a successful request to a provider.
   * Also records latency in ModelRouter for production-wide benefit.
   */
  recordSuccess(providerId: string, latencyMs: number): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;

    if (provider.health.averageLatency === 0) {
      provider.health.averageLatency = latencyMs;
    } else {
      provider.health.averageLatency = provider.health.averageLatency * 0.9 + latencyMs * 0.1;
    }

    provider.health.errorRate = Math.max(0, provider.health.errorRate * 0.95);

    if (provider.health.errorRate < 0.05 && provider.health.averageLatency < 5000) {
      provider.health.state = 'HEALTHY';
      provider.health.circuitBreakerOpen = false;
    }

    // Also record in production ModelRouter
    const modelRouter = getModelRouter();
    const model = provider.models[0];
    if (model) {
      modelRouter.recordLatency(providerId, model.modelId, latencyMs, latencyMs / 10, true);
    }

    this.requestCount++;
  }

  /**
   * Record a failed request to a provider.
   * Also records failure in ModelRouter.
   */
  recordError(providerId: string): void {
    const provider = this.providers.get(providerId);
    if (!provider) return;

    this.errorCount++;
    provider.health.errorRate = Math.min(1, provider.health.errorRate + 0.1);

    if (provider.health.errorRate > 0.5) {
      provider.health.circuitBreakerOpen = true;
      provider.health.state = 'UNHEALTHY';

      getGlobalLogger().warn('ContractLlmRouter', 'Circuit breaker opened', {
        providerId,
        errorRate: provider.health.errorRate,
      });
    } else if (provider.health.errorRate > 0.2) {
      provider.health.state = 'DEGRADED';
    }

    // Also record in production ModelRouter
    const modelRouter = getModelRouter();
    const model = provider.models[0];
    if (model) {
      modelRouter.recordLatency(providerId, model.modelId, 5000, 500, false);
    }
  }

  /**
   * Set a fallback chain for a routing key.
   */
  setFallbackChain(routingKey: string, providers: string[]): void {
    this.fallbackChains.set(routingKey, providers);
  }

  /**
   * Enable or disable a provider.
   */
  setProviderEnabled(providerId: string, enabled: boolean): void {
    const provider = this.providers.get(providerId);
    if (provider) {
      provider.enabled = enabled;
      getGlobalLogger().info('ContractLlmRouter', 'Provider toggled', {
        providerId,
        enabled,
      });
    }
  }

  /**
   * Get all registered provider IDs.
   */
  getProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Get request statistics.
   */
  getStats(): { totalRequests: number; totalErrors: number; errorRate: number } {
    return {
      totalRequests: this.requestCount,
      totalErrors: this.errorCount,
      errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
    };
  }

  // ------------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------------

  private selectWithFallback(
    entry: RoutingTableEntry,
    req: { inputTokens?: number; outputTokens?: number },
  ): IModelSelection {
    const inputTokens = req.inputTokens ?? 1000;
    const outputTokens = req.outputTokens ?? 500;

    const provider = this.providers.get(entry.providerId);
    if (provider && (!provider.enabled || provider.health.circuitBreakerOpen)) {
      const chain = this.fallbackChains.get(entry.modelId) ?? [];
      for (const fallbackProviderId of chain) {
        const fallbackProvider = this.providers.get(fallbackProviderId);
        if (
          fallbackProvider &&
          fallbackProvider.enabled &&
          !fallbackProvider.health.circuitBreakerOpen
        ) {
          const model =
            fallbackProvider.models.find((m) => m.modelId === entry.modelId) ??
            fallbackProvider.models[0];
          if (model) {
            this.requestCount++;
            return {
              modelId: model.modelId,
              providerId: fallbackProviderId,
              estimatedCost: this.computeCost(model, inputTokens, outputTokens),
              estimatedLatency: model.avgLatencyMs,
              confidence: 0.7,
            };
          }
        }
      }
    }

    this.requestCount++;
    const confidence = provider?.health.state === 'HEALTHY' ? 0.9 : 0.6;

    return {
      modelId: entry.modelId,
      providerId: entry.providerId,
      estimatedCost: this.computeCost(
        provider?.models.find((m) => m.modelId === entry.modelId) ?? null,
        inputTokens,
        outputTokens,
      ),
      estimatedLatency: entry.estimatedLatency,
      confidence,
    };
  }

  private computeCost(
    model: Provider['models'][0] | null,
    inputTokens: number,
    outputTokens: number,
  ): number {
    if (!model) return 0;
    return (
      (inputTokens / 1000) * model.inputCostPer1k + (outputTokens / 1000) * model.outputCostPer1k
    );
  }

  private rebuildRoutingTable(): void {
    this.routingTable.clear();

    for (const [providerId, provider] of this.providers) {
      for (const model of provider.models) {
        const key = model.modelId;
        if (!this.routingTable.has(key)) {
          this.routingTable.set(key, {
            modelId: model.modelId,
            providerId,
            estimatedCost: model.inputCostPer1k + model.outputCostPer1k,
            estimatedLatency: model.avgLatencyMs,
          });
        }
      }
    }

    // Set default routing to first available provider's first model
    for (const [providerId, provider] of this.providers) {
      if (provider.models.length > 0) {
        const model = provider.models[0];
        this.routingTable.set('default', {
          modelId: model.modelId,
          providerId,
          estimatedCost: model.inputCostPer1k + model.outputCostPer1k,
          estimatedLatency: model.avgLatencyMs,
        });
        break;
      }
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalContractLlmRouter: ContractLlmRouter | null = null;

export function getGlobalContractLlmRouter(): ContractLlmRouter {
  if (!globalContractLlmRouter) {
    globalContractLlmRouter = new ContractLlmRouter();
  }
  return globalContractLlmRouter;
}
