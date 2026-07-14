import { describe, it, expect, beforeEach } from 'vitest';
import {
  AdaptiveStoppingController,
  BetaBinomialTracker,
  DEFAULT_CONFIG,
  ksTest,
  answersToNumeric,
  type DebateRound,
} from '../../../../src/plugins/builtin/consensus/adaptiveStopping';

describe('adaptiveStopping', () => {
  describe('BetaBinomialTracker', () => {
    it('starts with uniform prior novelty probability', () => {
      const tracker = new BetaBinomialTracker();
      expect(tracker.noveltyProbability).toBe(0.5);
      expect(tracker.distinctCount).toBe(0);
    });

    it('updates alpha when a new distinct answer is recorded', () => {
      const tracker = new BetaBinomialTracker();
      expect(tracker.recordRound(['A'])).toBe(true);
      expect(tracker.noveltyProbability).toBe(2 / 3);
      expect(tracker.distinctCount).toBe(1);
    });

    it('updates beta when only seen answers are recorded', () => {
      const tracker = new BetaBinomialTracker();
      tracker.recordRound(['A']);
      expect(tracker.recordRound(['A'])).toBe(false);
      expect(tracker.noveltyProbability).toBe(2 / 4); // alpha=2 beta=2
      expect(tracker.distinctCount).toBe(1);
    });

    it('detects novelty when at least one answer is new', () => {
      const tracker = new BetaBinomialTracker();
      tracker.recordRound(['A']);
      expect(tracker.recordRound(['A', 'B'])).toBe(true);
      expect(tracker.distinctCount).toBe(2);
    });

    it('normalizes answers before deduplication', () => {
      const tracker = new BetaBinomialTracker();
      tracker.recordRound(['  Hello, World!  ']);
      expect(tracker.recordRound(['hello world'])).toBe(false);
      expect(tracker.distinctCount).toBe(1);
    });

    it('caps hashed answer length', () => {
      const tracker = new BetaBinomialTracker();
      const long = 'a'.repeat(2000);
      tracker.recordRound([long]);
      expect(tracker.distinctCount).toBe(1);
    });

    it('resets to a fresh prior', () => {
      const tracker = new BetaBinomialTracker({ alpha: 2, beta: 3 });
      tracker.recordRound(['A']);
      tracker.reset();
      expect(tracker.noveltyProbability).toBe(0.5);
      expect(tracker.distinctCount).toBe(0);
      tracker.reset({ alpha: 3, beta: 7 });
      expect(tracker.noveltyProbability).toBeCloseTo(0.3);
    });
  });

  describe('ksTest', () => {
    it('returns D=1 and pValue=0 for empty samples', () => {
      expect(ksTest([], [1, 2])).toEqual({ D: 1, pValue: 0 });
      expect(ksTest([1, 2], [])).toEqual({ D: 1, pValue: 0 });
    });

    it('returns D=0 and clamped p-value for identical distributions', () => {
      const s1 = [1, 2, 3, 4, 5];
      const s2 = [1, 2, 3, 4, 5];
      const result = ksTest(s1, s2);
      expect(result.D).toBe(0);
      expect(result.pValue).toBe(0);
    });

    it('returns D=1 and p-value near 0 for different distributions', () => {
      const s1 = [1, 2, 3, 4, 5];
      const s2 = [10, 11, 12, 13, 14];
      const result = ksTest(s1, s2);
      expect(result.D).toBe(1);
      expect(result.pValue).toBeLessThan(0.01);
    });

    it('computes intermediate D for overlapping samples', () => {
      const s1 = [1, 2, 3, 4, 5];
      const s2 = [3, 4, 5, 6, 7];
      const result = ksTest(s1, s2);
      expect(result.D).toBeGreaterThan(0);
      expect(result.D).toBeLessThan(1);
      expect(result.pValue).toBeGreaterThan(0);
      expect(result.pValue).toBeLessThanOrEqual(1);
    });
  });

  describe('answersToNumeric', () => {
    it('converts answer strings to numeric fingerprints', () => {
      const nums = answersToNumeric(['A', 'B', 'A']);
      expect(nums).toHaveLength(3);
      expect(typeof nums[0]).toBe('number');
      expect(nums[0]).toBe(nums[2]);
      expect(nums[0]).not.toBe(nums[1]);
    });

    it('normalizes case and whitespace before hashing', () => {
      const nums = answersToNumeric(['Hello World', 'hello  world']);
      expect(nums[0]).toBe(nums[1]);
    });
  });

  describe('AdaptiveStoppingController', () => {
    let controller: AdaptiveStoppingController;

    beforeEach(() => {
      controller = new AdaptiveStoppingController();
    });

    it('uses DEFAULT_CONFIG when no config is provided', () => {
      expect(controller.getConfig()).toEqual(DEFAULT_CONFIG);
    });

    it('merges partial config with defaults', () => {
      const ctrl = new AdaptiveStoppingController({ maxRounds: 5, noveltyThreshold: 0.1 });
      expect(ctrl.getConfig().maxRounds).toBe(5);
      expect(ctrl.getConfig().noveltyThreshold).toBe(0.1);
      expect(ctrl.getConfig().minRounds).toBe(DEFAULT_CONFIG.minRounds);
    });

    it('does not stop before minRounds', () => {
      const result = controller.recordRound({
        roundNumber: 1,
        answers: ['A'],
        tokenCost: 100,
      });
      expect(result.shouldStop).toBe(false);
      expect(result.reason).toContain('Minimum rounds not yet reached');
      expect(result.estimatedTokenSavings).toBe(0);
    });

    it('stops at maxRounds', () => {
      controller = new AdaptiveStoppingController({ maxRounds: 2, minRounds: 1 });
      controller.recordRound({ roundNumber: 1, answers: ['A'], tokenCost: 100 });
      const result = controller.recordRound({ roundNumber: 2, answers: ['B'], tokenCost: 100 });
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain('Maximum rounds reached');
      expect(result.estimatedTokenSavings).toBe(0);
    });

    it('stops when token budget is exhausted', () => {
      controller = new AdaptiveStoppingController({ maxTokens: 250, minRounds: 1 });
      controller.recordRound({ roundNumber: 1, answers: ['A'], tokenCost: 100 });
      const result = controller.recordRound({ roundNumber: 2, answers: ['B'], tokenCost: 150 });
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain('Token budget exhausted');
    });

    it('stops when both signals agree (requireBothSignals=true)', () => {
      controller = new AdaptiveStoppingController({
        minRounds: 2,
        noveltyThreshold: 0.5,
        ksAlpha: 0.5,
        requireBothSignals: true,
      });
      // Build a small answer universe then produce similar consecutive distributions
      controller.recordRound({ roundNumber: 1, answers: Array(10).fill('A'), tokenCost: 100 });
      controller.recordRound({
        roundNumber: 2,
        answers: [...Array(9).fill('A'), 'B'],
        tokenCost: 100,
      });
      // Now novelty should be saturated, and consecutive rounds differ only slightly
      controller.recordRound({
        roundNumber: 3,
        answers: [...Array(9).fill('A'), 'B'],
        tokenCost: 100,
      });
      controller.recordRound({
        roundNumber: 4,
        answers: [...Array(8).fill('A'), ...Array(2).fill('B')],
        tokenCost: 100,
      });
      const result = controller.recordRound({
        roundNumber: 5,
        answers: [...Array(7).fill('A'), ...Array(3).fill('B')],
        tokenCost: 100,
      });
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain('Both signals agree');
    });

    it('stops on novelty alone when requireBothSignals=false', () => {
      controller = new AdaptiveStoppingController({
        minRounds: 2,
        noveltyThreshold: 0.5,
        requireBothSignals: false,
      });
      controller.recordRound({ roundNumber: 1, answers: ['A'], tokenCost: 100 });
      controller.recordRound({ roundNumber: 2, answers: ['A'], tokenCost: 100 });
      const result = controller.recordRound({ roundNumber: 3, answers: ['A'], tokenCost: 100 });
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain('Novelty saturated');
    });

    it('stops on KS convergence when novelty is not saturated and requireBothSignals=false', () => {
      controller = new AdaptiveStoppingController({
        minRounds: 2,
        noveltyThreshold: 0.01,
        ksAlpha: 0.5,
        requireBothSignals: false,
      });
      controller.recordRound({ roundNumber: 1, answers: Array(10).fill('A'), tokenCost: 100 });
      // Slightly different but statistically similar distributions
      const result = controller.recordRound({
        roundNumber: 2,
        answers: [...Array(9).fill('A'), 'B'],
        tokenCost: 100,
      });
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain('Distributions converged');
    });

    it('does not stop when only one signal agrees and requireBothSignals=true', () => {
      controller = new AdaptiveStoppingController({
        minRounds: 2,
        noveltyThreshold: 0.5,
        ksAlpha: 0.01,
        requireBothSignals: true,
      });
      controller.recordRound({ roundNumber: 1, answers: ['A'], tokenCost: 100 });
      const result = controller.recordRound({ roundNumber: 2, answers: ['A'], tokenCost: 100 });
      expect(result.shouldStop).toBe(false);
    });

    it('tracks total tokens spent and round summary', () => {
      controller = new AdaptiveStoppingController({ maxRounds: 3, minRounds: 1 });
      controller.recordRound({ roundNumber: 1, answers: ['A'], tokenCost: 100 });
      controller.recordRound({ roundNumber: 2, answers: ['B'], tokenCost: 200 });
      const summary = controller.getSummary();
      expect(summary.totalRounds).toBe(2);
      expect(summary.totalTokensSpent).toBe(300);
      expect(summary.distinctAnswers).toBe(2);
      expect(summary.avgTokensPerRound).toBe(150);
      expect(summary.rounds).toHaveLength(2);
    });

    it('resets internal state', () => {
      controller.recordRound({ roundNumber: 1, answers: ['A'], tokenCost: 100 });
      controller.reset();
      const summary = controller.getSummary();
      expect(summary.totalRounds).toBe(0);
      expect(summary.totalTokensSpent).toBe(0);
      expect(summary.distinctAnswers).toBe(0);
    });

    it('reports novelty probability and ks p-value in result', () => {
      controller = new AdaptiveStoppingController({ minRounds: 2 });
      controller.recordRound({ roundNumber: 1, answers: Array(10).fill('A'), tokenCost: 100 });
      const result = controller.recordRound({
        roundNumber: 2,
        answers: [...Array(9).fill('A'), 'B'],
        tokenCost: 100,
      });
      expect(result.noveltyProbability).toBeLessThan(1);
      expect(result.ksPValue).toBeGreaterThan(0);
      expect(result.currentRound).toBe(2);
      expect(result.maxRounds).toBe(DEFAULT_CONFIG.maxRounds);
    });

    it('handles repeated identical answers to drive novelty probability down', () => {
      controller = new AdaptiveStoppingController({ minRounds: 2, noveltyThreshold: 0.1 });
      for (let i = 1; i <= 20; i++) {
        controller.recordRound({ roundNumber: i, answers: ['same'], tokenCost: 10 });
      }
      const summary = controller.getSummary();
      expect(summary.noveltyProbability).toBeLessThan(0.1);
    });
  });
});
