import { describe, it, expect, beforeEach } from 'vitest';
import {
  MetaLearner,
  resetMetaLearner,
  getMetaLearner,
  clearMetaLearnerState,
} from '../../src/selfEvolution/metaLearner';
import type { ExecutionExperience } from '../../src/runtime/types';

let learner: MetaLearner;

function makeExp(overrides?: Partial<ExecutionExperience>): ExecutionExperience {
  return {
    id: `exp-${Date.now()}`,
    runId: 'run-1',
    agentId: 'agent-builder',
    taskType: 'code_generation',
    modelUsed: 'claude-3-5-sonnet',
    strategyUsed: 'SEQUENTIAL',
    success: true,
    durationMs: 5000,
    tokenCost: 15000,
    lessons: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('MetaLearner', () => {
  beforeEach(() => {
    resetMetaLearner();
    learner = new MetaLearner(100, 2, undefined, { minRunsBeforeLearning: 0 });
  });

  it('records experiences', () => {
    learner.recordExperience(makeExp());
    const stats = learner.getStats();
    expect(stats.totalExperiences).toBe(1);
  });

  it('tracks strategy performance', () => {
    learner.recordExperience(makeExp({ strategyUsed: 'PARALLEL', success: true }));
    learner.recordExperience(makeExp({ strategyUsed: 'PARALLEL', success: true }));
    const perf = learner.getStrategyPerformance();
    const parallel = perf.get('PARALLEL');
    expect(parallel).toBeDefined();
    expect(parallel!.totalRuns).toBe(2);
    expect(parallel!.successRate).toBe(1);
  });

  it('calculates average success rate', () => {
    learner.recordExperience(makeExp({ strategyUsed: 'A', success: true }));
    learner.recordExperience(makeExp({ strategyUsed: 'A', success: false }));
    learner.recordExperience(makeExp({ strategyUsed: 'B', success: true }));
    const stats = learner.getStats();
    expect(stats.totalExperiences).toBe(3);
    expect(stats.trackedStrategies).toBe(2);
  });

  it('tracks task types per strategy', () => {
    learner.recordExperience(
      makeExp({
        strategyUsed: 'PARALLEL',
        taskType: 'code_generation',
      }),
    );
    learner.recordExperience(
      makeExp({
        strategyUsed: 'PARALLEL',
        taskType: 'data_analysis',
      }),
    );
    const perf = learner.getStrategyPerformance();
    const parallel = perf.get('PARALLEL')!;
    expect(parallel.bestForTaskTypes).toContain('code_generation');
    expect(parallel.bestForTaskTypes).toContain('data_analysis');
  });

  it('returns suggestions after sufficient samples', () => {
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(
        makeExp({
          modelUsed: 'claude-3-5-haiku',
          strategyUsed: 'SEQUENTIAL',
          success: false,
          tokenCost: 20000,
        }),
      );
    }
    const suggestions = learner.getSuggestions();
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].type).toBe('model_tier_change');
  });

  it('does not return suggestions with insufficient data', () => {
    const suggestions = learner.getSuggestions();
    expect(suggestions.length).toBe(0);
  });

  it('tracks strategy ranking top performers', () => {
    for (let i = 0; i < 3; i++) {
      learner.recordExperience(
        makeExp({ strategyUsed: 'PARALLEL', success: true, tokenCost: 5000 }),
      );
    }
    learner.recordExperience(
      makeExp({ strategyUsed: 'SEQUENTIAL', success: false, tokenCost: 5000 }),
    );
    const stats = learner.getStats();
    expect(stats.topStrategies.length).toBeGreaterThan(0);
    expect(stats.topStrategies[0].strategyName).toBe('PARALLEL');
  });

  it('filters experiences by task type', () => {
    learner.recordExperience(makeExp({ taskType: 'code', id: '1' }));
    learner.recordExperience(makeExp({ taskType: 'design', id: '2' }));
    const codeExps = learner.getExperiences('code');
    expect(codeExps.length).toBe(1);
    expect(codeExps[0].taskType).toBe('code');
  });

  it('enforces maximum experience count', () => {
    const small = new MetaLearner(3, 1);
    for (let i = 0; i < 5; i++) {
      small.recordExperience(makeExp({ id: `exp-${i}` }));
    }
    expect(small.getStats().totalExperiences).toBe(3);
  });

  it('updates running averages', () => {
    learner.recordExperience(
      makeExp({
        strategyUsed: 'PARALLEL',
        durationMs: 2000,
        tokenCost: 10000,
      }),
    );
    learner.recordExperience(
      makeExp({
        strategyUsed: 'PARALLEL',
        durationMs: 4000,
        tokenCost: 20000,
      }),
    );
    const perf = learner.getStrategyPerformance();
    const parallel = perf.get('PARALLEL')!;
    expect(parallel.avgDurationMs).toBe(3000);
    expect(parallel.avgTokenCost).toBe(15000);
  });
});

describe('MetaLearner — configuration', () => {
  beforeEach(() => {
    resetMetaLearner();
  });

  it('disabled learning falls back to SEQUENTIAL', () => {
    const disabled = new MetaLearner(100, 2, undefined, {
      enabled: false,
      minRunsBeforeLearning: 0,
    });
    for (let i = 0; i < 5; i++) {
      disabled.recordExperience(
        makeExp({ strategyUsed: 'PARALLEL', success: true, modelUsed: 'gpt-4' }),
      );
    }
    expect(disabled.selectStrategy('code_generation', 'gpt-4')).toBe('SEQUENTIAL');
  });

  it('reflection frequency controls reflection count', () => {
    const reflective = new MetaLearner(100, 2, undefined, {
      minRunsBeforeLearning: 0,
      reflectionFrequency: 5,
    });
    for (let i = 0; i < 4; i++) {
      reflective.recordExperience(
        makeExp({ strategyUsed: 'PARALLEL', success: true, modelUsed: 'gpt-4' }),
      );
    }
    expect(reflective.getReflections().length).toBe(0);
    reflective.recordExperience(
      makeExp({ strategyUsed: 'PARALLEL', success: true, modelUsed: 'gpt-4' }),
    );
    expect(reflective.getReflections().length).toBe(1);
  });

  it('crossModel config returns combined performance', () => {
    const cross = new MetaLearner(100, 2, undefined, {
      minRunsBeforeLearning: 0,
      enableCrossModelMemory: true,
    });
    cross.recordExperience(
      makeExp({ modelUsed: 'gpt-4', strategyUsed: 'PARALLEL', success: true }),
    );
    cross.recordExperience(
      makeExp({ modelUsed: 'claude-3-5-sonnet', strategyUsed: 'PARALLEL', success: true }),
    );
    const perf = cross.getStrategyPerformance();
    expect(perf.get('PARALLEL')!.totalRuns).toBe(2);
  });

  it('predictionLoop config enables predictions', () => {
    const pred = new MetaLearner(100, 2, undefined, {
      minRunsBeforeLearning: 0,
      enablePredictionLoop: true,
    });
    pred.createPrediction('edit-1', 'description', 'PARALLEL', 'SEQUENTIAL', 'gpt-4', [
      'code_generation',
    ]);
    expect(pred.getPredictions().length).toBeGreaterThan(0);
  });

  it('regressionGate config enables regression tracking', () => {
    const reg = new MetaLearner(100, 2, undefined, {
      minRunsBeforeLearning: 0,
      enableRegressionGate: true,
      regressionThreshold: 0.15,
    });
    for (let i = 0; i < 10; i++) {
      reg.recordExperience(makeExp({ strategyUsed: 'PARALLEL', success: true, durationMs: 1000 }));
    }
    for (let i = 0; i < 5; i++) {
      reg.recordExperience(makeExp({ strategyUsed: 'PARALLEL', success: false, durationMs: 5000 }));
    }
    expect(reg.getRegressionEvents().length).toBeGreaterThan(0);
  });

  it('getConfig returns current options', () => {
    const cfg = new MetaLearner(100, 2, undefined, { minRunsBeforeLearning: 5 });
    expect(cfg.getConfig().minRunsBeforeLearning).toBe(5);
  });

  it('setConfig updates options', () => {
    learner.setConfig({ minRunsBeforeLearning: 10 });
    expect(learner.getConfig().minRunsBeforeLearning).toBe(10);
  });
});

describe('MetaLearner — strategy selection', () => {
  beforeEach(() => {
    resetMetaLearner();
    learner = new MetaLearner(100, 2, undefined, { minRunsBeforeLearning: 0 });
  });

  it('falls back to SEQUENTIAL when not enough runs', () => {
    const few = new MetaLearner(100, 2, undefined, { minRunsBeforeLearning: 5 });
    few.recordExperience(makeExp({ strategyUsed: 'PARALLEL', success: true }));
    expect(few.selectStrategy('code_generation')).toBe('SEQUENTIAL');
  });

  it('selects best strategy', () => {
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(
        makeExp({ strategyUsed: 'PARALLEL', success: true, tokenCost: 1000 }),
      );
    }
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(
        makeExp({ strategyUsed: 'SEQUENTIAL', success: false, tokenCost: 10000 }),
      );
    }
    const choice = learner.selectStrategy('code_generation');
    expect(choice).toBe('PARALLEL');
  });

  it('getStrategyScores returns ranked strategies', () => {
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(
        makeExp({ strategyUsed: 'PARALLEL', success: true, tokenCost: 1000 }),
      );
    }
    const scores = learner.getStrategyScores('code_generation');
    expect(scores.length).toBeGreaterThan(0);
    expect(scores[0].strategy).toBe('PARALLEL');
    expect(scores[0].score).toBeGreaterThan(0);
  });

  it('getStrategyScoresForModel returns array', () => {
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(
        makeExp({ modelUsed: 'gpt-4', strategyUsed: 'PARALLEL', success: true }),
      );
    }
    const scores = learner.getStrategyScoresForModel('gpt-4');
    expect(Array.isArray(scores)).toBe(true);
    expect(scores.length).toBeGreaterThan(0);
  });

  it('getPerModelStats aggregates by model', () => {
    learner.recordExperience(
      makeExp({ modelUsed: 'gpt-4', strategyUsed: 'PARALLEL', success: true }),
    );
    learner.recordExperience(
      makeExp({ modelUsed: 'claude-3-5-sonnet', strategyUsed: 'PARALLEL', success: true }),
    );
    const stats = learner.getPerModelStats();
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBe(2);
  });

  it('getTrackedTaskTypes returns unique task types', () => {
    learner.recordExperience(makeExp({ taskType: 'code_generation' }));
    learner.recordExperience(makeExp({ taskType: 'data_analysis' }));
    learner.recordExperience(makeExp({ taskType: 'code_generation' }));
    const types = learner.getTrackedTaskTypes();
    expect(types).toContain('code_generation');
    expect(types).toContain('data_analysis');
    expect(types.length).toBe(2);
  });

  it('calculateAdjustedScores returns array', () => {
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(
        makeExp({ strategyUsed: 'PARALLEL', success: true, tokenCost: 1000 }),
      );
    }
    const adjusted = learner.calculateAdjustedScores('code_generation');
    expect(Array.isArray(adjusted)).toBe(true);
    expect(adjusted.length).toBeGreaterThan(0);
    expect(adjusted[0].name).toBe('PARALLEL');
  });
});

describe('MetaLearner — predictions & verdicts', () => {
  beforeEach(() => {
    resetMetaLearner();
    learner = new MetaLearner(100, 2, undefined, {
      minRunsBeforeLearning: 0,
      enablePredictionLoop: true,
    });
  });

  it('creates a prediction manually', () => {
    learner.createPrediction('edit-1', 'description', 'PARALLEL', 'SEQUENTIAL', 'gpt-4', [
      'code_generation',
    ]);
    const preds = learner.getPredictions();
    expect(preds.length).toBe(1);
    expect(preds[0].targetStrategy).toBe('PARALLEL');
  });

  it('returns verdicts from predictions', () => {
    // Train PARALLEL as the preferred strategy so selectStrategy predicts it
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(
        makeExp({
          modelUsed: 'gpt-4',
          strategyUsed: 'PARALLEL',
          success: true,
          taskType: 'code_generation',
        }),
      );
    }
    // selectStrategy records PARALLEL as the predicted strategy for this (model, task)
    learner.selectStrategy('code_generation', 'gpt-4');
    // Create a prediction that targetStrategy will be SEQUENTIAL
    learner.createPrediction('edit-1', 'description', 'SEQUENTIAL', 'PARALLEL', 'gpt-4', [
      'code_generation',
    ]);
    // Actual experience uses SEQUENTIAL, different from prediction -> verdict generated
    learner.recordExperience(
      makeExp({
        modelUsed: 'gpt-4',
        strategyUsed: 'SEQUENTIAL',
        success: true,
        taskType: 'code_generation',
      }),
    );
    const verdicts = learner.getVerdicts();
    expect(verdicts.length).toBeGreaterThan(0);
  });

  it('convergence metrics reflect learning state', () => {
    for (let i = 0; i < 12; i++) {
      learner.recordExperience(
        makeExp({ strategyUsed: 'PARALLEL', success: true, tokenCost: 1000 }),
      );
    }
    const metrics = learner.getConvergenceMetrics();
    expect(metrics.taskTypes).toBeGreaterThan(0);
    expect(metrics.avgSamplesPerStrategy).toBeGreaterThan(0);
  });
});

describe('MetaLearner — singleton & state', () => {
  beforeEach(() => {
    resetMetaLearner();
  });

  it('getMetaLearner returns the same instance', () => {
    const a = getMetaLearner();
    const b = getMetaLearner();
    expect(a).toBe(b);
  });

  it('resetMetaLearner creates a new instance', () => {
    const a = getMetaLearner();
    resetMetaLearner();
    const b = getMetaLearner();
    expect(a).not.toBe(b);
  });

  it('clearMetaLearnerState resets internal state', () => {
    clearMetaLearnerState();
    const ml = getMetaLearner();
    ml.recordExperience(makeExp());
    expect(ml.getStats().totalExperiences).toBe(1);
    clearMetaLearnerState();
    expect(ml.getStats().totalExperiences).toBe(0);
  });
});
