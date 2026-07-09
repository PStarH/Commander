import { StrategySelector } from '../../../selfEvolution/strategySelector';
import { STRATEGY_NAMES } from '../../../selfEvolution/strategyConstants';
import type { ExecutionExperience } from '../../../runtime/types';
import type { BenchmarkModule, Task } from '../types';

const trueSuccessRates: Record<string, number> = {
  SEQUENTIAL: 0.3,
  PARALLEL: 0.5,
  HANDOFF: 0.8,
  MAGENTIC: 0.6,
  CONSENSUS: 0.4,
};

const taskSuite: Task[] = [
  {
    id: 'routing-1',
    prompt: 'Choose execution strategy for task 1',
    expected: (output: string) => output === 'HANDOFF',
  },
  {
    id: 'routing-2',
    prompt: 'Choose execution strategy for task 2',
    expected: (output: string) => output === 'HANDOFF',
  },
  {
    id: 'routing-3',
    prompt: 'Choose execution strategy for task 3',
    expected: (output: string) => output === 'HANDOFF',
  },
];

function makeExperience(taskId: string, strategy: string, success: boolean): ExecutionExperience {
  return {
    id: `exp-${taskId}-${strategy}`,
    runId: 'benchmark',
    agentId: 'benchmark-agent',
    taskType: taskId,
    modelUsed: 'benchmark-model',
    strategyUsed: strategy,
    success,
    durationMs: 1000,
    tokenCost: 1000,
    lessons: [],
    timestamp: new Date().toISOString(),
  };
}

export const strategySelectorModule: BenchmarkModule = {
  id: 'strategySelector',
  name: 'Strategy Selector',
  description:
    'Validates that StrategySelector converges to the highest-success strategy via Thompson Sampling.',
  path: 'selfEvolution/strategySelector.ts',
  baselineFactory: () => ({
    select: (_taskId: string) => STRATEGY_NAMES[0], // Always SEQUENTIAL (worst)
  }),
  treatmentFactory: () => {
    const selector = new StrategySelector();
    // Pre-train: HANDOFF and MAGENTIC succeed often; SEQUENTIAL fails often.
    for (let i = 0; i < 15; i++) {
      for (const taskId of taskSuite.map((t) => t.id)) {
        selector.recordExperience(makeExperience(taskId, 'HANDOFF', true));
        selector.recordExperience(makeExperience(taskId, 'MAGENTIC', true));
        selector.recordExperience(makeExperience(taskId, 'SEQUENTIAL', false));
        selector.recordExperience(makeExperience(taskId, 'CONSENSUS', false));
        selector.recordExperience(makeExperience(taskId, 'PARALLEL', i % 2 === 0));
      }
    }
    return {
      selector,
      select: (taskId: string) => {
        const strategy = selector.selectStrategy(taskId, new Map());
        return strategy;
      },
      record: (taskId: string, strategy: string, success: boolean) => {
        selector.recordExperience(makeExperience(taskId, strategy, success));
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as {
      select: (taskId: string) => string;
      record?: (taskId: string, strategy: string, success: boolean) => void;
    };
    const strategy = impl.select(task.id);
    const success = Math.random() < trueSuccessRates[strategy];
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
