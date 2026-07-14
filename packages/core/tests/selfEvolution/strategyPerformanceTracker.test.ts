import { describe, it, expect } from 'vitest';
import { StrategyPerformanceTracker } from '../../src/selfEvolution/strategyPerformanceTracker';
import type { ExecutionExperience } from '../../src/runtime/types';

function makeExperience(
  strategy: string,
  success: boolean,
  durationMs: number,
  tokenCost: number,
  taskType = 'benchmark',
  modelUsed = 'model-a',
): ExecutionExperience {
  return {
    id: `exp-${strategy}-${durationMs}`,
    runId: 'run-1',
    agentId: 'agent-1',
    taskType,
    modelUsed,
    strategyUsed: strategy,
    success,
    durationMs,
    tokenCost,
    lessons: [],
    timestamp: new Date().toISOString(),
  };
}

describe('StrategyPerformanceTracker', () => {
  it('records experiences and exposes aggregated strategy performance', () => {
    const tracker = new StrategyPerformanceTracker();
    tracker.recordExperience(makeExperience('FAST', true, 100, 10));
    tracker.recordExperience(makeExperience('FAST', false, 120, 12));
    tracker.recordExperience(makeExperience('SLOW', true, 1000, 100));

    const perf = tracker.getStrategyPerformance();
    expect(perf.size).toBe(2);
    expect(perf.get('FAST')?.totalRuns).toBe(2);
    expect(perf.get('FAST')?.successRate).toBe(0.5);
    expect(perf.get('SLOW')?.successRate).toBe(1);
  });

  it('sets strategy performance explicitly', () => {
    const tracker = new StrategyPerformanceTracker();
    const perf = new Map([
      [
        'A',
        {
          strategyName: 'A',
          totalRuns: 5,
          successCount: 5,
          avgDurationMs: 10,
          p95DurationMs: 12,
          avgTokenCost: 2,
          successRate: 1,
          lastUsed: new Date().toISOString(),
          bestForTaskTypes: [],
        },
      ],
    ]);
    tracker.setStrategyPerformance(perf);
    expect(tracker.getStrategyPerformance().get('A')?.totalRuns).toBe(5);
  });

  it('recommends the best strategy using composite ranking', () => {
    const tracker = new StrategyPerformanceTracker();
    // Populate enough samples so speed/cost normalization participates.
    for (let i = 0; i < 5; i++) {
      tracker.recordExperience(makeExperience('CHEAP_FAST', true, 50, 5));
      tracker.recordExperience(makeExperience('EXPENSIVE_SLOW', true, 2000, 500));
    }
    const best = tracker.recommendBestStrategy();
    expect(best).toBe('CHEAP_FAST');
  });

  it('analyzes model performance across experiences', () => {
    const tracker = new StrategyPerformanceTracker();
    tracker.recordExperience(makeExperience('A', true, 100, 10, 'task-1', 'model-a'));
    tracker.recordExperience(makeExperience('B', false, 200, 20, 'task-1', 'model-a'));
    tracker.recordExperience(makeExperience('C', true, 300, 30, 'task-1', 'model-b'));

    const analysis = tracker.analyzeModelPerformance();
    const modelA = analysis.get('model-a');
    expect(modelA).toBeDefined();
    expect(modelA!.totalRuns).toBe(2);
    expect(modelA!.successRate).toBe(0.5);
    expect(modelA!.avgTokens).toBe(15);

    const modelB = analysis.get('model-b');
    expect(modelB?.totalRuns).toBe(1);
    expect(modelB?.successRate).toBe(1);
    expect(modelB?.avgTokens).toBe(30);
  });

  it('returns sensible defaults when no data exists', () => {
    const tracker = new StrategyPerformanceTracker();
    expect(tracker.recommendBestStrategy()).toBe('SEQUENTIAL');
    expect(tracker.rankStrategies()).toEqual([]);
    expect(tracker.analyzeModelPerformance().size).toBe(0);
  });

  it('uses neutral speed/cost scores with insufficient samples', () => {
    const tracker = new StrategyPerformanceTracker();
    tracker.recordExperience(makeExperience('ONCE', true, 100, 10));
    const ranked = tracker.rankStrategies();
    expect(ranked.length).toBe(1);
    // Composite score still derives from success rate when normalization cannot run.
    expect(ranked[0]!.successRate).toBe(1);
  });
});
