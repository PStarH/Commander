/**
 * Smart Model Router — User-configurable, capability-based model selection.
 *
 * This module is now a thin adapter over ModelRouter. The core ranking,
 * capability matching, cascade and learning logic lives in modelRouter.ts;
 * this file preserves the SmartModelRouter API for backward compatibility.
 */
import type { ModelTier, RoutingDecision, AgentExecutionContext } from './types';
import type { ModelConfig } from './types';
import { ModelRouter, resolveMinSensitiveTier } from './modelRouter';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Capability types
// ============================================================================

export type ModelCapability =
  | 'code'
  | 'reasoning'
  | 'analysis'
  | 'creative'
  | 'math'
  | 'multimodal'
  | 'vision'
  | 'image_generation'
  | 'long_context'
  | 'low_cost'
  | 'fast'
  | 'high_quality'
  | 'function_calling'
  | 'json_mode'
  | 'streaming'
  | 'translation'
  | 'summarization'
  | 'extraction';

// ============================================================================
// User-configurable model definition
// ============================================================================

export interface UserModelConfig {
  id: string;
  provider: string;
  capabilities: ModelCapability[];
  costPer1MInput: number;
  costPer1MOutput: number;
  contextWindow: number;
  maxOutputTokens?: number;
  displayName?: string;
  description?: string;
  tags?: string[];
  tier?: ModelTier;
}

// ============================================================================
// Router configuration
// ============================================================================

export interface RoutingRule {
  taskType: string;
  requiredCapabilities: ModelCapability[];
  preferredTier?: ModelTier;
  maxCostPer1K?: number;
}

export interface ModelRouterUserConfig {
  mode: 'auto' | 'manual' | 'cascade';
  defaultModel?: string;
  modelPool: UserModelConfig[];
  routingRules?: RoutingRule[];
  budget?: {
    maxCostPerTask?: number;
    dailyBudget?: number;
  };
}

// ============================================================================
// Adapter helpers
// ============================================================================

function toModelConfig(user: UserModelConfig): ModelConfig {
  return {
    id: user.id,
    provider: user.provider,
    tier: user.tier ?? 'standard',
    costPer1MInput: user.costPer1MInput,
    costPer1MOutput: user.costPer1MOutput,
    capabilities: user.capabilities,
    contextWindow: user.contextWindow,
    priority: 0,
    supportsJSONMode: user.capabilities.includes('json_mode'),
    supportsStructuredOutput: user.capabilities.includes('json_mode'),
  };
}

function toUserModelConfig(model: ModelConfig): UserModelConfig {
  return {
    id: model.id,
    provider: model.provider,
    capabilities: model.capabilities as ModelCapability[],
    costPer1MInput: model.costPer1MInput,
    costPer1MOutput: model.costPer1MOutput,
    contextWindow: model.contextWindow,
    tier: model.tier,
  };
}

// ============================================================================
// Smart Model Router (adapter)
// ============================================================================

export class SmartModelRouter {
  private config: ModelRouterUserConfig;
  private inner: ModelRouter;

  constructor(config?: Partial<ModelRouterUserConfig>) {
    this.config = {
      mode: config?.mode ?? 'auto',
      defaultModel: config?.defaultModel,
      modelPool: config?.modelPool ?? this.getDefaultModelPool(),
      routingRules: config?.routingRules ?? this.getDefaultRoutingRules(),
      budget: config?.budget,
    };
    this.inner = new ModelRouter(this.config.modelPool.map(toModelConfig));
  }

  static fromConfig(config: ModelRouterUserConfig): SmartModelRouter {
    return new SmartModelRouter(config);
  }

  static fromEnv(): SmartModelRouter | null {
    const env = process.env.COMMANDER_MODELS;
    if (!env) return null;
    try {
      const config = JSON.parse(env) as ModelRouterUserConfig;
      return new SmartModelRouter(config);
    } catch (e) {
      getGlobalLogger().warn('SmartModelRouter', 'Failed to parse COMMANDER_MODELS env var', {
        error: (e as Error).message,
      });
      return null;
    }
  }

  /**
   * Main routing entry point. Delegates ranking and cascade logic to ModelRouter
   * while preserving the options-shaped API used by AgentRuntime.
   */
  route(
    ctx: AgentExecutionContext,
    options?: {
      preferredModel?: string;
      preferredTier?: ModelTier;
      governorPhase?: string;
      registeredProviders?: Set<string>;
    },
  ): RoutingDecision & { escalationChain?: string[] } {
    const preferredModel = options?.preferredModel ?? this.config.defaultModel;

    if (preferredModel) {
      const model = this.inner.getModel(preferredModel);
      if (model) {
        return { ...this.buildDecision(model, 'user_selected', ctx), escalationChain: undefined };
      }
    }

    if (this.config.mode === 'manual') {
      const first = this.config.modelPool[0];
      if (first) {
        return {
          ...this.buildDecision(toModelConfig(first), 'manual_mode_default', ctx),
          escalationChain: undefined,
        };
      }
      return { ...this.inner.route(ctx), escalationChain: undefined };
    }

    if (this.config.mode === 'cascade') {
      const { initial, escalationChain } = this.inner.routeWithCascade(
        ctx,
        options?.governorPhase,
        options?.preferredTier,
        options?.registeredProviders,
      );
      return { ...initial, escalationChain: escalationChain.map((m) => m.id) };
    }

    const initial = this.inner.route(
      ctx,
      options?.governorPhase,
      options?.preferredTier,
      options?.registeredProviders,
    );
    return { ...initial, escalationChain: undefined };
  }

  /**
   * Get the next escalation model after a failure.
   */
  getNextEscalation(currentModelId: string, escalationChain: string[]): UserModelConfig | null {
    const idx = escalationChain.indexOf(currentModelId);
    if (idx === -1 || idx >= escalationChain.length - 1) return null;
    const model = this.inner.getModel(escalationChain[idx + 1]);
    return model ? toUserModelConfig(model) : null;
  }

  /**
   * Look up a model by ID in the configured pool.
   */
  getModel(modelId: string): UserModelConfig | undefined {
    const model = this.inner.getModel(modelId);
    return model ? toUserModelConfig(model) : undefined;
  }

  /**
   * Record execution outcome for learning.
   */
  recordOutcome(modelId: string, taskType: string, success: boolean, durationMs: number): void {
    this.inner.recordOutcome(modelId, taskType, success, durationMs, 0);
  }

  /**
   * List models in the configured pool.
   */
  listModels(filter?: { capability?: ModelCapability; tier?: ModelTier }): UserModelConfig[] {
    let models = this.config.modelPool;
    if (filter?.capability) {
      models = models.filter((m) => m.capabilities.includes(filter.capability!));
    }
    if (filter?.tier) {
      models = models.filter((m) => m.tier === filter.tier);
    }
    return models;
  }

  /**
   * Add a model to the pool at runtime.
   */
  addModel(config: UserModelConfig): void {
    this.config.modelPool.push(config);
    this.inner.registerModel(toModelConfig(config));
  }

  /**
   * Remove a model from the pool.
   */
  removeModel(modelId: string): boolean {
    const before = this.config.modelPool.length;
    this.config.modelPool = this.config.modelPool.filter((m) => m.id !== modelId);
    // Rebuild inner router to reflect removal
    this.inner = new ModelRouter(this.config.modelPool.map(toModelConfig));
    return this.config.modelPool.length < before;
  }

  /**
   * Get routing stats for debugging.
   */
  getStats(): {
    totalModels: number;
    mode: string;
    capabilities: Record<string, number>;
  } {
    const capCounts: Record<string, number> = {};
    for (const m of this.config.modelPool) {
      for (const c of m.capabilities) {
        capCounts[c] = (capCounts[c] ?? 0) + 1;
      }
    }
    return {
      totalModels: this.config.modelPool.length,
      mode: this.config.mode,
      capabilities: capCounts,
    };
  }

  private buildDecision(
    model: ModelConfig,
    reason: string,
    ctx: AgentExecutionContext,
  ): RoutingDecision {
    const estimatedInputTokens = Math.ceil(ctx.goal.length / 4) + 2048;
    const estimatedOutputTokens = Math.min(
      ctx.tokenBudget,
      model.contextWindow - estimatedInputTokens,
    );
    const estimatedCost =
      (estimatedInputTokens / 1_000_000) * model.costPer1MInput +
      (estimatedOutputTokens / 1_000_000) * model.costPer1MOutput;

    // AI-8: explicit selections (user_selected / manual_mode_default) are trusted
    // operator config and are honored, but surface it in the decision when the
    // pinned model sits below the sensitive-tier floor so audits can flag it.
    const tierRank: Record<ModelTier, number> = { eco: 0, standard: 1, power: 2, consensus: 3 };
    const minSensitiveTier = resolveMinSensitiveTier(ctx);
    const belowFloor =
      minSensitiveTier !== undefined && tierRank[model.tier] < tierRank[minSensitiveTier];

    return {
      modelId: model.id,
      tier: model.tier,
      provider: model.provider,
      reasoning: [
        `routing_mode: ${this.config.mode}`,
        `reason: ${reason}`,
        ...(belowFloor
          ? [`warning: explicit model tier '${model.tier}' below sensitive floor '${minSensitiveTier}'`]
          : []),
        `model_capabilities: ${model.capabilities.join(', ')}`,
        `cost_estimate: $${estimatedCost.toFixed(6)}`,
      ],
      estimatedCost: Math.round(estimatedCost * 100000) / 100000,
      maxTokens: Math.min(estimatedOutputTokens, 200000),
    };
  }

  private getDefaultModelPool(): UserModelConfig[] {
    return [
      {
        id: 'gpt-4o-mini',
        provider: 'openai',
        tier: 'eco',
        capabilities: [
          'code',
          'analysis',
          'fast',
          'low_cost',
          'function_calling',
          'json_mode',
          'streaming',
        ],
        costPer1MInput: 0.15,
        costPer1MOutput: 0.6,
        contextWindow: 128000,
        displayName: 'GPT-4o Mini',
      },
      {
        id: 'gpt-4o',
        provider: 'openai',
        tier: 'standard',
        capabilities: [
          'code',
          'reasoning',
          'analysis',
          'creative',
          'multimodal',
          'vision',
          'function_calling',
          'json_mode',
          'streaming',
        ],
        costPer1MInput: 2.5,
        costPer1MOutput: 10,
        contextWindow: 128000,
        displayName: 'GPT-4o',
      },
      {
        id: 'claude-haiku-4-5',
        provider: 'anthropic',
        tier: 'eco',
        capabilities: ['code', 'analysis', 'fast', 'low_cost', 'streaming'],
        costPer1MInput: 0.8,
        costPer1MOutput: 4,
        contextWindow: 200000,
        displayName: 'Claude Haiku 4.5',
      },
      {
        id: 'claude-sonnet-4-6',
        provider: 'anthropic',
        tier: 'standard',
        capabilities: [
          'code',
          'reasoning',
          'analysis',
          'creative',
          'math',
          'multimodal',
          'vision',
          'long_context',
          'streaming',
        ],
        costPer1MInput: 3,
        costPer1MOutput: 15,
        contextWindow: 200000,
        displayName: 'Claude Sonnet 4.6',
      },
      {
        id: 'claude-opus-4-8',
        provider: 'anthropic',
        tier: 'power',
        capabilities: [
          'code',
          'reasoning',
          'analysis',
          'creative',
          'math',
          'multimodal',
          'vision',
          'long_context',
          'high_quality',
          'streaming',
        ],
        costPer1MInput: 15,
        costPer1MOutput: 75,
        contextWindow: 200000,
        displayName: 'Claude Opus 4.8',
      },
      {
        id: 'gemini-2-flash',
        provider: 'google',
        tier: 'eco',
        capabilities: ['analysis', 'fast', 'low_cost', 'long_context', 'multimodal', 'vision'],
        costPer1MInput: 0.1,
        costPer1MOutput: 0.4,
        contextWindow: 1000000,
        displayName: 'Gemini 2.0 Flash',
      },
      {
        id: 'gemini-2-pro',
        provider: 'google',
        tier: 'standard',
        capabilities: ['reasoning', 'analysis', 'math', 'long_context', 'multimodal', 'vision'],
        costPer1MInput: 1.5,
        costPer1MOutput: 7.5,
        contextWindow: 1000000,
        displayName: 'Gemini 2.0 Pro',
      },
      {
        id: 'deepseek-v4-flash',
        provider: 'deepseek',
        tier: 'eco',
        capabilities: ['code', 'reasoning', 'math', 'fast', 'low_cost'],
        costPer1MInput: 0.14,
        costPer1MOutput: 0.28,
        contextWindow: 128000,
        displayName: 'DeepSeek V4 Flash',
      },
      {
        id: 'deepseek-v4-pro',
        provider: 'deepseek',
        tier: 'power',
        capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math', 'long_context'],
        costPer1MInput: 2,
        costPer1MOutput: 8,
        contextWindow: 128000,
        displayName: 'DeepSeek V4 Pro',
      },
      {
        id: 'mimo-v2.5-pro',
        provider: 'mimo',
        tier: 'power',
        capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
        costPer1MInput: 4,
        costPer1MOutput: 12,
        contextWindow: 128000,
        displayName: 'MiMo V2.5 Pro',
      },
      {
        id: 'agnes-2.0-flash',
        provider: 'agnes',
        tier: 'eco',
        capabilities: ['code', 'reasoning', 'analysis', 'fast', 'low_cost', 'streaming'],
        costPer1MInput: 0,
        costPer1MOutput: 0,
        contextWindow: 128000,
        maxOutputTokens: 65536,
        displayName: 'Agnes 2.0 Flash',
      },
    ];
  }

  private getDefaultRoutingRules(): RoutingRule[] {
    return [
      { taskType: 'code', requiredCapabilities: ['code'], preferredTier: 'standard' },
      {
        taskType: 'multimodal',
        requiredCapabilities: ['multimodal', 'vision'],
        preferredTier: 'standard',
      },
      { taskType: 'math', requiredCapabilities: ['math', 'reasoning'], preferredTier: 'power' },
      { taskType: 'creative', requiredCapabilities: ['creative'], preferredTier: 'standard' },
      {
        taskType: 'long_context',
        requiredCapabilities: ['long_context'],
        preferredTier: 'standard',
      },
    ];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalRouter: SmartModelRouter | null = null;

export function getSmartModelRouter(): SmartModelRouter {
  if (!globalRouter) {
    globalRouter = SmartModelRouter.fromEnv() ?? new SmartModelRouter();
  }
  return globalRouter;
}

export function setSmartModelRouter(router: SmartModelRouter): void {
  globalRouter = router;
}
