import { describe, it, expect, beforeEach } from 'vitest';
import { CostEstimator, resetCostEstimator } from '../../src/runtime/costEstimator';
import type { AgentExecutionContext, RoutingDecision } from '../../src/runtime/types';

function makeCtx(overrides?: Partial<AgentExecutionContext>): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'Fix the bug in file_read that causes timeout on large files',
    tokenBudget: 50000,
    maxSteps: 10,
    availableTools: ['file_read', 'file_edit', 'shell_execute'],
    contextData: {},
    ...overrides,
  };
}

function makeRouting(overrides?: Partial<RoutingDecision>): RoutingDecision {
  return {
    modelId: 'gpt-4o',
    tier: 'standard',
    provider: 'openai',
    reasoning: ['test'],
    estimatedCost: 0.01,
    maxTokens: 4096,
    ...overrides,
  };
}

describe('CostEstimator', () => {
  let estimator: CostEstimator;

  beforeEach(() => {
    resetCostEstimator();
    estimator = new CostEstimator();
  });

  describe('estimateBeforeRun', () => {
    it('returns a valid estimate with all required fields', () => {
      const estimate = estimator.estimateBeforeRun(makeCtx(), makeRouting());
      expect(estimate).toHaveProperty('predictedInputTokens');
      expect(estimate).toHaveProperty('predictedOutputTokens');
      expect(estimate).toHaveProperty('predictedTotalTokens');
      expect(estimate).toHaveProperty('predictedCostUsd');
      expect(estimate).toHaveProperty('recommendedBudget');
      expect(estimate).toHaveProperty('confidence');
      expect(estimate).toHaveProperty('sampleCount');
      expect(estimate).toHaveProperty('taskCategory');
      expect(estimate).toHaveProperty('modelTier');
      expect(estimate).toHaveProperty('factors');
    });

    it('predicts positive token counts', () => {
      const estimate = estimator.estimateBeforeRun(makeCtx(), makeRouting());
      expect(estimate.predictedInputTokens).toBeGreaterThan(0);
      expect(estimate.predictedOutputTokens).toBeGreaterThan(0);
      expect(estimate.predictedTotalTokens).toBeGreaterThan(0);
    });

    it('recommended budget is higher than predicted total (safety margin)', () => {
      const estimate = estimator.estimateBeforeRun(makeCtx(), makeRouting());
      expect(estimate.recommendedBudget).toBeGreaterThan(estimate.predictedTotalTokens);
    });

    it('confidence is 0 with no historical data', () => {
      const estimate = estimator.estimateBeforeRun(makeCtx(), makeRouting());
      expect(estimate.confidence).toBe(0);
    });

    it('detects task category from goal', () => {
      const codeCtx = makeCtx({ goal: 'Write a Python function to parse CSV files' });
      const estimate = estimator.estimateBeforeRun(codeCtx, makeRouting());
      expect(estimate.taskCategory).toBe('code');
    });

    it('detects search task category', () => {
      const searchCtx = makeCtx({ goal: 'Search for the latest React documentation' });
      const estimate = estimator.estimateBeforeRun(searchCtx, makeRouting());
      expect(estimate.taskCategory).toBe('search');
    });

    it('uses correct model tier from routing', () => {
      const ecoEstimate = estimator.estimateBeforeRun(makeCtx(), makeRouting({ tier: 'eco' }));
      const powerEstimate = estimator.estimateBeforeRun(makeCtx(), makeRouting({ tier: 'power' }));
      expect(ecoEstimate.modelTier).toBe('eco');
      expect(powerEstimate.modelTier).toBe('power');
      expect(powerEstimate.predictedCostUsd).toBeGreaterThan(ecoEstimate.predictedCostUsd);
    });

    it('longer goals produce higher complexity and more tokens', () => {
      const shortCtx = makeCtx({ goal: 'Fix bug' });
      const longCtx = makeCtx({
        goal: 'Analyze the entire codebase for security vulnerabilities, refactor the authentication module to use OAuth2, update all tests, and generate a comprehensive report with findings and recommendations for the engineering team',
      });
      const shortEst = estimator.estimateBeforeRun(shortCtx, makeRouting());
      const longEst = estimator.estimateBeforeRun(longCtx, makeRouting());
      expect(longEst.predictedTotalTokens).toBeGreaterThan(shortEst.predictedTotalTokens);
    });

    it('more tools increase predicted tokens', () => {
      const fewTools = makeCtx({ availableTools: ['file_read'] });
      const manyTools = makeCtx({
        availableTools: [
          'file_read',
          'file_edit',
          'shell_execute',
          'web_search',
          'browser_fetch',
          'memory_recall',
        ],
      });
      const fewEst = estimator.estimateBeforeRun(fewTools, makeRouting());
      const manyEst = estimator.estimateBeforeRun(manyTools, makeRouting());
      expect(manyEst.predictedTotalTokens).toBeGreaterThanOrEqual(fewEst.predictedTotalTokens);
    });
  });

  describe('recordActualCost + learning', () => {
    it('confidence increases after recording multiple costs', () => {
      const ctx = makeCtx();
      const routing = makeRouting();
      for (let i = 0; i < 10; i++) {
        estimator.recordActualCost('code', 'standard', 5000, 2000, 0.05, 1000, true);
      }
      const estimate = estimator.estimateBeforeRun(ctx, routing);
      expect(estimate.confidence).toBeGreaterThan(0);
      expect(estimate.sampleCount).toBe(10);
    });

    it('historical adjustment affects predictions after enough data', () => {
      // Record costs that are 2x the baseline
      for (let i = 0; i < 20; i++) {
        estimator.recordActualCost('general', 'standard', 12000, 6000, 0.1, 2000, true);
      }
      const estimate = estimator.estimateBeforeRun(makeCtx(), makeRouting());
      // Predicted tokens should be adjusted upward from baseline (6000 input, 3000 output)
      expect(estimate.predictedInputTokens).toBeGreaterThan(6000);
    });
  });

  describe('estimateForModel', () => {
    it('returns cost and token estimates for a model', () => {
      const result = estimator.estimateForModel(makeCtx(), {
        id: 'gpt-4o',
        provider: 'openai',
        tier: 'standard',
        costPer1KInput: 0.0025,
        costPer1KOutput: 0.01,
        capabilities: ['code'],
        contextWindow: 128000,
        priority: 0,
      });
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('cheaper models produce lower cost', () => {
      const expensive = estimator.estimateForModel(makeCtx(), {
        id: 'gpt-5',
        provider: 'openai',
        tier: 'power',
        costPer1KInput: 0.01,
        costPer1KOutput: 0.04,
        capabilities: ['code'],
        contextWindow: 256000,
        priority: 0,
      });
      const cheap = estimator.estimateForModel(makeCtx(), {
        id: 'gpt-4o-mini',
        provider: 'openai',
        tier: 'eco',
        costPer1KInput: 0.00015,
        costPer1KOutput: 0.0006,
        capabilities: ['code'],
        contextWindow: 128000,
        priority: 0,
      });
      expect(expensive.costUsd).toBeGreaterThan(cheap.costUsd);
    });
  });

  describe('allocateBudgetsAcrossAgents', () => {
    it('distributes budget proportional to complexity', () => {
      const subtasks = [
        { goal: 'Simple task', complexity: 1, modelTier: 'eco' },
        { goal: 'Complex task', complexity: 5, modelTier: 'standard' },
      ];
      const budgets = estimator.allocateBudgetsAcrossAgents(10000, subtasks);
      expect(budgets).toHaveLength(2);
      expect(budgets[1].budget).toBeGreaterThan(budgets[0].budget);
    });

    it('enforces minimum budget per agent', () => {
      const subtasks = Array.from({ length: 20 }, (_, i) => ({
        goal: `Task ${i}`,
        complexity: 1,
        modelTier: 'eco',
      }));
      const budgets = estimator.allocateBudgetsAcrossAgents(50000, subtasks);
      for (const b of budgets) {
        expect(b.budget).toBeGreaterThanOrEqual(2000);
      }
    });

    it('reserves safety margin from total budget', () => {
      const subtasks = [{ goal: 'Task', complexity: 1, modelTier: 'eco' }];
      const budgets = estimator.allocateBudgetsAcrossAgents(10000, subtasks, 0.2);
      expect(budgets[0].budget).toBeLessThanOrEqual(8000); // 10000 * (1 - 0.2)
    });

    it('handles empty subtasks', () => {
      const budgets = estimator.allocateBudgetsAcrossAgents(10000, []);
      expect(budgets).toHaveLength(0);
    });

    it('handles single subtask', () => {
      const budgets = estimator.allocateBudgetsAcrossAgents(10000, [
        { goal: 'Only task', complexity: 3, modelTier: 'standard' },
      ]);
      expect(budgets).toHaveLength(1);
      expect(budgets[0].budget).toBeGreaterThan(0);
    });
  });
});
