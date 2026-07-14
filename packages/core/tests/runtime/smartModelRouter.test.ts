import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SmartModelRouter,
  getSmartModelRouter,
  setSmartModelRouter,
  type UserModelConfig,
  type ModelCapability,
} from '../../src/runtime/smartModelRouter';
import type { AgentExecutionContext } from '../../src/runtime/types';

function makeCtx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    runId: 'run-1',
    goal: 'write a python function',
    agentId: 'agent-1',
    tokenBudget: 4096,
    budgetRemaining: 10,
    availableTools: [],
    contextData: {},
    ...(overrides as Partial<AgentExecutionContext>),
  } as AgentExecutionContext;
}

const testModel: UserModelConfig = {
  id: 'test-model',
  provider: 'test',
  capabilities: ['code', 'json_mode'],
  costPer1MInput: 1,
  costPer1MOutput: 2,
  contextWindow: 128000,
  tier: 'standard',
};

const cheapModel: UserModelConfig = {
  id: 'cheap-model',
  provider: 'test',
  capabilities: ['code', 'low_cost', 'fast'],
  costPer1MInput: 0.1,
  costPer1MOutput: 0.2,
  contextWindow: 128000,
  tier: 'eco',
};

const powerModel: UserModelConfig = {
  id: 'power-model',
  provider: 'test',
  capabilities: ['reasoning', 'math', 'high_quality'],
  costPer1MInput: 10,
  costPer1MOutput: 20,
  contextWindow: 200000,
  tier: 'power',
};

describe('SmartModelRouter', () => {
  beforeEach(() => {
    setSmartModelRouter(new SmartModelRouter({ modelPool: [testModel] }));
  });

  afterEach(() => {
    delete process.env.COMMANDER_MODELS;
  });

  it('constructs with default model pool', () => {
    const router = new SmartModelRouter();
    expect(router.getStats().totalModels).toBeGreaterThan(0);
    expect(router.getStats().mode).toBe('auto');
  });

  it('constructs with custom config', () => {
    const router = new SmartModelRouter({
      mode: 'manual',
      modelPool: [testModel],
      routingRules: [{ taskType: 'code', requiredCapabilities: ['code'] }],
    });
    expect(router.getStats().mode).toBe('manual');
    expect(router.getStats().totalModels).toBe(1);
  });

  it('fromConfig creates router', () => {
    const router = SmartModelRouter.fromConfig({
      mode: 'auto',
      modelPool: [cheapModel],
    });
    expect(router.getStats().totalModels).toBe(1);
  });

  it('fromEnv returns null when env is missing', () => {
    delete process.env.COMMANDER_MODELS;
    expect(SmartModelRouter.fromEnv()).toBeNull();
  });

  it('fromEnv parses COMMANDER_MODELS', () => {
    process.env.COMMANDER_MODELS = JSON.stringify({
      mode: 'manual',
      modelPool: [testModel],
    });
    const router = SmartModelRouter.fromEnv();
    expect(router).not.toBeNull();
    expect(router!.getStats().mode).toBe('manual');
  });

  it('fromEnv handles invalid JSON', () => {
    process.env.COMMANDER_MODELS = 'not-json';
    const router = SmartModelRouter.fromEnv();
    expect(router).toBeNull();
  });

  it('routes with preferredModel when available', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel] });
    const decision = router.route(makeCtx(), { preferredModel: 'test-model' });
    expect(decision.modelId).toBe('test-model');
    expect(decision.reasoning.some((r) => r.includes('user_selected'))).toBe(true);
    expect(decision.escalationChain).toBeUndefined();
  });

  it('AI-8: warns when an explicitly selected model sits below the sensitive floor', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel] });
    const decision = router.route(makeCtx({ availableTools: ['payment_transfer'] }), {
      preferredModel: 'cheap-model',
    });
    // Explicit operator selection is honored, but the decision surfaces the risk.
    expect(decision.modelId).toBe('cheap-model');
    expect(decision.reasoning.some((r) => r.includes('below sensitive floor'))).toBe(true);
  });

  it('AI-8: no floor warning for non-sensitive contexts', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel] });
    const decision = router.route(makeCtx(), { preferredModel: 'cheap-model' });
    expect(decision.reasoning.some((r) => r.includes('below sensitive floor'))).toBe(false);
  });

  it('routes with defaultModel when no preferredModel', () => {
    const router = new SmartModelRouter({
      modelPool: [cheapModel, testModel],
      defaultModel: 'test-model',
    });
    const decision = router.route(makeCtx());
    expect(decision.modelId).toBe('test-model');
  });

  it('falls back to inner routing when preferredModel not found', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel] });
    const decision = router.route(makeCtx(), { preferredModel: 'missing' });
    expect(decision.modelId).toBeDefined();
  });

  it('manual mode returns first model', () => {
    const router = new SmartModelRouter({
      mode: 'manual',
      modelPool: [cheapModel, testModel],
    });
    const decision = router.route(makeCtx());
    expect(decision.modelId).toBe('cheap-model');
    expect(decision.reasoning.some((r) => r.includes('manual_mode_default'))).toBe(true);
  });

  it('manual mode falls back when pool is empty', () => {
    const router = new SmartModelRouter({ mode: 'manual', modelPool: [] });
    const decision = router.route(makeCtx());
    expect(decision.modelId).toBeDefined();
  });

  it('cascade mode returns escalation chain', () => {
    const router = new SmartModelRouter({
      mode: 'cascade',
      modelPool: [cheapModel, testModel, powerModel],
    });
    const decision = router.route(makeCtx());
    expect(decision.escalationChain).toBeDefined();
    expect(decision.escalationChain!.length).toBeGreaterThan(0);
    expect(decision.escalationChain![0]).toBe(decision.modelId);
  });

  it('auto mode returns decision without escalation chain', () => {
    const router = new SmartModelRouter({
      mode: 'auto',
      modelPool: [cheapModel, testModel],
    });
    const decision = router.route(makeCtx());
    expect(decision.modelId).toBeDefined();
    expect(decision.escalationChain).toBeUndefined();
  });

  it('getNextEscalation returns next model', () => {
    const router = new SmartModelRouter({
      mode: 'cascade',
      modelPool: [cheapModel, testModel, powerModel],
    });
    const decision = router.route(makeCtx());
    const chain = decision.escalationChain!;
    if (chain.length >= 2) {
      const next = router.getNextEscalation(chain[0]!, chain);
      expect(next).not.toBeNull();
      expect(next!.id).toBe(chain[1]);
    }
  });

  it('getNextEscalation returns null for last model', () => {
    const router = new SmartModelRouter({
      mode: 'cascade',
      modelPool: [cheapModel, testModel],
    });
    const decision = router.route(makeCtx());
    const chain = decision.escalationChain!;
    expect(router.getNextEscalation(chain[chain.length - 1]!, chain)).toBeNull();
  });

  it('getNextEscalation returns null when model not in chain', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel] });
    expect(router.getNextEscalation('missing', ['cheap-model'])).toBeNull();
  });

  it('getModel returns configured model', () => {
    const router = new SmartModelRouter({ modelPool: [testModel] });
    const model = router.getModel('test-model');
    expect(model).toBeDefined();
    expect(model!.id).toBe('test-model');
  });

  it('getModel returns undefined for unknown model', () => {
    const router = new SmartModelRouter({ modelPool: [testModel] });
    expect(router.getModel('missing')).toBeUndefined();
  });

  it('recordOutcome does not throw', () => {
    const router = new SmartModelRouter({ modelPool: [testModel] });
    expect(() => router.recordOutcome('test-model', 'code', true, 100)).not.toThrow();
  });

  it('listModels returns all models without filter', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel, powerModel] });
    expect(router.listModels()).toHaveLength(3);
  });

  it('listModels filters by capability', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel, powerModel] });
    const codeModels = router.listModels({ capability: 'code' as ModelCapability });
    expect(codeModels.every((m) => m.capabilities.includes('code'))).toBe(true);
  });

  it('listModels filters by tier', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel, powerModel] });
    const ecoModels = router.listModels({ tier: 'eco' });
    expect(ecoModels.every((m) => m.tier === 'eco')).toBe(true);
  });

  it('addModel adds to pool', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel] });
    router.addModel(testModel);
    expect(router.getStats().totalModels).toBe(2);
    expect(router.getModel('test-model')).toBeDefined();
  });

  it('removeModel removes from pool', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel] });
    expect(router.removeModel('cheap-model')).toBe(true);
    expect(router.getStats().totalModels).toBe(1);
    expect(router.getModel('cheap-model')).toBeUndefined();
  });

  it('removeModel returns false when model not found', () => {
    const router = new SmartModelRouter({ modelPool: [testModel] });
    expect(router.removeModel('missing')).toBe(false);
  });

  it('getStats reports capability counts', () => {
    const router = new SmartModelRouter({ modelPool: [cheapModel, testModel] });
    const stats = router.getStats();
    expect(stats.capabilities['code']).toBe(2);
  });

  it('buildDecision includes cost estimate', () => {
    const router = new SmartModelRouter({ modelPool: [testModel], defaultModel: 'test-model' });
    const decision = router.route(makeCtx());
    expect(decision.estimatedCost).toBeGreaterThanOrEqual(0);
    expect(decision.maxTokens).toBeGreaterThan(0);
    expect(decision.reasoning.some((r) => r.includes('cost_estimate'))).toBe(true);
  });

  it('getSmartModelRouter returns singleton', () => {
    const a = getSmartModelRouter();
    const b = getSmartModelRouter();
    expect(a).toBe(b);
  });

  it('setSmartModelRouter overrides singleton', () => {
    const router = new SmartModelRouter({ modelPool: [testModel] });
    setSmartModelRouter(router);
    expect(getSmartModelRouter()).toBe(router);
  });
});
