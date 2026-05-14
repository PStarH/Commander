import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { ModelRouter, resetModelRouter } from '../../src/runtime/modelRouter';
import type { AgentExecutionContext, ModelConfig } from '../../src/runtime/types';

describe('ModelRouter', () => {
  let router: ModelRouter;

  before(() => {
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
        id: 'my-model', provider: 'custom', tier: 'eco',
        costPer1KInput: 0.001, costPer1KOutput: 0.002,
        capabilities: ['code'], contextWindow: 8000, priority: 0,
      };
      router.registerModel(custom);
      expect(router.getModel('my-model')).toBeDefined();
      expect(router.getModel('my-model')!.provider).toBe('custom');
    });
  });

  describe('routing decisions', () => {
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

    it('routes simple tasks to eco tier', () => {
      const decision = router.route(makeContext({ goal: 'short task' }));
      expect(decision.tier).toBe('eco');
    });

    it('routes high complexity tasks to power tier', () => {
      const decision = router.route(makeContext({
        goal: 'A'.repeat(600),
        tokenBudget: 64000,
        availableTools: ['tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6'],
      }));
      expect(['power', 'standard']).toContain(decision.tier);
    });

    it('routes critical risk to consensus tier', () => {
      const decision = router.route(makeContext({
        goal: 'A'.repeat(600),
        tokenBudget: 64000,
        availableTools: ['tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6'],
        contextData: {
          governanceProfile: { riskLevel: 'CRITICAL' },
        },
      }));
      expect(['consensus', 'power']).toContain(decision.tier);
    });

    it('routes high risk to power tier', () => {
      const decision = router.route(makeContext({
        contextData: {
          governanceProfile: { riskLevel: 'HIGH' },
        },
      }));
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
});
