import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareShadowDecision } from './comparison.js';

describe('shadow decision comparison', () => {
  it('implements the complete production/hypothetical decision matrix', () => {
    const comparable = ['allow', 'deny', 'require_approval'] as const;
    for (const production of comparable) {
      for (const hypothetical of comparable) {
        assert.equal(
          compareShadowDecision(production, hypothetical),
          production === hypothetical ? 'match' : 'mismatch',
        );
      }
      assert.equal(compareShadowDecision(production, 'insufficient_evidence'), 'uncomparable');
    }
    for (const hypothetical of [...comparable, 'insufficient_evidence'] as const) {
      assert.equal(compareShadowDecision('unknown', hypothetical), 'uncomparable');
    }
  });
});
