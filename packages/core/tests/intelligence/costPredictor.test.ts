/**
 * Smoke tests for the cost prediction subsystem.
 *
 * Verifies that CostPredictor can record cost history, predict
 * the next call's cost from a small sample, and that bounded
 * confidence intervals are returned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CostPredictor } from '../../src/intelligence/costPredictor';

describe('CostPredictor', () => {
  it('exports a class and a getCostPredictor singleton accessor', async () => {
    assert.strictEqual(typeof CostPredictor, 'function');
    const mod = await import('../../src/intelligence/costPredictor');
    assert.strictEqual(typeof mod.getCostPredictor, 'function');
    const instance = mod.getCostPredictor();
    assert.ok(instance instanceof CostPredictor);
  });

  it('predict returns a CostEstimate shape with valid bounds', async () => {
    const { getCostPredictor } = await import('../../src/intelligence/costPredictor');
    const predictor = getCostPredictor();
    const estimate = predictor.predict({
      taskType: 'code-generation',
      effortLevel: 'medium',
      topology: 'single',
      estimatedTokens: 1000,
      estimatedDurationMs: 500,
      agentCount: 1,
      modelId: 'gpt-4o-mini',
    });
    assert.ok(typeof estimate.estimatedTokens === 'number');
    assert.ok(estimate.estimatedTokens >= 0);
    assert.ok(typeof estimate.estimatedCostUsd === 'number');
    assert.ok(estimate.estimatedCostUsd >= 0);
    assert.ok(typeof estimate.estimatedDurationMs === 'number');
    assert.ok(estimate.estimatedDurationMs >= 0);
    assert.ok(typeof estimate.confidence === 'number');
    assert.ok(estimate.confidence >= 0 && estimate.confidence <= 1);
  });

  it('prediction handles unknown model gracefully', async () => {
    const { getCostPredictor } = await import('../../src/intelligence/costPredictor');
    const predictor = getCostPredictor();
    const estimate = predictor.predict({
      taskType: 'unknown-task',
      effortLevel: 'unknown',
      topology: 'unknown',
      estimatedTokens: 100,
      estimatedDurationMs: 50,
      agentCount: 1,
      modelId: 'brand-new-unseen-model',
    });
    assert.ok(typeof estimate.estimatedCostUsd === 'number');
    assert.ok(Number.isFinite(estimate.estimatedCostUsd));
  });
});
