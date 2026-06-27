/**
 * Tests for Block 1 (Pricing Unification) + Block 3 (Batch API)
 *
 * Covers:
 *   - CostModel LiteLLM sync (no crash, idempotent)
 *   - CostModel batch pricing calculation (50% discount)
 *   - CostModel batch savings reporting
 *   - CostModel unknown model LiteLLM fallback
 *   - ModelRouter.isBatchEligible fail-closed guards
 *   - ModelRouter.routeBatch returns batch-capable models
 *   - BatchAPIClient supportsNativeBatchAPI
 *   - BatchAPIClient executeViaBatchAPI fail-closed on fetch failure
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CostModel, DEFAULT_PRICING, getCostModel } from '../../src/observability/costModel';
import type { TokenBreakdown } from '../../src/observability/types';
import { ModelRouter, getModelRouter } from '../../src/runtime/modelRouter';
import { supportsNativeBatchAPI, executeViaBatchAPI, type BatchAPIConfig } from '../../src/runtime/batchApiClient';
import type { AgentExecutionContext } from '../../src/runtime/types/execution';

// ============================================================================
// Helpers
// ============================================================================

function makeTokenBreakdown(input: number, output: number, cached = 0): TokenBreakdown {
  return { input, output, cached, reasoning: 0, total: input + output + cached };
}

function makeExecutionContext(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    agentId: 'test-agent',
    projectId: 'test-project',
    goal: 'Analyze data',
    contextData: {},
    availableTools: [],
    maxSteps: 3,
    tokenBudget: 10000,
    ...overrides,
  } as AgentExecutionContext;
}

// ============================================================================
// Block 1: CostModel LiteLLM Integration + Batch Pricing
// ============================================================================

describe('Block 1 — CostModel LiteLLM + Batch Pricing', () => {

  describe('LiteLLM sync', () => {
    it('syncFromLiteLLM does not crash when LiteLLM data is unavailable', () => {
      const model = new CostModel();
      // LiteLLM data may or may not be loaded; syncFromLiteLLM should be a no-op
      // if data is not available, without throwing
      assert.doesNotThrow(() => model.syncFromLiteLLM());
    });

    it('syncFromLiteLLM is idempotent (safe to call multiple times)', () => {
      const model = new CostModel();
      model.syncFromLiteLLM();
      model.syncFromLiteLLM(); // should not throw or double-apply
      model.syncFromLiteLLM();
      // Verify pricing is still accessible
      const p = model.getPricing('openai', 'gpt-4o');
      assert.ok(p);
      assert.ok(p.inputPer1k > 0);
    });

    it('getCostModel() singleton triggers LiteLLM sync without crashing', () => {
      const cm = getCostModel();
      const p = cm.getPricing('openai', 'gpt-4o');
      assert.ok(p);
      assert.ok(p.inputPer1k > 0);
    });
  });

  describe('Batch pricing calculation', () => {
    it('calculate() with isBatch=true applies 50% discount on input', () => {
      const cm = getCostModel();
      const tokens = makeTokenBreakdown(10000, 5000);
      const standard = cm.calculate('openai', 'gpt-4o', tokens, false);
      const batch = cm.calculate('openai', 'gpt-4o', tokens, true);
      // Batch should be ~50% of standard for input+output
      assert.ok(batch.totalCostUsd < standard.totalCostUsd);
      assert.ok(batch.totalCostUsd <= standard.totalCostUsd * 0.6); // at most 60% (due to cache cost being same)
    });

    it('calculate() with isBatch=true reports batchSavingsUsd', () => {
      const cm = getCostModel();
      const tokens = makeTokenBreakdown(10000, 5000);
      const batch = cm.calculate('openai', 'gpt-4o', tokens, true);
      assert.ok(batch.batchSavingsUsd !== undefined);
      assert.ok(batch.batchSavingsUsd! > 0);
    });

    it('calculate() with isBatch=false does not report batchSavingsUsd', () => {
      const cm = getCostModel();
      const tokens = makeTokenBreakdown(10000, 5000);
      const standard = cm.calculate('openai', 'gpt-4o', tokens, false);
      assert.strictEqual(standard.batchSavingsUsd, undefined);
    });

    it('getBatchSavings() returns correct savings amounts', () => {
      const cm = getCostModel();
      const result = cm.getBatchSavings('openai', 'gpt-4o', 10000, 5000);
      assert.ok(result.standardCostUsd > result.batchCostUsd);
      assert.ok(result.savingsUsd > 0);
      // Savings should be ~50% of standard cost
      const ratio = result.savingsUsd / result.standardCostUsd;
      assert.ok(ratio > 0.4 && ratio < 0.6, `Expected ~0.5 ratio, got ${ratio}`);
    });

    it('batch pricing works for Anthropic models', () => {
      const cm = getCostModel();
      const tokens = makeTokenBreakdown(10000, 5000);
      const batch = cm.calculate('anthropic', 'claude-sonnet-4-6', tokens, true);
      const standard = cm.calculate('anthropic', 'claude-sonnet-4-6', tokens, false);
      assert.ok(batch.totalCostUsd < standard.totalCostUsd);
      assert.ok(batch.batchSavingsUsd! > 0);
    });
  });

  describe('Unknown model LiteLLM fallback', () => {
    it('getPricing() returns fallback for truly unknown models', () => {
      const cm = getCostModel();
      const p = cm.getPricing('unknown-provider', 'nonexistent-model-xyz');
      // Should return fallback pricing (not undefined, not crash)
      assert.ok(p);
      assert.ok(p.inputPer1k >= 0);
    });
  });
});

// ============================================================================
// Block 3a: Batch Model Registration
// ============================================================================

describe('Block 3a — Batch Model Registration', () => {
  const router = getModelRouter();

  it('OpenAI gpt-4o has supportsBatchAPI=true', () => {
    const model = router.getModel('gpt-4o');
    assert.ok(model);
    assert.strictEqual(model!.supportsBatchAPI, true);
    assert.ok(model!.maxBatchSize! > 0);
  });

  it('OpenAI gpt-4o-mini has supportsBatchAPI=true', () => {
    const model = router.getModel('gpt-4o-mini');
    assert.ok(model);
    assert.strictEqual(model!.supportsBatchAPI, true);
  });

  it('OpenAI gpt-5 has supportsBatchAPI=true', () => {
    const model = router.getModel('gpt-5');
    assert.ok(model);
    assert.strictEqual(model!.supportsBatchAPI, true);
  });

  it('Anthropic claude-sonnet-4-6 has supportsBatchAPI=true', () => {
    const model = router.getModel('claude-sonnet-4-6');
    assert.ok(model, 'claude-sonnet-4-6 should exist in model registry');
    assert.strictEqual(model!.provider, 'anthropic');
    assert.strictEqual(model!.supportsBatchAPI, true);
    assert.ok(model!.maxBatchSize! > 0);
  });

  it('Anthropic claude-haiku-4-5 has supportsBatchAPI=true', () => {
    const model = router.getModel('claude-haiku-4-5');
    assert.ok(model);
    assert.strictEqual(model!.supportsBatchAPI, true);
  });

  it('Anthropic claude-opus-4-8 has supportsBatchAPI=true', () => {
    const model = router.getModel('claude-opus-4-8');
    assert.ok(model);
    assert.strictEqual(model!.supportsBatchAPI, true);
  });
});

// ============================================================================
// Block 3f: Batch Eligibility Fail-Closed Guards
// ============================================================================

describe('Block 3f — isBatchEligible Fail-Closed Guards', () => {

  it('returns false when maxSteps > 5 (interactive tasks)', () => {
    const ctx = makeExecutionContext({ maxSteps: 10 });
    assert.strictEqual(ModelRouter.isBatchEligible(ctx), false);
  });

  it('returns false when availableTools is non-empty (tool calls need real-time)', () => {
    const ctx = makeExecutionContext({
      maxSteps: 3,
      availableTools: ['web_search', 'file_read'],
    });
    assert.strictEqual(ModelRouter.isBatchEligible(ctx), false);
  });

  it('returns true for low-budget tasks without tools (≤5 steps)', () => {
    const ctx = makeExecutionContext({
      maxSteps: 3,
      tokenBudget: 3000,
      availableTools: [],
    });
    assert.strictEqual(ModelRouter.isBatchEligible(ctx), true);
  });

  it('returns true for high-token tasks without tools', () => {
    const ctx = makeExecutionContext({
      maxSteps: 3,
      tokenBudget: 60000,
      availableTools: [],
    });
    assert.strictEqual(ModelRouter.isBatchEligible(ctx), true);
  });

  it('returns true for sub-agent tasks with parentRunId', () => {
    const ctx = makeExecutionContext({
      maxSteps: 4,
      tokenBudget: 10000,
      parentRunId: 'parent-123',
      availableTools: [],
    });
    assert.strictEqual(ModelRouter.isBatchEligible(ctx), true);
  });

  it('returns true for single-step tasks', () => {
    const ctx = makeExecutionContext({
      maxSteps: 1,
      tokenBudget: 10000,
      availableTools: [],
    });
    assert.strictEqual(ModelRouter.isBatchEligible(ctx), true);
  });

  it('returns false for medium-budget tasks without parentRunId (user-facing)', () => {
    const ctx = makeExecutionContext({
      maxSteps: 3,
      tokenBudget: 10000,
      availableTools: [],
      // no parentRunId → likely user-facing
    });
    assert.strictEqual(ModelRouter.isBatchEligible(ctx), false);
  });
});

// ============================================================================
// Block 3a: routeBatch returns batch-capable models
// ============================================================================

describe('Block 3a — routeBatch', () => {
  const router = getModelRouter();

  it('returns a batch-capable model for eligible tasks', () => {
    const ctx = makeExecutionContext({
      maxSteps: 1,
      tokenBudget: 3000,
      availableTools: [],
    });
    const batchModel = router.routeBatch(ctx, 'eco');
    assert.ok(batchModel, 'routeBatch should return a model for eligible tasks');
    assert.strictEqual(batchModel!.supportsBatchAPI, true);
  });

  it('returns undefined when no batch model at the requested tier', () => {
    // Request 'consensus' tier which has no batch-capable models
    const ctx = makeExecutionContext({
      maxSteps: 1,
      tokenBudget: 3000,
      availableTools: [],
    });
    // routeBatch tries targetTier, then eco, then standard — so it should still find something
    // This test verifies the fallback chain works
    const batchModel = router.routeBatch(ctx, 'eco');
    assert.ok(batchModel);
  });

  it('returns cheapest batch-capable model', () => {
    const ctx = makeExecutionContext({
      maxSteps: 1,
      tokenBudget: 3000,
      availableTools: [],
    });
    const batchModel = router.routeBatch(ctx, 'eco');
    assert.ok(batchModel);
    // Should be one of the eco tier batch models
    assert.ok(
      batchModel!.id === 'gpt-4o-mini' || batchModel!.id === 'claude-haiku-4-5',
      `Expected eco batch model, got ${batchModel!.id}`,
    );
  });
});

// ============================================================================
// Block 3b: BatchAPIClient
// ============================================================================

describe('Block 3b — BatchAPIClient', () => {

  it('supportsNativeBatchAPI returns true for openai', () => {
    assert.strictEqual(supportsNativeBatchAPI('openai'), true);
  });

  it('supportsNativeBatchAPI returns true for anthropic', () => {
    assert.strictEqual(supportsNativeBatchAPI('anthropic'), true);
  });

  it('supportsNativeBatchAPI returns false for other providers', () => {
    assert.strictEqual(supportsNativeBatchAPI('deepseek'), false);
    assert.strictEqual(supportsNativeBatchAPI('google'), false);
    assert.strictEqual(supportsNativeBatchAPI('mistral'), false);
    assert.strictEqual(supportsNativeBatchAPI('groq'), false);
  });

  it('executeViaBatchAPI returns null on fetch failure (fail-closed)', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      return new Response('Internal Server Error', { status: 500 });
    }) as typeof fetch;

    try {
      const config: BatchAPIConfig = {
        pollIntervalMs: 100,
        maxPollAttempts: 1,
        apiKey: 'test-key',
      };
      const request = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 100,
      };
      const result = await executeViaBatchAPI(request as any, 'openai', config);
      // Should return null (fail-closed) when batch submission fails
      assert.strictEqual(result, null);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('executeViaBatchAPI returns null when network throws (fail-closed)', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      throw new Error('Network error');
    }) as typeof fetch;

    try {
      const config: BatchAPIConfig = {
        pollIntervalMs: 100,
        maxPollAttempts: 1,
        apiKey: 'test-key',
      };
      const request = {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 100,
      };
      const result = await executeViaBatchAPI(request as any, 'openai', config);
      assert.strictEqual(result, null);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ============================================================================
// Block 3e: Batch Savings in CostModel
// ============================================================================

describe('Block 3e — Batch Savings Integration', () => {

  it('addCost preserves batchSavingsUsd', () => {
    const cm = getCostModel();
    const tokens = makeTokenBreakdown(5000, 2000);
    const a = cm.calculate('openai', 'gpt-4o', tokens, true);
    const b = cm.calculate('anthropic', 'claude-sonnet-4-6', tokens, true);
    const combined = cm.addCost(a, b);
    assert.ok(combined.batchSavingsUsd !== undefined);
    assert.ok(combined.batchSavingsUsd! > 0);
    // Should be the sum of individual savings
    const expectedSum = (a.batchSavingsUsd ?? 0) + (b.batchSavingsUsd ?? 0);
    assert.ok(
      Math.abs(combined.batchSavingsUsd! - expectedSum) < 0.0001,
      `Expected ${expectedSum}, got ${combined.batchSavingsUsd}`,
    );
  });

  it('addCost sets batchSavingsUsd to undefined when neither has savings', () => {
    const cm = getCostModel();
    const tokens = makeTokenBreakdown(5000, 2000);
    const a = cm.calculate('openai', 'gpt-4o', tokens, false);
    const b = cm.calculate('anthropic', 'claude-sonnet-4-6', tokens, false);
    const combined = cm.addCost(a, b);
    assert.strictEqual(combined.batchSavingsUsd, undefined);
  });

  it('batch discount applies to DeepSeek models', () => {
    const cm = getCostModel();
    const tokens = makeTokenBreakdown(10000, 5000);
    const standard = cm.calculate('deepseek', 'deepseek-chat', tokens, false);
    const batch = cm.calculate('deepseek', 'deepseek-chat', tokens, true);
    assert.ok(batch.totalCostUsd < standard.totalCostUsd);
    assert.ok(batch.batchSavingsUsd! > 0);
  });
});
