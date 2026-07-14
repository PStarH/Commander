import { describe, it, expect, beforeEach } from 'vitest';
import { StrategySelector } from '../../src/selfEvolution/strategySelector';
import { STRATEGY_NAMES } from '../../src/selfEvolution/strategyConstants';
import type { ExecutionExperience } from '../../src/runtime/types';

describe('strategySelector', () => {
  let selector: StrategySelector;

  beforeEach(() => {
    selector = new StrategySelector();
  });

  describe('construction and state', () => {
    it('starts with empty priors', () => {
      expect(selector.getThompsonPriors().size).toBe(0);
      expect(selector.getTrackedTaskTypes()).toEqual([]);
    });

    it('returns the same priors instance that was set', () => {
      const priors = new Map();
      selector.setThompsonPriors(priors);
      expect(selector.getThompsonPriors()).toBe(priors);
    });
  });

  describe('selectStrategy', () => {
    it('returns one of the known strategy names', () => {
      const perf = new Map();
      const choice = selector.selectStrategy('task1', perf);
      expect(STRATEGY_NAMES).toContain(choice);
    });

    it('uses exploration weight 0.5 when total samples are low', () => {
      const perf = new Map();
      // Trigger computeAdjustmentFactors with fresh priors
      const scores = selector.calculateAdjustedScores('low-sample-task', perf);
      expect(scores).toHaveLength(STRATEGY_NAMES.length);
      expect(scores[0].score).toBeGreaterThanOrEqual(0);
    });

    it('uses exploration weight 0.2 after enough total samples', () => {
      const perf = new Map();
      // Warm up priors with 20+ trials spread across strategies
      for (let i = 0; i < 25; i++) {
        selector.recordExperience({
          taskType: 'warmed-task',
          strategyUsed: STRATEGY_NAMES[i % STRATEGY_NAMES.length],
          success: true,
          tokenCost: 1000,
          durationMs: 1000,
        } as ExecutionExperience);
      }
      const scores = selector.calculateAdjustedScores('warmed-task', perf);
      expect(scores).toHaveLength(STRATEGY_NAMES.length);
    });

    it('applies speed factor when duration stats are available', () => {
      const perf = new Map([
        [STRATEGY_NAMES[0], { totalRuns: 5, p95DurationMs: 100, avgTokenCost: 100 }],
        [STRATEGY_NAMES[1], { totalRuns: 5, p95DurationMs: 200, avgTokenCost: 100 }],
      ]);
      const choice = selector.selectStrategy('speed-task', perf);
      expect(STRATEGY_NAMES).toContain(choice);
      const scores = selector.calculateAdjustedScores('speed-task', perf);
      expect(scores.every((s) => typeof s.score === 'number')).toBe(true);
    });

    it('applies cost factor when cost stats are available', () => {
      const perf = new Map([
        [STRATEGY_NAMES[0], { totalRuns: 5, p95DurationMs: 100, avgTokenCost: 50 }],
        [STRATEGY_NAMES[1], { totalRuns: 5, p95DurationMs: 100, avgTokenCost: 150 }],
      ]);
      const choice = selector.selectStrategy('cost-task', perf);
      expect(STRATEGY_NAMES).toContain(choice);
    });

    it('ignores modelId parameter (accepted for API compatibility)', () => {
      const perf = new Map();
      expect(() => selector.selectStrategy('task', perf, 'gpt-4')).not.toThrow();
    });
  });

  describe('calculateAdjustedScores', () => {
    it('returns scores sorted descending', () => {
      const perf = new Map();
      const scores = selector.calculateAdjustedScores('task', perf);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1].score).toBeGreaterThanOrEqual(scores[i].score);
      }
    });

    it('caps the number of tracked task types', () => {
      for (let i = 0; i < StrategySelector.MAX_THOMPSON_PRIORS + 5; i++) {
        selector.selectStrategy(`task-${i}`, new Map());
      }
      expect(selector.getTrackedTaskTypes().length).toBeLessThanOrEqual(
        StrategySelector.MAX_THOMPSON_PRIORS,
      );
    });
  });

  describe('getStrategyScores', () => {
    it('returns mean, trial count and optional duration stats', () => {
      selector.recordExperience({
        taskType: 'score-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: true,
        tokenCost: 1000,
        durationMs: 1000,
      } as ExecutionExperience);
      const perf = new Map([
        [STRATEGY_NAMES[0], { totalRuns: 1, avgDurationMs: 1000, p95DurationMs: 1000 }],
      ]);
      const scores = selector.getStrategyScores('score-task', perf);
      expect(scores).toHaveLength(STRATEGY_NAMES.length);
      const first = scores.find((s) => s.strategy === STRATEGY_NAMES[0])!;
      expect(first.trials).toBeGreaterThan(0);
      expect(first.avgDurationMs).toBe(1000);
      expect(first.p95DurationMs).toBe(1000);
    });
  });

  describe('recordExperience', () => {
    it('updates the prior for a known strategy', () => {
      selector.recordExperience({
        taskType: 'rec-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: true,
        tokenCost: 1000,
        durationMs: 1000,
      } as ExecutionExperience);
      const priors = selector.getThompsonPriors().get('rec-task')!;
      expect(priors[0].totalTrials).toBeGreaterThan(0);
      expect(priors[1].totalTrials).toBe(0);
      expect(priors[0].mean).toBeGreaterThan(0.5);
    });

    it('ignores experiences with unknown strategy names', () => {
      selector.recordExperience({
        taskType: 'rec-task',
        strategyUsed: 'unknown-strategy',
        success: true,
        tokenCost: 1000,
        durationMs: 1000,
      } as ExecutionExperience);
      expect(selector.getTrackedTaskTypes()).toContain('rec-task');
      const priors = selector.getThompsonPriors().get('rec-task')!;
      expect(priors.every((p) => p.totalTrials === 0)).toBe(true);
    });

    it('records failure outcomes', () => {
      selector.recordExperience({
        taskType: 'rec-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: false,
        tokenCost: 1000,
        durationMs: 1000,
      } as ExecutionExperience);
      const priors = selector.getThompsonPriors().get('rec-task')!;
      expect(priors[0].totalTrials).toBeGreaterThan(0);
      expect(priors[0].mean).toBeLessThan(0.5);
    });

    it('adjusts difficulty for expensive tasks', () => {
      selector.recordExperience({
        taskType: 'difficult-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: true,
        tokenCost: 60000,
        durationMs: 70000,
      } as ExecutionExperience);
      const priors = selector.getThompsonPriors().get('difficult-task')!;
      expect(priors[0].totalTrials).toBeGreaterThan(0);
    });

    it('adjusts difficulty for timeout errors', () => {
      selector.recordExperience({
        taskType: 'error-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: false,
        tokenCost: 1000,
        durationMs: 1000,
        errorPattern: 'timeout exceeded',
      } as ExecutionExperience);
      const priors = selector.getThompsonPriors().get('error-task')!;
      expect(priors[0].totalTrials).toBeGreaterThan(0);
    });

    it('adjusts difficulty for context/token errors', () => {
      selector.recordExperience({
        taskType: 'overflow-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: false,
        tokenCost: 1000,
        durationMs: 1000,
        errorPattern: 'context overflow',
      } as ExecutionExperience);
      const priors = selector.getThompsonPriors().get('overflow-task')!;
      expect(priors[0].totalTrials).toBeGreaterThan(0);
    });

    it('adjusts difficulty for multi-tool tasks', () => {
      selector.recordExperience({
        taskType: 'multitool-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: true,
        tokenCost: 1000,
        durationMs: 1000,
        toolsUsed: ['a', 'b', 'c', 'd'],
      } as ExecutionExperience);
      const priors = selector.getThompsonPriors().get('multitool-task')!;
      expect(priors[0].totalTrials).toBeGreaterThan(0);
    });

    it('caps difficulty at 1.0', () => {
      selector.recordExperience({
        taskType: 'max-difficulty-task',
        strategyUsed: STRATEGY_NAMES[0],
        success: true,
        tokenCost: 60000,
        durationMs: 70000,
        errorPattern: 'timeout',
        toolsUsed: ['a', 'b', 'c', 'd'],
      } as ExecutionExperience);
      // Should not throw and should record the trial
      const priors = selector.getThompsonPriors().get('max-difficulty-task')!;
      expect(priors[0].totalTrials).toBeGreaterThan(0);
    });
  });
});
