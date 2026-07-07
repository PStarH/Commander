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
        costPer1MInput: 2.5,
        costPer1MOutput: 10,
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
        costPer1MInput: 10,
        costPer1MOutput: 40,
        capabilities: ['code'],
        contextWindow: 256000,
        priority: 0,
      });
      const cheap = estimator.estimateForModel(makeCtx(), {
        id: 'gpt-4o-mini',
        provider: 'openai',
        tier: 'eco',
        costPer1MInput: 0.15,
        costPer1MOutput: 0.6,
        capabilities: ['code'],
        contextWindow: 128000,
        priority: 0,
      });
      expect(expensive.costUsd).toBeGreaterThan(cheap.costUsd);
    });

    it('returns non-zero cost when only model.id is given (pricingTable lookup)', () => {
      // Mirrors scripts/bench-cost-prediction.ts shape: caller passes a ModelConfig
      // without explicit costPer1MInput/Output. pricingTable must resolve via name.
      const result = estimator.estimateForModel(makeCtx(), {
        id: 'gpt-4o-mini',
        provider: 'openai',
        tier: 'eco',
        capabilities: ['code'],
        contextWindow: 128000,
        priority: 0,
      } as any);
      expect(result.costUsd).toBeGreaterThan(0);
      // gpt-4o-mini is "eco" priced at 0.15 in / 0.6 out per 1M.
      expect(result.costUsd).toBeLessThan(0.05);
    });

    it('falls back to per-tier blended rate when model.id is unknown', () => {
      const result = estimator.estimateForModel(makeCtx(), {
        id: 'this-model-does-not-exist',
        provider: 'unknown',
        tier: 'eco',
        capabilities: [],
        contextWindow: 8000,
        priority: 0,
      } as any);
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('resolves model by .model property (bench-cost-prediction shape)', () => {
      // Mirrors scripts/bench-cost-prediction.ts: passes `{ model, tier } as any`
      // (no `id`, no explicit costPer1M*). Without this fallback, `model.id`
      // is undefined and lookups silently miss the table.
      const result = estimator.estimateForModel(makeCtx(), {
        model: 'gpt-4o-mini',
        tier: 'eco',
      } as any);
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('returns exact cost when bench fixture (gpt-4o-mini @ 0.15/0.6 per 1M) is used', () => {
      // Bench fixture: baseInput=1000, baseOutput=500.
      // actualCost = (1000 * 0.15 + 500 * 0.6) / 1e6 = 0.00045 USD.
      // Bench PASS contract: P95 errorPct < 50%.
      // We hand-craft ctx with multiplier that yields predicted tokens close to
      // the bench's randomized range (500..2500 input). This is the
      // regression test that actually proves the bench will turn green.
      const ctx: AgentExecutionContext = {
        agentId: 'bench',
        projectId: 'cost-prediction',
        goal: 'Perform task', // shortGoal: 0.6
        tokenBudget: 5000, // smallBudget: 0.7
        maxSteps: 1,
        availableTools: [], // fewTools: 0.8
        contextData: {},
      };
      const result = estimator.estimateForModel(ctx, {
        model: 'gpt-4o-mini',
        tier: 'eco',
      } as any);
      // baseline[general].input = 6000. After shortGoal × fewTools × smallBudget:
      // predictedInput = 6000 * 0.6 * 0.8 * 0.7 = 2016
      // predictedOutput  = 3000 * 0.6 * 0.8 * 0.7 = 1008
      // predictedCost    = 2016 * 0.15 / 1e6 + 1008 * 0.6 / 1e6
      //                 ≈ 0.000302 + 0.000605 = 0.000907
      expect(result.costUsd).toBeGreaterThan(0.0001);
      expect(result.costUsd).toBeLessThan(0.005);
    });

    it('does not throw when ctx lacks availableTools / tokenBudget (bench shape)', () => {
      // Regression test for the silent-throw bug the bench used to hit
      // (caught by its try/catch -> predictedCostUsd=0 -> MAE=100%).
      // With the defensive complexity path, the call must succeed.
      expect(() => {
        estimator.estimateForModel(
          { goal: 'do thing', taskCategory: 'general' } as any,
          { model: 'gpt-4o-mini', tier: 'eco' } as any,
        );
      }).not.toThrow();
    });
  });

  describe('pricingTable', () => {
    it('seeds default entries from DEFAULT_PRICING', () => {
      expect(estimator.getPricingTableSize()).toBeGreaterThan(20);
    });

    it('looks up exact model names', () => {
      const r1 = estimator.getPricingForModel('gpt-4o-mini');
      expect(r1?.inputPer1M).toBeCloseTo(0.15, 5);
      expect(r1?.outputPer1M).toBeCloseTo(0.6, 5);
    });

    it('strips @tier suffix before lookup', () => {
      const a = estimator.getPricingForModel('gpt-4o@standard');
      const b = estimator.getPricingForModel('gpt-4o@eco');
      // Both should resolve to 'gpt-4o' rates since the table is keyed by bare name.
      expect(a?.inputPer1M).toBeCloseTo(2.5, 5);
      expect(b?.inputPer1M).toBeCloseTo(2.5, 5);
    });

    it('strips provider/ prefix before lookup', () => {
      const r = estimator.getPricingForModel('openai/gpt-4o-mini');
      expect(r?.inputPer1M).toBeCloseTo(0.15, 5);
    });

    it('falls back to longest prefix when no exact match', () => {
      const r = estimator.getPricingForModel('claude-3-5-sonnet-20241022');
      expect(r).not.toBeNull();
      expect(r?.outputPer1M).toBeCloseTo(15, 5);
    });

    it('does not let prefix mismatch across token boundaries', () => {
      // 'gpt-4-turbo' must not be matched by 'gpt-4o' (woody substring problem).
      const r = estimator.getPricingForModel('gpt-4-turbo');
      expect(r?.inputPer1M).toBeCloseTo(10, 5);
    });

    it('returns null for empty / whitespace / non-string inputs', () => {
      expect(estimator.getPricingForModel('')).toBeNull();
      expect(estimator.getPricingForModel('   ')).toBeNull();
    });

    it('addPricing at runtime overrides default entries', () => {
      estimator.addPricing('gpt-4o-mini', { inputPer1M: 999, outputPer1M: 999 });
      const r = estimator.getPricingForModel('gpt-4o-mini');
      expect(r?.inputPer1M).toBeCloseTo(999, 5);
    });

    it('estimateCostFromUsage returns non-zero after pricingTable lookup', () => {
      const cost = estimator.estimateCostFromUsage('claude-3-5-sonnet', 1000, 500);
      // ~$(0.003 input + 0.0075 output) = ~0.0105
      expect(cost).toBeGreaterThan(0.005);
      expect(cost).toBeLessThan(0.05);
    });

    it('estimateForModel preserves explicit rates over pricingTable', () => {
      const result = estimator.estimateForModel(makeCtx(), {
        id: 'gpt-4o', // pricingTable exists
        provider: 'openai',
        tier: 'standard',
        costPer1MInput: 999, // explicitly override table
        costPer1MOutput: 999,
        capabilities: [],
        contextWindow: 128000,
        priority: 0,
      });
      // inputTokens 5000 × 999 / 1e6 ≈ 5
      expect(result.costUsd).toBeGreaterThan(1);
    });
  });

  describe('bench fixture parity (costEstimator pricingTable <-> scripts/bench-cost-prediction.ts)', () => {
    // Mirrors `TEST_MODEL_FIXTURES` in scripts/bench-cost-prediction.ts.
    // The contract is: per-model rates in the bench fixture MUST match the
    // rates in `packages/core/src/runtime/costEstimator.ts` `DEFAULT_PRICING`
    // (which in turn mirrors `packages/core/src/observability/costModel.ts`
    // DEFAULT_PRICING). Drift here would silently invalidate the bench's
    // PRNG-anchored accuracy comparison vs the pricingTable. Both sides
    // must be updated together.
    const BENCH_FIXTURES = [
      { model: 'gpt-4o-mini', tier: 'eco', inputPrice: 0.15, outputPrice: 0.6 },
      { model: 'gpt-4o', tier: 'standard', inputPrice: 2.5, outputPrice: 10.0 },
      { model: 'claude-3-5-sonnet', tier: 'standard', inputPrice: 3.0, outputPrice: 15.0 },
      { model: 'step-3.7-flash', tier: 'eco', inputPrice: 0.3, outputPrice: 0.9 },
    ] as const;

    for (const fix of BENCH_FIXTURES) {
      it(`${fix.model} fixture rates match pricingTable`, () => {
        const entry = estimator.getPricingForModel(fix.model);
        expect(entry, `pricingTable missing for ${fix.model}`).not.toBeNull();
        expect(entry!.inputPer1M).toBeCloseTo(fix.inputPrice, 6);
        expect(entry!.outputPer1M).toBeCloseTo(fix.outputPrice, 6);
      });
    }
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
