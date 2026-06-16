import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';
import type { BudgetState, GovernorDecision } from '../../src/runtime/tokenGovernor';

describe('TokenGovernor', () => {
  it('starts in relaxed phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    const state = gov.getState();
    assert.equal(state.phase, 'relaxed');
    assert.equal(state.pressure, 0);
    assert.equal(state.remainingTokens, 10000);
  });

  it('transitions to moderate phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(5000); // 50%
    const state = gov.getState();
    assert.equal(state.phase, 'moderate');
    assert.ok(state.pressure >= 0.4);
  });

  it('transitions to tight phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(7000); // 70%
    const state = gov.getState();
    assert.equal(state.phase, 'tight');
    assert.ok(state.pressure >= 0.65);
  });

  it('transitions to critical phase', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(9000); // 90%
    const state = gov.getState();
    assert.equal(state.phase, 'critical');
    assert.ok(state.pressure >= 0.85);
  });

  it('resets usage', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reportUsage(5000);
    gov.reset();
    const state = gov.getState();
    assert.equal(state.usedTokens, 0);
    assert.equal(state.phase, 'relaxed');
  });

  it('resets with new budget', () => {
    const gov = new TokenGovernor({ totalBudget: 10000 });
    gov.reset(20000);
    const state = gov.getState();
    assert.equal(state.totalBudget, 20000);
  });

  describe('getRecommendations', () => {
    it('returns baseline masking in relaxed phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const recs = gov.getRecommendations();
      assert.ok(recs.length > 0);
      assert.ok(recs.some((r) => r.strategy === 'observation_mask'));
    });

    it('returns more strategies in moderate phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(5000);
      const recs = gov.getRecommendations();
      assert.ok(recs.length > 1);
      assert.ok(recs.some((r) => r.strategy === 'tool_output_truncate'));
    });

    it('returns aggressive strategies in critical phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(9000);
      const recs = gov.getRecommendations();
      assert.ok(recs.some((r) => r.strategy === 'verification_skip'));
      assert.ok(recs.some((r) => r.strategy === 'context_compaction'));
      assert.ok(recs.some((r) => r.strategy === 'speculative_skip'));
    });

    it('caches recommendations within same phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const recs1 = gov.getRecommendations();
      const recs2 = gov.getRecommendations();
      assert.strictEqual(recs1, recs2); // Same reference = cached
    });

    it('invalidates cache on reportUsage', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const recs1 = gov.getRecommendations();
      gov.reportUsage(5000);
      const recs2 = gov.getRecommendations();
      assert.notStrictEqual(recs1, recs2); // Different reference = recomputed
    });
  });

  describe('shouldApply', () => {
    it('returns apply=true for observation_mask in relaxed', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const result = gov.shouldApply('observation_mask');
      assert.equal(result.apply, true);
      assert.ok(result.intensity > 0);
    });

    it('returns apply=false for strategies not in current phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      const result = gov.shouldApply('speculative_skip');
      assert.equal(result.apply, false);
    });
  });

  describe('task type awareness', () => {
    it('boosts response_format for structured tasks', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(5000); // moderate
      gov.setTaskCategory('structured');
      const recs = gov.getRecommendations();
      const rf = recs.find((r) => r.strategy === 'response_format');
      assert.ok(rf);
      assert.ok(rf.intensity > 0.3);
    });

    it('reduces response_format for creative tasks', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(5000); // moderate
      gov.setTaskCategory('creative');
      const recs = gov.getRecommendations();
      const rf = recs.find((r) => r.strategy === 'response_format');
      // Should be reduced or not present for creative tasks
      if (rf) {
        assert.ok(rf.intensity <= 0.3);
      }
    });

    it('reduces verification_skip for code tasks in tight phase', () => {
      const gov = new TokenGovernor({ totalBudget: 10000 });
      gov.reportUsage(7000); // tight
      gov.setTaskCategory('code');
      const recs = gov.getRecommendations();
      const vs = recs.find((r) => r.strategy === 'verification_skip');
      assert.ok(vs);
      // Code tasks should have lower verification skip intensity
      assert.ok(vs.intensity < 0.5);
    });
  });

  describe('learning', () => {
    it('records outcomes', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: true });
      gov.recordOutcome('observation_mask', 1000, 800);
      gov.recordOutcome('observation_mask', 1000, 900);
      gov.recordOutcome('observation_mask', 1000, 700);
      // Should not throw
    });

    it('demotes ineffective strategies', () => {
      const gov = new TokenGovernor({ totalBudget: 10000, enableLearning: true });
      // Record many ineffective outcomes
      for (let i = 0; i < 10; i++) {
        gov.recordOutcome('tool_output_truncate', 1000, 1000); // no savings
      }
      gov.reportUsage(5000); // moderate phase
      const recs = gov.getRecommendations();
      const tot = recs.find((r) => r.strategy === 'tool_output_truncate');
      // Should be demoted
      if (tot) {
        assert.equal(tot.apply, false);
      }
    });
  });

  describe('estimateTokens', () => {
    it('estimates English text', () => {
      const tokens = TokenGovernor.estimateTokens('hello world test');
      assert.ok(tokens > 0 && tokens < 10);
    });

    it('estimates CJK text with higher ratio', () => {
      const en = TokenGovernor.estimateTokens('abcd');
      const zh = TokenGovernor.estimateTokens('你好世界');
      // CJK should produce more tokens per char
      assert.ok(zh > en);
    });
  });
});
