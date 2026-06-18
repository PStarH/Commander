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

  it('analyze returns an ImpactAnalysis with correct fields', async () => {
    const { getImpactAnalyzer } = await import('../../src/intelligence/impactAnalyzer');
    const analyzer = getImpactAnalyzer();
    const result = await analyzer.analyze('module:auth');
    assert.ok(typeof result === 'object' && result !== null);
    assert.strictEqual(result.targetFile, 'module:auth');
    assert.ok(Array.isArray(result.directDependencies));
    assert.ok(Array.isArray(result.indirectDependencies));
    assert.ok(Array.isArray(result.affectedTests));
    assert.ok(Array.isArray(result.affectedApis));
    assert.ok(['low', 'medium', 'high', 'critical'].includes(result.riskLevel));
    assert.ok(typeof result.summary === 'string');
  });
});
