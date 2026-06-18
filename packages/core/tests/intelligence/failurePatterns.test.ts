/**
 * Smoke tests for the failure pattern learner.
 *
 * Verifies that the FailurePatternLearner can record error
 * signatures, identify recurring patterns, and surface
 * learned patterns for the runtime to act on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { FailurePatternLearner } from '../../src/intelligence/failurePatterns';

describe('FailurePatternLearner', () => {
  it('exports a class and a singleton accessor', async () => {
    assert.strictEqual(typeof FailurePatternLearner, 'function');
    const mod = await import('../../src/intelligence/failurePatterns');
    assert.strictEqual(typeof mod.getFailurePatternLearner, 'function');
    const instance = mod.getFailurePatternLearner();
    assert.ok(instance instanceof FailurePatternLearner);
  });

  it('recordFailure and getPatterns produce a non-empty pattern set after multiple failures', async () => {
    const { getFailurePatternLearner } = await import('../../src/intelligence/failurePatterns');
    const learner = getFailurePatternLearner();
    for (let i = 0; i < 3; i++) {
      learner.recordFailure({
        task: 'echo',
        error: 'Timed out after 30s',
        context: 'running echo tool',
      });
    }
    const patterns = learner.getPatterns();
    assert.ok(Array.isArray(patterns));
    assert.ok(patterns.length > 0, 'expected at least one pattern after 3 identical failures');
  });
});
