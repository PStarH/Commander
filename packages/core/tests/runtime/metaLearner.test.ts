import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { MetaLearner, resetMetaLearner } from '../../src/selfEvolution/metaLearner';
import type { ExecutionExperience } from '../../src/runtime/types';

describe('MetaLearner', () => {
  let learner: MetaLearner;

  before(() => {
    resetMetaLearner();
    learner = new MetaLearner(100, 2);
  });

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
    learner.recordExperience(makeExp({
      strategyUsed: 'PARALLEL',
      taskType: 'code_generation',
    }));
    learner.recordExperience(makeExp({
      strategyUsed: 'PARALLEL',
      taskType: 'data_analysis',
    }));
    const perf = learner.getStrategyPerformance();
    const parallel = perf.get('PARALLEL')!;
    expect(parallel.bestForTaskTypes).toContain('code_generation');
    expect(parallel.bestForTaskTypes).toContain('data_analysis');
  });

  it('returns suggestions after sufficient samples', () => {
    for (let i = 0; i < 5; i++) {
      learner.recordExperience(makeExp({
        modelUsed: 'claude-3-5-haiku',
        strategyUsed: 'SEQUENTIAL',
        success: false,
        tokenCost: 20000,
      }));
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
      learner.recordExperience(makeExp({ strategyUsed: 'PARALLEL', success: true, tokenCost: 5000 }));
    }
    learner.recordExperience(makeExp({ strategyUsed: 'SEQUENTIAL', success: false, tokenCost: 5000 }));
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
    learner.recordExperience(makeExp({
      strategyUsed: 'PARALLEL',
      durationMs: 2000,
      tokenCost: 10000,
    }));
    learner.recordExperience(makeExp({
      strategyUsed: 'PARALLEL',
      durationMs: 4000,
      tokenCost: 20000,
    }));
    const perf = learner.getStrategyPerformance();
    const parallel = perf.get('PARALLEL')!;
    expect(parallel.avgDurationMs).toBe(3000);
    expect(parallel.avgTokenCost).toBe(15000);
  });
});
