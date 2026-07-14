import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelRouter, resetModelRouter, getModelRouter } from '../../src/runtime/modelRouter';
import type { AgentExecutionContext, ModelConfig } from '../../src/runtime/types';

function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'Do something simple',
    contextData: {},
    availableTools: [],
    maxSteps: 5,
    tokenBudget: 4000,
    ...overrides,
  };
}

describe('ModelRouter', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  describe('default model registry', () => {
    it('has models in all tiers', () => {
      expect(router.listModels('eco').length).toBeGreaterThanOrEqual(1);
      expect(router.listModels('standard').length).toBeGreaterThanOrEqual(1);
      expect(router.listModels('power').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('custom model registration', () => {
    it('registers and retrieves a custom model', () => {
      const custom: ModelConfig = {
        id: 'my-model',
        provider: 'custom',
        tier: 'eco',
        costPer1MInput: 1,
        costPer1MOutput: 2,
        capabilities: ['code'],
        contextWindow: 8000,
        priority: 0,
      };
      router.registerModel(custom);
      expect(router.getModel('my-model')).toBeDefined();
      expect(router.getModel('my-model')!.provider).toBe('custom');
    });
  });

  describe('routing decisions', () => {
    it('routes simple tasks to eco tier', () => {
      const decision = router.route(makeContext({ goal: 'short task' }));
      expect(decision.tier).toBe('eco');
    });

    it('routes high complexity tasks to power tier', () => {
      const decision = router.route(
        makeContext({
          goal: 'A'.repeat(600),
          tokenBudget: 64000,
          availableTools: ['tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6'],
        }),
      );
      expect(['power', 'standard']).toContain(decision.tier);
    });

    it('routes critical risk to consensus tier', () => {
      const decision = router.route(
        makeContext({
          goal: 'A'.repeat(600),
          tokenBudget: 64000,
          availableTools: ['tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6'],
          contextData: {
            governanceProfile: { riskLevel: 'CRITICAL' },
          },
        }),
      );
      expect(['consensus', 'power']).toContain(decision.tier);
    });

    it('routes high risk to power tier', () => {
      const decision = router.route(
        makeContext({
          contextData: {
            governanceProfile: { riskLevel: 'HIGH' },
          },
        }),
      );
      expect(decision.tier).toBe('power');
    });

    it('includes reasoning in decision', () => {
      const decision = router.route(makeContext());
      expect(decision.reasoning.length).toBeGreaterThan(0);
      expect(decision.reasoning[0]).toContain('complexity');
    });

    it('estimates cost', () => {
      const decision = router.route(makeContext());
      expect(decision.estimatedCost).toBeGreaterThanOrEqual(0);
      expect(decision.maxTokens).toBeGreaterThan(0);
    });
  });

  describe('cost estimation', () => {
    it('calculates cost based on model rates', () => {
      const cost = router.estimateCost('gpt-4o-mini', 1000, 500);
      expect(cost).toBeGreaterThan(0);
    });

    it('returns 0 for unknown model', () => {
      const cost = router.estimateCost('nonexistent', 1000, 500);
      expect(cost).toBe(0);
    });
  });

  describe('learning-influenced routing', () => {
    beforeEach(() => {
      // Exact-model assertions: disable the 10% explore/exploit random pick
      // so route() deterministically returns the top-ranked candidate.
      router.setExploreRatio(0);
    });

    it('applies learning bonus with some outcomes', () => {
      for (let i = 0; i < 5; i++) {
        router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
      }
      const decision = router.route(makeContext({ goal: 'write a function' }));
      expect(decision.modelId).toBe('gpt-4o-mini');
    });

    it('applies learning bonus with many outcomes', () => {
      for (let i = 0; i < 35; i++) {
        router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
      }
      const decision = router.route(makeContext({ goal: 'write a function' }));
      expect(decision.modelId).toBe('gpt-4o-mini');
    });

    it('uses latency data when sample count is sufficient', () => {
      for (let i = 0; i < 5; i++) {
        router.recordLatency('openai', 'gpt-4o-mini', 50, 10, true);
      }
      const decision = router.route(makeContext({ goal: 'write a function' }));
      expect(decision.modelId).toBe('gpt-4o-mini');
    });
  });

  describe('required capabilities', () => {
    it('hasCapabilities returns true when all required capabilities are present', () => {
      expect(
        (router as any).hasCapabilities({ capabilities: ['code', 'analysis'] }, ['code']),
      ).toBe(true);
    });

    it('hasCapabilities returns false when a required capability is missing', () => {
      expect(
        (router as any).hasCapabilities({ capabilities: ['code', 'analysis'] }, ['math']),
      ).toBe(false);
    });

    it('bumpTierForCapabilities bumps eco to standard for creative capability', () => {
      expect((router as any).bumpTierForCapabilities('eco', ['creative'])).toBe('standard');
    });

    it('bumpTierForCapabilities keeps eco for code capability', () => {
      expect((router as any).bumpTierForCapabilities('eco', ['code'])).toBe('eco');
    });

    it('bumpTierForCapabilities falls back to original when no tier has capability', () => {
      expect((router as any).bumpTierForCapabilities('eco', ['nonexistent'])).toBe('eco');
    });

    it('getFallbackModel returns next model in chain', () => {
      const fallback = router.getFallbackModel('gpt-4o-mini', 'code');
      expect(fallback).toBeDefined();
      expect(fallback!.id).not.toBe('gpt-4o-mini');
    });

    it('getCascadeChain returns ordered models', () => {
      const chain = router.getCascadeChain('code', 5);
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].tier).toBe('eco');
    });
  });
});

describe('ModelRouter — provider tiers', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('configureFromTier filters by provider list', () => {
    const models = router.configureFromTier('essential');
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => ['openai', 'anthropic', 'google'].includes(m.provider))).toBe(true);
  });

  it('configureFromTier full returns all models', () => {
    const all = router.listModels();
    const full = router.configureFromTier('full');
    expect(full.length).toBe(all.length);
  });

  it('getRecommendedProviders returns providers for a tier', () => {
    expect(router.getRecommendedProviders('budget')).toContain('deepseek');
    expect(router.getRecommendedProviders('budget')).toContain('groq');
  });

  it('getProviderTiers returns tier metadata', () => {
    const tiers = router.getProviderTiers();
    expect(tiers.length).toBe(4);
    expect(tiers.some((t) => t.tier === 'enterprise')).toBe(true);
    expect(tiers.every((t) => typeof t.modelCount === 'number')).toBe(true);
  });
});

describe('ModelRouter — registration & listing', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('listModels returns all models when no tier is given', () => {
    expect(router.listModels().length).toBeGreaterThan(10);
  });

  it('registerModel updates the registry', () => {
    const custom: ModelConfig = {
      id: 'custom-model',
      provider: 'custom',
      tier: 'standard',
      costPer1MInput: 1,
      costPer1MOutput: 2,
      capabilities: ['code'],
      contextWindow: 8000,
      priority: 0,
    };
    router.registerModel(custom);
    expect(router.listModels('standard').some((m) => m.id === 'custom-model')).toBe(true);
  });

  it('registerModel overrides existing model', () => {
    const original = router.getModel('gpt-4o-mini')!;
    router.registerModel({ ...original, costPer1MInput: 999 });
    expect(router.getModel('gpt-4o-mini')!.costPer1MInput).toBe(999);
  });
});

describe('ModelRouter — governor-aware routing', () => {
  let router: ModelRouter;

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'test-agent',
      projectId: 'test-project',
      goal: 'implement a complex distributed system refactor with security audit',
      contextData: {},
      availableTools: [],
      maxSteps: 5,
      tokenBudget: 64000,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('critical governor demotes high-complexity tasks', () => {
    const decision = router.route(makeContext(), 'critical');
    expect(decision.tier).not.toBe('power');
  });

  it('tight governor prefers cheaper tier', () => {
    const decision = router.route(makeContext(), 'tight');
    expect(['eco', 'standard']).toContain(decision.tier);
  });

  it('relaxed governor allows power tier for complex tasks', () => {
    const decision = router.route(makeContext(), 'relaxed');
    expect(['power', 'standard']).toContain(decision.tier);
  });
});

describe('ModelRouter — user tier & preferred tier', () => {
  let router: ModelRouter;

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'test-agent',
      projectId: 'test-project',
      goal: 'A'.repeat(600),
      contextData: {},
      availableTools: ['t1', 't2', 't3', 't4', 't5', 't6'],
      maxSteps: 5,
      tokenBudget: 64000,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('free users cannot route to power tier', () => {
    router.setUserTier('u1', 'free');
    const decision = router.route(makeContext({ userId: 'u1' }));
    expect(decision.tier).not.toBe('power');
  });

  it('paid users route to higher tiers', () => {
    router.setUserTier('u1', 'paid');
    const decision = router.route(makeContext({ userId: 'u1' }));
    expect(['power', 'standard']).toContain(decision.tier);
  });

  it('preferredTier overrides auto selection', () => {
    const decision = router.route(makeContext(), 'relaxed', 'eco');
    expect(decision.tier).toBe('eco');
  });

  it('registeredProviders filters candidates', () => {
    const decision = router.route(makeContext(), 'relaxed', 'standard', new Set(['openai']));
    expect(decision.provider).toBe('openai');
  });
});

describe('ModelRouter — cascade & fallback', () => {
  let router: ModelRouter;

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'test-agent',
      projectId: 'test-project',
      goal: 'write a python function to sort a list',
      contextData: {},
      availableTools: [],
      maxSteps: 3,
      tokenBudget: 4000,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('getFallbackModel returns next model in tier', () => {
    const fallback = router.getFallbackModel('gpt-4o-mini', 'code');
    expect(fallback).toBeDefined();
    expect(fallback!.tier).toBe('eco');
  });

  it('getFallbackModel steps down tier when same tier exhausted', () => {
    const fallback = router.getFallbackModel('claude-opus-4-8', 'code');
    expect(fallback).toBeDefined();
    expect(fallback!.id).not.toBe('claude-opus-4-8');
  });

  it('getCascadeChain orders cheapest first', () => {
    const chain = router.getCascadeChain('code', 3);
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].tier).toBe('eco');
  });

  it('routeWithCascade in relaxed mode returns standard initial + chain', () => {
    const result = router.routeWithCascade(makeContext(), 'relaxed');
    expect(result.initial).toBeDefined();
    expect(result.escalationChain.length).toBeGreaterThan(0);
  });

  it('routeWithCascade in tight mode starts with cheapest', () => {
    const result = router.routeWithCascade(makeContext(), 'tight');
    expect(result.initial.tier).toBe('eco');
    expect(result.escalationChain.length).toBeGreaterThanOrEqual(0);
  });

  it('getNextEscalation returns next model in chain', () => {
    const chain = router.getCascadeChain('code', 3);
    expect(chain.length).toBeGreaterThanOrEqual(2);
    const next = router.getNextEscalation(chain[0].id, chain);
    expect(next).toBeDefined();
    expect(next!.id).toBe(chain[1].id);
  });

  it('getNextEscalation returns first model when current is not in chain', () => {
    const chain = router.getCascadeChain('code', 3);
    const next = router.getNextEscalation('nonexistent', chain);
    expect(next).toBeDefined();
    expect(next!.id).toBe(chain[0].id);
  });
});

describe('ModelRouter — learning & outcomes', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('recordOutcome tracks outcomes', () => {
    router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    expect(router.getLearningStats().length).toBe(1);
  });

  it('isLearningActive requires minimum samples', () => {
    for (let i = 0; i < 29; i++) {
      router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    }
    expect(router.isLearningActive('gpt-4o-mini', 'code')).toBe(false);
    router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    expect(router.isLearningActive('gpt-4o-mini', 'code')).toBe(true);
  });

  it('getMinSamplesForLearning returns threshold', () => {
    expect(router.getMinSamplesForLearning()).toBeGreaterThan(0);
  });

  it('prunes old outcomes when max exceeded', () => {
    for (let i = 0; i < 11000; i++) {
      router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    }
    expect(router.getLearningStats()[0].count).toBeLessThanOrEqual(10000);
  });
});

describe('ModelRouter — latency tracking', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('records latency for new provider/model', () => {
    router.recordLatency('openai', 'gpt-4o-mini', 100, 20, true);
    const lat = router.getLatency('openai', 'gpt-4o-mini');
    expect(lat).toBeDefined();
    expect(lat!.ewmaTTFT).toBe(100);
  });

  it('updates existing latency with EWMA', () => {
    router.recordLatency('openai', 'gpt-4o-mini', 100, 20, true);
    router.recordLatency('openai', 'gpt-4o-mini', 200, 40, true);
    const lat = router.getLatency('openai', 'gpt-4o-mini');
    expect(lat!.ewmaTTFT).toBeGreaterThan(100);
    expect(lat!.ewmaTTFT).toBeLessThan(200);
  });

  it('getAllLatencies returns all entries', () => {
    router.recordLatency('openai', 'gpt-4o-mini', 100, 20, true);
    router.recordLatency('anthropic', 'claude-haiku-4-5', 150, 30, true);
    expect(router.getAllLatencies().length).toBe(2);
  });
});

describe('ModelRouter — batch routing', () => {
  let router: ModelRouter;

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'test-agent',
      projectId: 'test-project',
      goal: 'label these support tickets',
      contextData: {},
      availableTools: [],
      maxSteps: 1,
      tokenBudget: 4000,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('routeBatch returns batch-capable model', () => {
    const model = router.routeBatch(makeContext());
    expect(model).toBeDefined();
    expect(model!.supportsBatchAPI).toBe(true);
  });

  it('isBatchEligible returns true for low-budget single-step tasks', () => {
    expect(ModelRouter.isBatchEligible(makeContext())).toBe(true);
  });

  it('isBatchEligible returns false for tasks with tools', () => {
    expect(ModelRouter.isBatchEligible(makeContext({ availableTools: ['search'] }))).toBe(false);
  });

  it('isBatchEligible returns false for multi-step tasks', () => {
    expect(ModelRouter.isBatchEligible(makeContext({ maxSteps: 10 }))).toBe(false);
  });
});

describe('ModelRouter — routing objectives & explore/exploit', () => {
  let router: ModelRouter;

  function makeContext(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
    return {
      agentId: 'test-agent',
      projectId: 'test-project',
      goal: 'write a function',
      contextData: {},
      availableTools: [],
      maxSteps: 3,
      tokenBudget: 4000,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('set and get routing objective', () => {
    router.setRoutingObjective({ type: 'cost_at_quality_floor', minQuality: 0.8 });
    expect(router.getRoutingObjective()).toEqual({
      type: 'cost_at_quality_floor',
      minQuality: 0.8,
    });
  });

  it('cost_at_quality_floor objective penalizes low-quality models', () => {
    router.setRoutingObjective({ type: 'cost_at_quality_floor', minQuality: 0.99 });
    const decision = router.route(makeContext());
    expect(decision.reasoning.some((r) => r.includes('routing_objective'))).toBe(true);
  });

  it('setExploreRatio clamps between 0 and 1', () => {
    router.setExploreRatio(1.5);
    expect(router.getExploreStats().exploreRatio).toBe(1);
    router.setExploreRatio(-0.5);
    expect(router.getExploreStats().exploreRatio).toBe(0);
  });

  it('explore stats track routing and explore counts', () => {
    router.setExploreRatio(0);
    for (let i = 0; i < 3; i++) router.route(makeContext());
    const stats = router.getExploreStats();
    expect(stats.routingCount).toBe(3);
    expect(stats.exploreCount).toBe(0);
  });
});

describe('ModelRouter — confidence check', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('checkConfidence returns default confidence for few outcomes', () => {
    const result = router.checkConfidence('gpt-4o-mini', 'code', 100);
    expect(result.confidence).toBe(0.5);
    expect(result.shouldEscalate).toBe(true);
  });

  it('checkConfidence boosts confidence with successful outcomes', () => {
    for (let i = 0; i < 35; i++) {
      router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    }
    const result = router.checkConfidence('gpt-4o-mini', 'code', 100);
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.shouldEscalate).toBe(false);
  });

  it('checkConfidence penalizes short responses', () => {
    for (let i = 0; i < 15; i++) {
      router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    }
    const short = router.checkConfidence('gpt-4o-mini', 'code', 10);
    const long = router.checkConfidence('gpt-4o-mini', 'code', 500);
    expect(short.confidence).toBeLessThan(long.confidence);
  });
});

describe('ModelRouter — edge cases & branch coverage', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
  });

  it('returns fallback decision when no model matches registered providers', () => {
    const decision = router.route(
      makeContext({ goal: 'write a function' }),
      'relaxed',
      undefined,
      new Set(['nonexistent-provider']),
    );
    expect(decision.modelId).toBe('fallback');
  });

  it('getFallbackModel returns undefined for unknown model', () => {
    expect(router.getFallbackModel('nonexistent-model', 'code')).toBeUndefined();
  });

  it('getFallbackModel steps down tiers when same tier has no match', () => {
    const custom: ModelConfig = {
      id: 'custom-consensus',
      provider: 'custom',
      tier: 'consensus',
      costPer1MInput: 10,
      costPer1MOutput: 20,
      capabilities: ['code'],
      contextWindow: 8000,
      priority: 0,
    };
    router.registerModel(custom);
    const fallback = router.getFallbackModel('custom-consensus', 'code');
    expect(fallback).toBeDefined();
    expect(fallback!.id).not.toBe('custom-consensus');
  });

  it('getCascadeChain filters by registered providers', () => {
    const chain = router.getCascadeChain('code', 5, new Set(['openai']));
    expect(chain.every((m) => m.provider === 'openai')).toBe(true);
  });

  it('routeWithCascade falls back to route when chain is empty', () => {
    const result = router.routeWithCascade(
      makeContext({ goal: 'write a function' }),
      'tight',
      undefined,
      new Set(['no-provider']),
    );
    expect(result.initial).toBeDefined();
    expect(result.escalationChain).toEqual([]);
  });

  it('routeBatch returns undefined when no batch model available', () => {
    const noBatchRouter = new ModelRouter([
      {
        id: 'no-batch',
        provider: 'custom',
        tier: 'eco',
        costPer1MInput: 1,
        costPer1MOutput: 2,
        capabilities: ['code'],
        contextWindow: 8000,
        supportsBatchAPI: false,
        priority: 0,
      },
    ]);
    expect(noBatchRouter.routeBatch(makeContext({ goal: 'write a function' }))).toBeUndefined();
  });

  it('isBatchEligible returns true for high-budget tasks', () => {
    expect(ModelRouter.isBatchEligible(makeContext({ tokenBudget: 60000 }))).toBe(true);
  });

  it('isBatchEligible returns true for sub-agent runs', () => {
    expect(
      ModelRouter.isBatchEligible(makeContext({ tokenBudget: 10000, parentRunId: 'run-1' })),
    ).toBe(true);
  });

  it('isBatchEligible returns true for single-step tasks', () => {
    expect(ModelRouter.isBatchEligible(makeContext({ maxSteps: 1, tokenBudget: 10000 }))).toBe(
      true,
    );
  });

  it('checkConfidence applies latency penalty', () => {
    for (let i = 0; i < 35; i++) {
      router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    }
    router.recordLatency('openai', 'gpt-4o-mini', 100, 500, false);
    const result = router.checkConfidence('gpt-4o-mini', 'code', 100);
    expect(result.confidence).toBeLessThan(1);
  });

  it('selectTier critical governor with high complexity', () => {
    const decision = router.route(
      makeContext({
        goal: 'design a secure distributed architecture with concurrency, audit and authentication',
        availableTools: ['t1', 't2', 't3', 't4', 't5', 't6'],
        tokenBudget: 64000,
      }),
      'critical',
    );
    expect(decision.tier).toBe('standard');
  });

  it('selectTier tight governor with high complexity', () => {
    const decision = router.route(
      makeContext({
        goal: 'design a secure distributed architecture with concurrency, audit and authentication',
        availableTools: ['t1', 't2', 't3', 't4', 't5', 't6'],
        tokenBudget: 64000,
      }),
      'tight',
    );
    expect(decision.tier).toBe('standard');
  });

  it('selectTier normal routing with high complexity', () => {
    const decision = router.route(
      makeContext({
        goal: 'design a secure distributed architecture with concurrency, audit and authentication',
        availableTools: ['t1', 't2', 't3', 't4', 't5', 't6'],
        tokenBudget: 64000,
      }),
      'relaxed',
    );
    expect(decision.tier).toBe('power');
  });

  it('prefers structured output models when outputSchema is set', () => {
    const decision = router.route(
      makeContext({
        goal: 'write a function',
        outputSchema: { type: 'object', properties: {} },
      }),
      'relaxed',
    );
    expect(decision.modelId).toBeDefined();
    const model = router.getModel(decision.modelId);
    expect(model?.supportsStructuredOutput || model?.supportsJSONMode).toBe(true);
  });

  it('applyRoutingObjective cost_at_quality_floor penalizes low success rate', () => {
    for (let i = 0; i < 35; i++) {
      router.recordOutcome('gpt-4o-mini', 'code', i % 2 === 0, 1000, 500);
    }
    router.setRoutingObjective({ type: 'cost_at_quality_floor', minQuality: 0.9 });
    const decision = router.route(makeContext({ goal: 'write a function' }));
    expect(decision.reasoning.some((r) => r.includes('routing_objective'))).toBe(true);
  });

  it('applyRoutingObjective quality_at_cost_ceiling boosts high-quality cheap models', () => {
    for (let i = 0; i < 35; i++) {
      router.recordOutcome('gpt-4o-mini', 'code', true, 1000, 500);
    }
    router.setRoutingObjective({ type: 'quality_at_cost_ceiling', maxCostPerRequest: 1.0 });
    const decision = router.route(makeContext({ goal: 'write a function' }));
    expect(decision.reasoning.some((r) => r.includes('routing_objective'))).toBe(true);
  });

  it('estimateTaskComplexity medium keyword and medium goal branches', () => {
    const decision = router.route(
      makeContext({
        goal: 'implement authentication integration',
        availableTools: ['t1', 't2', 't3', 't4'],
        tokenBudget: 12000,
      }),
    );
    expect(decision.modelId).toBeDefined();
  });
});

describe('ModelRouter — singleton', () => {
  beforeEach(() => {
    resetModelRouter();
  });

  it('getModelRouter returns same instance', () => {
    const a = getModelRouter();
    const b = getModelRouter();
    expect(a).toBe(b);
  });

  it('resetModelRouter creates new instance', () => {
    const a = getModelRouter();
    resetModelRouter();
    const b = getModelRouter();
    expect(a).not.toBe(b);
  });
});

describe('ModelRouter — AI-8 sensitive-tier floor', () => {
  let router: ModelRouter;

  beforeEach(() => {
    resetModelRouter();
    router = new ModelRouter();
    delete process.env.COMMANDER_MIN_SENSITIVE_MODEL_TIER;
  });

  afterEach(() => {
    delete process.env.COMMANDER_MIN_SENSITIVE_MODEL_TIER;
  });

  const NON_ECO: string[] = ['standard', 'power', 'consensus'];

  it('pins a trivial goal with a sensitive tool to at least standard tier', () => {
    const decision = router.route(
      makeContext({ goal: 'short task', availableTools: ['payment_transfer'] }),
    );
    expect(NON_ECO).toContain(decision.tier);
    expect(decision.reasoning.some((r) => r.includes('min_sensitive_tier: standard'))).toBe(true);
  });

  it('treats a capability token as sensitive regardless of goal keywords', () => {
    const decision = router.route(makeContext({ goal: 'short task', capabilityToken: 'cap-1' }));
    expect(NON_ECO).toContain(decision.tier);
  });

  it('leaves non-sensitive trivial goals on eco tier', () => {
    const decision = router.route(makeContext({ goal: 'short task' }));
    expect(decision.tier).toBe('eco');
    expect(decision.reasoning.some((r) => r.includes('min_sensitive_tier'))).toBe(false);
  });

  it('clamps an explicit eco preferredTier up to the floor for sensitive steps', () => {
    const decision = router.route(
      makeContext({ goal: 'short task', availableTools: ['deploy_service'] }),
      undefined,
      'eco',
    );
    expect(NON_ECO).toContain(decision.tier);
  });

  it('keeps the floor under tight-governor frugal cascade', () => {
    const { initial, escalationChain } = router.routeWithCascade(
      makeContext({ goal: 'short task', availableTools: ['delete_records'] }),
      'tight',
    );
    expect(NON_ECO).toContain(initial.tier);
    for (const m of escalationChain) {
      expect(NON_ECO).toContain(m.tier);
    }
  });

  it('still starts non-sensitive tight-governor cascades on eco', () => {
    const { initial } = router.routeWithCascade(makeContext({ goal: 'short task' }), 'tight');
    expect(initial.tier).toBe('eco');
  });

  it('honors COMMANDER_MIN_SENSITIVE_MODEL_TIER override', () => {
    process.env.COMMANDER_MIN_SENSITIVE_MODEL_TIER = 'power';
    const decision = router.route(
      makeContext({ goal: 'short task', availableTools: ['exec_shell'] }),
    );
    expect(['power', 'consensus']).toContain(decision.tier);
  });

  it('getCascadeChain excludes tiers below the floor', () => {
    const chain = router.getCascadeChain('general', 3, undefined, 'standard');
    expect(chain.length).toBeGreaterThan(0);
    for (const m of chain) {
      expect(NON_ECO).toContain(m.tier);
    }
  });

  it('getFallbackModel never steps below the floor and escalates instead', () => {
    const eco: ModelConfig = {
      id: 'only-eco',
      provider: 'test',
      tier: 'eco',
      costPer1MInput: 0.1,
      costPer1MOutput: 0.2,
      capabilities: ['code', 'analysis'],
      contextWindow: 8000,
      priority: 0,
    };
    const standard: ModelConfig = { ...eco, id: 'only-standard', tier: 'standard' };
    const power: ModelConfig = { ...eco, id: 'only-power', tier: 'power' };
    const custom = new ModelRouter([eco, standard, power]);

    // Without a floor, a failed standard model falls back down to eco.
    expect(custom.getFallbackModel('only-standard', 'general')?.id).toBe('only-eco');
    // With the floor, it must not fall below standard — it escalates to power.
    expect(custom.getFallbackModel('only-standard', 'general', 'standard')?.id).toBe('only-power');
    // Floor with nothing at-or-above left → undefined rather than below-floor.
    const twoTier = new ModelRouter([eco, standard]);
    expect(twoTier.getFallbackModel('only-standard', 'general', 'standard')).toBeUndefined();
  });
});
