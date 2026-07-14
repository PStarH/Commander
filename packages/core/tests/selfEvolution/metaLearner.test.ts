import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MetaLearner,
  getMetaLearner,
  resetMetaLearner,
  clearMetaLearnerState,
} from '../../src/selfEvolution/metaLearner';
import type { ExecutionExperience, FailureCategory } from '../../src/runtime/types';

function makeExperience(overrides: Partial<ExecutionExperience> = {}): ExecutionExperience {
  return {
    id: `exp-${Math.random().toString(36).slice(2, 8)}`,
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    agentId: 'agent-1',
    taskType: 'code',
    modelUsed: 'gpt-4',
    strategyUsed: 'SEQUENTIAL',
    success: true,
    durationMs: 100,
    tokenCost: 1000,
    lessons: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('MetaLearner', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetMetaLearner();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-learner-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = getMetaLearner(path.join(tmpDir, 'ml.json'));
      const b = getMetaLearner();
      expect(a).toBe(b);
    });

    it('reset creates a fresh instance', () => {
      const a = getMetaLearner(path.join(tmpDir, 'ml.json'));
      resetMetaLearner();
      const b = getMetaLearner(path.join(tmpDir, 'ml.json'));
      expect(a).not.toBe(b);
    });

    it('clearMetaLearnerState resets internal state', () => {
      const ml = getMetaLearner(path.join(tmpDir, 'ml.json'));
      ml.recordExperience(makeExperience());
      clearMetaLearnerState();
      expect(ml.getExperiences().length).toBe(0);
      expect(ml.getReflections().length).toBe(0);
    });
  });

  describe('experience recording', () => {
    it('caps experiences at maxExperiences', () => {
      const ml = new MetaLearner(5, 1, undefined, { enabled: false });
      for (let i = 0; i < 7; i++) ml.recordExperience(makeExperience());
      expect(ml.getExperiences().length).toBe(5);
    });

    it('persists when disabled', async () => {
      const persistPath = path.join(tmpDir, 'disabled.json');
      const ml = new MetaLearner(100, 1, persistPath, { enabled: false });
      ml.recordExperience(makeExperience());
      await (ml as any).persistChain;
      expect(fs.existsSync(persistPath)).toBe(true);
    });

    it('triggers submodules and reflections when enabled', () => {
      const ml = new MetaLearner(100, 1, undefined, {
        enabled: true,
        minRunsBeforeLearning: 2,
        reflectionFrequency: 2,
        enablePredictionLoop: true,
        enableRegressionGate: true,
        enableCrossModelMemory: true,
      });
      for (let i = 0; i < 5; i++) ml.recordExperience(makeExperience());
      expect(ml.getReflections().length).toBeGreaterThan(0);
      expect(ml.getStrategyPerformance().size).toBeGreaterThan(0);
    });
  });

  describe('strategy selection', () => {
    it('returns SEQUENTIAL when disabled', () => {
      const ml = new MetaLearner(100, 1, undefined, { enabled: false });
      expect(ml.selectStrategy('code')).toBe('SEQUENTIAL');
    });

    it('returns SEQUENTIAL before enough runs', () => {
      const ml = new MetaLearner(100, 1, undefined, {
        enabled: true,
        minRunsBeforeLearning: 5,
      });
      expect(ml.selectStrategy('code')).toBe('SEQUENTIAL');
    });

    it('selects a learned strategy after enough runs', () => {
      const ml = new MetaLearner(100, 1, undefined, {
        enabled: true,
        minRunsBeforeLearning: 3,
        enablePredictionLoop: true,
      });
      for (let i = 0; i < 5; i++) ml.recordExperience(makeExperience({ taskType: 'code' }));
      const chosen = ml.selectStrategy('code', 'gpt-4');
      expect(['SEQUENTIAL', 'PARALLEL', 'HANDOFF', 'MAGENTIC', 'CONSENSUS']).toContain(chosen);
    });
  });

  describe('query methods', () => {
    it('returns strategy scores and adjusted scores', () => {
      const ml = new MetaLearner(100, 1, undefined, { enabled: true, minRunsBeforeLearning: 1 });
      ml.recordExperience(makeExperience({ strategyUsed: 'SEQUENTIAL', success: true }));
      expect(ml.getStrategyScores('code').length).toBeGreaterThan(0);
      expect(ml.calculateAdjustedScores('code')[0].name).toBe('SEQUENTIAL');
    });

    it('returns tracked task types', () => {
      const ml = new MetaLearner(100, 1, undefined, { enabled: true, minRunsBeforeLearning: 1 });
      ml.recordExperience(makeExperience({ taskType: 'review' }));
      expect(ml.getTrackedTaskTypes()).toContain('review');
    });

    it('returns model-specific scores', () => {
      const ml = new MetaLearner(100, 1, undefined, { enabled: true, minRunsBeforeLearning: 1 });
      ml.recordExperience(makeExperience({ modelUsed: 'gpt-4' }));
      expect(ml.getStrategyScoresForModel('gpt-4').length).toBeGreaterThan(0);
      expect(ml.getPerModelStats().length).toBeGreaterThan(0);
    });

    it('filters experiences by task type', () => {
      const ml = new MetaLearner(100, 1, undefined, { enabled: false });
      ml.recordExperience(makeExperience({ taskType: 'code' }));
      ml.recordExperience(makeExperience({ taskType: 'review' }));
      expect(ml.getExperiences('code').length).toBe(1);
      expect(ml.getExperiences().length).toBe(2);
    });

    it('returns reflections and shadow comparisons', () => {
      const ml = new MetaLearner(100, 1, undefined, {
        enabled: true,
        minRunsBeforeLearning: 1,
        reflectionFrequency: 1,
      });
      ml.recordExperience(makeExperience());
      expect(ml.getReflections(10).length).toBeGreaterThan(0);
      expect(ml.getShadowComparisons(10)).toEqual([]);
    });
  });

  describe('predictions', () => {
    it('creates predictions and records verdicts', () => {
      const ml = new MetaLearner(100, 1, undefined, {
        enabled: true,
        minRunsBeforeLearning: 1,
        enablePredictionLoop: true,
      });
      ml.createPrediction('edit-1', 'switch to parallel', 'PARALLEL', 'SEQUENTIAL', 'gpt-4', [
        'code',
      ]);
      expect(ml.getPredictions().length).toBe(1);

      ml.recordExperience(
        makeExperience({ modelUsed: 'gpt-4', taskType: 'code', strategyUsed: 'SEQUENTIAL' }),
      );
      ml.selectStrategy('code', 'gpt-4');
      ml.recordExperience(
        makeExperience({ modelUsed: 'gpt-4', taskType: 'code', strategyUsed: 'PARALLEL' }),
      );
      expect(ml.getVerdicts().length).toBe(1);
    });
  });

  describe('regression gate', () => {
    it('detects regressions', () => {
      const ml = new MetaLearner(100, 1, undefined, {
        enabled: true,
        minRunsBeforeLearning: 1,
        enableRegressionGate: true,
      });
      for (let i = 0; i < 5; i++) {
        ml.recordExperience(makeExperience({ strategyUsed: 'PARALLEL', success: true }));
      }
      for (let i = 0; i < 5; i++) {
        ml.recordExperience(makeExperience({ strategyUsed: 'PARALLEL', success: false }));
      }
      const events = ml.getRegressionEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].strategyName).toBe('PARALLEL');
    });
  });

  describe('suggestions', () => {
    it('generates optimization suggestions', () => {
      const ml = new MetaLearner(100, 1, undefined, {
        enabled: true,
        minRunsBeforeLearning: 1,
        enableCrossModelMemory: true,
      });
      // Model-tier suggestion trigger: low success + high token cost
      for (let i = 0; i < 5; i++) {
        ml.recordExperience(
          makeExperience({
            modelUsed: 'cheap-model',
            strategyUsed: 'SEQUENTIAL',
            success: false,
            tokenCost: 20_000,
          }),
        );
      }
      // Strategy-change suggestion trigger: low success for top strategy
      for (let i = 0; i < 3; i++) {
        ml.recordExperience(
          makeExperience({ strategyUsed: 'PARALLEL', success: false, tokenCost: 100 }),
        );
      }
      const suggestions = ml.getSuggestions();
      expect(suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('config', () => {
    it('updates and returns config', () => {
      const ml = new MetaLearner(100, 1, undefined, {});
      ml.setConfig({ enabled: false });
      expect(ml.getConfig().enabled).toBe(false);
    });
  });

  describe('stats and convergence', () => {
    it('returns stats', () => {
      const ml = new MetaLearner(100, 1, undefined, { enabled: true, minRunsBeforeLearning: 3 });
      for (let i = 0; i < 5; i++) ml.recordExperience(makeExperience());
      const stats = ml.getStats();
      expect(stats.totalExperiences).toBe(5);
      expect(stats.learningActive).toBe(true);
      expect(stats.runsUntilLearning).toBe(0);
    });

    it('returns convergence metrics', () => {
      const ml = new MetaLearner(200, 1, undefined, { enabled: true, minRunsBeforeLearning: 1 });
      for (let i = 0; i < 15; i++) {
        ml.recordExperience(makeExperience({ taskType: 'unknown', strategyUsed: 'SEQUENTIAL' }));
      }
      const metrics = ml.getConvergenceMetrics();
      expect(metrics.taskTypes).toBeGreaterThan(0);
      expect(metrics.learningCurve.length).toBeGreaterThan(0);
    });

    it('reports convergence when samples are high and stable', () => {
      const ml = new MetaLearner(200, 1, undefined, { enabled: true, minRunsBeforeLearning: 1 });
      for (let i = 0; i < 55; i++) {
        ml.recordExperience(makeExperience({ taskType: 'unknown', strategyUsed: 'SEQUENTIAL' }));
      }
      const metrics = ml.getConvergenceMetrics();
      expect(metrics.converged).toBe(true);
    });
  });

  describe('persistence roundtrip', () => {
    it('loads previously persisted state', async () => {
      const persistPath = path.join(tmpDir, 'roundtrip.json');
      const ml1 = new MetaLearner(100, 1, persistPath, { enabled: false });
      const exp = makeExperience({ taskType: 'code' });
      ml1.recordExperience(exp);
      await (ml1 as any).persistChain;

      const ml2 = new MetaLearner(100, 1, persistPath, { enabled: false });
      await (ml2 as any).persistChain;
      expect(ml2.getExperiences().some((e) => e.id === exp.id)).toBe(true);
    });
  });
});
