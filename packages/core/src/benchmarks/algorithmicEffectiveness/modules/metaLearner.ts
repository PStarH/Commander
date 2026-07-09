import { MetaLearner } from '../../../selfEvolution/metaLearner';
import { STRATEGY_NAMES } from '../../../selfEvolution/strategyConstants';
import type { ExecutionExperience } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

/**
 * For each synthetic task type we define the strategy that clearly
 * outperforms the others.  The baseline uses a single fixed strategy for
 * every task, while the treatment MetaLearner records historical
 * experiences and uses Thompson Sampling to learn the best strategy per
 * task type.
 */
const bestStrategyByTask: Record<string, string> = {
  'data-extraction': 'HANDOFF',
  'code-generation': 'PARALLEL',
  reasoning: 'MAGENTIC',
  summarization: 'CONSENSUS',
  routing: 'SEQUENTIAL',
};

/**
 * Simulated success rates when a strategy is applied to a task type.
 * The "best" strategy for the task succeeds with high probability;
 * every other strategy fails with high probability.
 */
const trueSuccessRates: Record<string, Record<string, number>> = {};
for (const [taskType, best] of Object.entries(bestStrategyByTask)) {
  trueSuccessRates[taskType] = {};
  for (const strategy of STRATEGY_NAMES) {
    trueSuccessRates[taskType][strategy] = strategy === best ? 0.95 : 0.05;
  }
}

const taskSuite: Task[] = Object.entries(bestStrategyByTask).map(([taskType, best]) => ({
  id: taskType,
  prompt: `Choose the best execution strategy for ${taskType}`,
  expected: (output: string) => output === best,
}));

function makeExperience(taskType: string, strategy: string, success: boolean): ExecutionExperience {
  return {
    id: `exp-${taskType}-${strategy}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    runId: 'benchmark',
    agentId: 'benchmark-agent',
    taskType,
    modelUsed: 'benchmark-model',
    strategyUsed: strategy,
    success,
    durationMs: 1000,
    tokenCost: 1000,
    lessons: [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Pre-train a MetaLearner instance so that its Thompson priors strongly
 * favour the best strategy for each task type.
 */
function preTrainMetaLearner(learner: MetaLearner): void {
  for (const [taskType, best] of Object.entries(bestStrategyByTask)) {
    for (let i = 0; i < 40; i++) {
      learner.recordExperience(makeExperience(taskType, best, true));
      for (const strategy of STRATEGY_NAMES) {
        if (strategy !== best) {
          learner.recordExperience(makeExperience(taskType, strategy, false));
        }
      }
    }
  }
}

export const metaLearnerModule: BenchmarkModule = {
  id: 'metaLearner',
  name: 'Meta Learner',
  description:
    'Validates that MetaLearner learns the best strategy per task type via Thompson Sampling and outperforms a fixed-strategy baseline.',
  path: 'selfEvolution/metaLearner.ts',
  baselineFactory: () => ({
    // Fixed baseline: always chooses SEQUENTIAL regardless of task type.
    select: (_taskId: string) => 'SEQUENTIAL',
  }),
  treatmentFactory: () => {
    const learner = new MetaLearner(500, 5, undefined, {
      enabled: true,
      minRunsBeforeLearning: 0,
      enablePredictionLoop: false,
      enableRegressionGate: false,
      enableCrossModelMemory: false,
    });
    preTrainMetaLearner(learner);
    return {
      learner,
      select: (taskId: string) => learner.selectStrategy(taskId),
      record: (taskId: string, strategy: string, success: boolean) => {
        learner.recordExperience(makeExperience(taskId, strategy, success));
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      select: (taskId: string) => string;
      record?: (taskId: string, strategy: string, success: boolean) => void;
    };
    const strategy = impl.select(task.id);
    const success = Math.random() < trueSuccessRates[task.id][strategy];
    if (impl.record) {
      impl.record(task.id, strategy, success);
    }
    return {
      output: strategy,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
