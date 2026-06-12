/**
 * Smoke tests for the static impact analyzer.
 *
 * ImpactAnalyzer walks a dependency graph and reports the
 * blast radius of changing a given node.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ImpactAnalyzer } from '../../src/intelligence/impactAnalyzer';

describe('ImpactAnalyzer', () => {
  it('exports a class and a singleton accessor', async () => {
    assert.strictEqual(typeof ImpactAnalyzer, 'function');
    const mod = await import('../../src/intelligence/impactAnalyzer');
    assert.strictEqual(typeof mod.getImpactAnalyzer, 'function');
    const instance = mod.getImpactAnalyzer();
    assert.ok(instance instanceof ImpactAnalyzer);
  });

  it('analyze returns an ImpactAnalysis with a non-negative affected count', async () => {
    const { getImpactAnalyzer } = await import('../../src/intelligence/impactAnalyzer');
    const analyzer = getImpactAnalyzer();
    const result = analyzer.analyze({
      target: 'module:auth',
      changeType: 'refactor',
      maxDepth: 3,
    });
    assert.ok(typeof result === 'object' && result !== null);
    assert.ok(typeof result.affectedCount === 'number');
    assert.ok(result.affectedCount >= 0);
    assert.ok(Array.isArray(result.affected));
  });
});
