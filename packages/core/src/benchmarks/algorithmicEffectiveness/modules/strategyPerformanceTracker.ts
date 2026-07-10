import { StrategyPerformanceTracker } from '../../../selfEvolution/strategyPerformanceTracker';
import type { ExecutionExperience } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

interface StrategyProfile {
  successRate: number;
  durationMs: number;
  tokenCost: number;
}

interface TaskScenario {
  taskId: string;
  prompt: string;
  /** Strategy that maximises the hidden utility (success + speed + cost). */
  optimalStrategy: string;
  strategies: Record<string, StrategyProfile>;
}

const EXPERIENCES_PER_STRATEGY = 20;

/**
 * Synthetic task suite where the highest-success strategy is slow and expensive.
 * A composite ranker (success 70% + speed 15% + cost 15%) should prefer the
 * faster/cheaper alternative, while a success-rate-only baseline should not.
 */
const scenarios: TaskScenario[] = [
  {
    taskId: 'data-parsing',
    prompt: 'Select the best strategy for parsing structured data',
    optimalStrategy: 'FAST_CHEAP',
    strategies: {
      FAST_CHEAP: { successRate: 0.8, durationMs: 50, tokenCost: 10 },
      SLOW_ACCURATE: { successRate: 0.85, durationMs: 1000, tokenCost: 1000 },
    },
  },
  {
    taskId: 'code-generation',
    prompt: 'Select the best strategy for generating code',
    optimalStrategy: 'QUICK_DRAFT',
    strategies: {
      QUICK_DRAFT: { successRate: 0.7, durationMs: 100, tokenCost: 50 },
      CAREFUL_REFACTOR: { successRate: 0.75, durationMs: 2000, tokenCost: 2000 },
    },
  },
  {
    taskId: 'review',
    prompt: 'Select the best strategy for reviewing output',
    optimalStrategy: 'PARALLEL_REVIEW',
    strategies: {
      PARALLEL_REVIEW: { successRate: 0.6, durationMs: 80, tokenCost: 30 },
      EXPERT_REVIEW: { successRate: 0.65, durationMs: 1200, tokenCost: 600 },
    },
  },
  {
    taskId: 'debug',
    prompt: 'Select the best strategy for debugging failures',
    optimalStrategy: 'TARGETED_DEBUG',
    strategies: {
      TARGETED_DEBUG: { successRate: 0.9, durationMs: 150, tokenCost: 100 },
      EXHAUSTIVE_DEBUG: { successRate: 0.95, durationMs: 3000, tokenCost: 2500 },
    },
  },
];

const taskSuite: Task[] = scenarios.map((scenario) => ({
  id: scenario.taskId,
  prompt: scenario.prompt,
  expected: (output: string) => output === scenario.optimalStrategy,
}));

function makeExperience(
  taskId: string,
  strategy: string,
  success: boolean,
  profile: StrategyProfile,
  index: number,
): ExecutionExperience {
  return {
    id: `exp-${taskId}-${strategy}-${index}`,
    runId: 'benchmark',
    agentId: 'benchmark-agent',
    taskType: taskId,
    modelUsed: 'benchmark-model',
    strategyUsed: strategy,
    success,
    durationMs: profile.durationMs,
    tokenCost: profile.tokenCost,
    lessons: [],
    timestamp: new Date().toISOString(),
  };
}

function preTrainTracker(
  tracker: { recordExperience(exp: ExecutionExperience): void },
  strategies: Record<string, StrategyProfile>,
  taskId: string,
): void {
  for (const [strategy, profile] of Object.entries(strategies)) {
    const successCount = Math.round(EXPERIENCES_PER_STRATEGY * profile.successRate);
    for (let i = 0; i < EXPERIENCES_PER_STRATEGY; i++) {
      tracker.recordExperience(
        makeExperience(taskId, strategy, i < successCount, profile, i),
      );
    }
  }
}

/** Baseline: ranks strategies by empirical success rate only. */
class SuccessRateOnlyTracker {
  private tracker = new StrategyPerformanceTracker();

  recordExperience(exp: ExecutionExperience): void {
    this.tracker.recordExperience(exp);
  }

  recommendBestStrategy(): string {
    const ranked = Array.from(this.tracker.getStrategyPerformance().values()).sort(
      (a, b) => b.successRate - a.successRate,
    );
    return ranked[0]?.strategyName ?? 'SEQUENTIAL';
  }
}

function createTrackers<T>(
  factory: () => T,
): Map<string, T> {
  const trackers = new Map<string, T>();
  for (const scenario of scenarios) {
    const tracker = factory();
    preTrainTracker(tracker, scenario.strategies, scenario.taskId);
    trackers.set(scenario.taskId, tracker);
  }
  return trackers;
}

export const strategyPerformanceTrackerModule: BenchmarkModule = {
  id: 'strategyPerformanceTracker',
  name: 'Strategy Performance Tracker',
  description:
    'Validates that composite ranking (success 70% + speed 15% + cost 15%) recommends better strategies than success-rate-only ranking when speed and cost break ties.',
  path: 'selfEvolution/strategyPerformanceTracker.ts',
  baselineFactory: () => ({
    trackers: createTrackers(() => new SuccessRateOnlyTracker()),
    recommend(taskId: string) {
      return this.trackers.get(taskId)?.recommendBestStrategy() ?? 'SEQUENTIAL';
    },
  }),
  treatmentFactory: () => ({
    trackers: createTrackers(() => new StrategyPerformanceTracker()),
    recommend(taskId: string) {
      return this.trackers.get(taskId)?.recommendBestStrategy() ?? 'SEQUENTIAL';
    },
  }),
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      recommend: (taskId: string) => string;
    };
    const output = impl.recommend(task.id);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
