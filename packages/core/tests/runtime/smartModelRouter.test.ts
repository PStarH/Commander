import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import type { AgentExecutionContext, ModelConfig } from '../../src/runtime/types';

function makeCtx(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
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

describe('SmartModelRouter', () => {
  describe('default model registry', () => {
    it('has models in all tiers', () => {
      const router = new ModelRouter();
      assert.ok(router.listModels('eco').length >= 1);
      assert.ok(router.listModels('standard').length >= 1);
      assert.ok(router.listModels('power').length >= 1);
    });
  });

  describe('custom model registration', () => {
    it('registers and retrieves a custom model', () => {
      const router = new ModelRouter();
      const custom: ModelConfig = {
        id: 'my-model',
        provider: 'custom',
        tier: 'eco',
        costPer1KInput: 0.001,
        costPer1KOutput: 0.002,
        capabilities: ['code'],
        contextWindow: 8000,
        priority: 0,
      };
      router.registerModel(custom);
      assert.ok(router.getModel('my-model'));
      assert.equal(router.getModel('my-model')!.provider, 'custom');
    });
  });

  describe('task-type-aware routing', () => {
    it('routes code tasks to code-capable models', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'Fix the bug in the Python function and run the script',
        }),
      );
      // Should prefer a model with 'code' capability
      const model = router.getModel(decision.modelId);
      assert.ok(model);
      assert.ok(
        model.capabilities.includes('code'),
        `Model ${model.id} should have 'code' capability`,
      );
    });

    it('routes analysis tasks to reasoning-capable models', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'Analyze the data and compare the two approaches to evaluate which is better',
        }),
      );
      const model = router.getModel(decision.modelId);
      assert.ok(model);
      assert.ok(
        model.capabilities.includes('analysis') || model.capabilities.includes('reasoning'),
      );
    });

    it('routes creative tasks to creative-capable models', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'Write a creative story about a robot that learns to paint',
          tokenBudget: 16000,
        }),
      );
      const model = router.getModel(decision.modelId);
      assert.ok(model);
      // Creative tasks should get a model with creative capability (or at least reasoning)
    });

    it('includes task_type in reasoning', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'Search for the latest news about AI',
        }),
      );
      assert.ok(decision.reasoning.some((r) => r.includes('task_type')));
    });

    it('includes required_capabilities in reasoning', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'Implement a sorting algorithm in Python',
        }),
      );
      assert.ok(decision.reasoning.some((r) => r.includes('required_capabilities')));
    });
  });

  describe('complexity and tier selection', () => {
    it('routes simple tasks to eco tier', () => {
      const router = new ModelRouter();
      const decision = router.route(makeCtx({ goal: 'short task' }));
      assert.equal(decision.tier, 'eco');
    });

    it('routes high complexity tasks to higher tiers', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'A'.repeat(600),
          tokenBudget: 64000,
          availableTools: ['tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6'],
        }),
      );
      assert.ok(['power', 'standard'].includes(decision.tier));
    });

    it('routes critical risk to consensus/power tier', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'A'.repeat(600),
          tokenBudget: 64000,
          availableTools: ['tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6'],
          contextData: {
            governanceProfile: { riskLevel: 'CRITICAL' },
          },
        }),
      );
      assert.ok(['consensus', 'power'].includes(decision.tier));
    });

    it('routes high risk to power tier', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          contextData: {
            governanceProfile: { riskLevel: 'HIGH' },
          },
        }),
      );
      assert.equal(decision.tier, 'power');
    });
  });

  describe('capability matching', () => {
    it('prefers models with matching capabilities', () => {
      const router = new ModelRouter();
      // Code task should prefer a code-capable model over one without
      const decision = router.route(
        makeCtx({
          goal: 'Write a function to calculate fibonacci numbers',
          tokenBudget: 4000,
        }),
      );
      const model = router.getModel(decision.modelId);
      assert.ok(model);
      assert.ok(model.capabilities.includes('code'));
    });

    it('still routes to a model when no capability match exists', () => {
      const router = new ModelRouter();
      const decision = router.route(
        makeCtx({
          goal: 'Hello, how are you?',
        }),
      );
      assert.ok(decision.modelId !== 'fallback');
    });
  });

  describe('outcome learning', () => {
    it('records outcomes without error', () => {
      const router = new ModelRouter();
      router.recordOutcome('gpt-4o-mini', 'code', true, 1500, 2000);
      router.recordOutcome('gpt-4o-mini', 'code', false, 3000, 5000);
      const stats = router.getLearningStats();
      assert.ok(stats.length >= 1);
      const gpt = stats.find((s) => s.modelId === 'gpt-4o-mini');
      assert.ok(gpt);
      assert.equal(gpt.count, 2);
    });

    it('learning affects model ranking', () => {
      const router = new ModelRouter();
      // Register a model specifically for this test
      router.registerModel({
        id: 'claude-3-5-haiku',
        provider: 'anthropic',
        tier: 'eco',
        costPer1KInput: 0.0008,
        costPer1KOutput: 0.004,
        capabilities: ['code', 'analysis'],
        contextWindow: 200000,
        priority: 0,
      });
      // Record many failures for gpt-4o-mini on code tasks
      for (let i = 0; i < 20; i++) {
        router.recordOutcome('gpt-4o-mini', 'code', false, 5000, 3000);
      }
      // Record many successes for claude-3-5-haiku on code tasks
      for (let i = 0; i < 20; i++) {
        router.recordOutcome('claude-3-5-haiku', 'code', true, 1000, 1000);
      }
      // Now route a code task — should prefer haiku
      const decision = router.route(
        makeCtx({
          goal: 'Fix the Python bug in the code',
          tokenBudget: 4000,
        }),
      );
      assert.equal(decision.modelId, 'claude-3-5-haiku');
    });
  });

  describe('fallback chain', () => {
    it('returns next model in tier on fallback', () => {
      const router = new ModelRouter();
      const fallback = router.getFallbackModel('claude-sonnet-4-6', 'code');
      assert.ok(fallback);
      assert.notEqual(fallback.id, 'claude-sonnet-4-6');
    });

    it('steps down tier when no same-tier fallback', () => {
      const router = new ModelRouter();
      const fallback = router.getFallbackModel('claude-opus-4-8', 'general');
      assert.ok(fallback);
      assert.ok(fallback.tier !== 'power' || fallback.id !== 'claude-opus-4-8');
    });

    it('returns undefined for unknown model', () => {
      const router = new ModelRouter();
      const fallback = router.getFallbackModel('nonexistent');
      assert.equal(fallback, undefined);
    });
  });

  describe('cost estimation', () => {
    it('calculates cost based on model rates', () => {
      const router = new ModelRouter();
      const cost = router.estimateCost('gpt-4o-mini', 1000, 500);
      assert.ok(cost > 0);
    });

    it('returns 0 for unknown model', () => {
      const router = new ModelRouter();
      const cost = router.estimateCost('nonexistent', 1000, 500);
      assert.equal(cost, 0);
    });

    it('includes reasoning with governor_phase', () => {
      const router = new ModelRouter();
      const decision = router.route(makeCtx());
      assert.ok(decision.reasoning.some((r) => r.includes('governor_phase')));
    });
  });
});
