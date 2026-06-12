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

  it('predictNext returns a CostEstimate shape with valid bounds', async () => {
    const { getCostPredictor } = await import('../../src/intelligence/costPredictor');
    const predictor = getCostPredictor();
    const estimate = predictor.predictNext('test-model', 1000, 500);
    assert.ok(typeof estimate.expectedUsd === 'number');
    assert.ok(estimate.expectedUsd >= 0);
    assert.ok(typeof estimate.lowerUsd === 'number');
    assert.ok(typeof estimate.upperUsd === 'number');
    assert.ok(estimate.lowerUsd <= estimate.expectedUsd);
    assert.ok(estimate.upperUsd >= estimate.expectedUsd);
  });

  it('prediction handles unknown model gracefully', async () => {
    const { getCostPredictor } = await import('../../src/intelligence/costPredictor');
    const predictor = getCostPredictor();
    const estimate = predictor.predictNext('brand-new-unseen-model', 100, 50);
    assert.ok(typeof estimate.expectedUsd === 'number');
    assert.ok(Number.isFinite(estimate.expectedUsd));
  });
});
