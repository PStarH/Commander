import { PredictionLoop } from '../../../selfEvolution/predictionLoop';
import type { ExecutionExperience, FailureCategory } from '../../../runtime/types/selfEvolution';
import type { BenchmarkModule, Task } from '../types';

interface StrategyChangeTask extends Task {
  editId: string;
  description: string;
  sourceStrategy: string;
  targetStrategy: string;
  modelId: string;
  taskType: string;
  predictedFixes: FailureCategory[];
  predictedRegressions: FailureCategory[];
  actualSuccess: boolean;
}

const taskSuite: StrategyChangeTask[] = [
  {
    id: 'predicted-fix-confirmed',
    prompt: 'Apply a strategy change that is predicted to fix tool misuse and actually succeeds.',
    editId: 'fix-tool-misuse',
    description: 'Switch to a more deterministic tool-calling strategy.',
    sourceStrategy: 'default-tool-calling',
    targetStrategy: 'deterministic-tool-calling',
    modelId: 'scripted-model',
    taskType: 'code-generation',
    predictedFixes: ['tool_misuse'],
    predictedRegressions: [],
    actualSuccess: true,
    expected: (output: string) => output.includes('FIX_CONFIRMED:yes'),
  },
  {
    id: 'predicted-regression-observed',
    prompt: 'Apply a strategy change that is predicted to cause a timeout regression and actually fails.',
    editId: 'regress-timeout',
    description: 'Use a cheaper but slower reasoning strategy.',
    sourceStrategy: 'fast-reasoning',
    targetStrategy: 'cheap-reasoning',
    modelId: 'scripted-model',
    taskType: 'planning',
    predictedFixes: [],
    predictedRegressions: ['timeout'],
    actualSuccess: false,
    expected: (output: string) => output.includes('REGRESSION_OBSERVED:yes'),
  },
  {
    id: 'predicted-fix-confirmed-with-watched-regression',
    prompt: 'Apply a strategy change predicted to fix missing capability; it succeeds so no regression is observed.',
    editId: 'fix-missing-capability',
    description: 'Add a retrieval step to compensate for missing knowledge.',
    sourceStrategy: 'plain-generation',
    targetStrategy: 'retrieval-augmented-generation',
    modelId: 'scripted-model',
    taskType: 'knowledge-qa',
    predictedFixes: ['missing_capability'],
    predictedRegressions: ['hallucination'],
    actualSuccess: true,
    expected: (output: string) => output.includes('FIX_CONFIRMED:yes'),
  },
  {
    id: 'predicted-regression-avoided',
    prompt: 'Apply a strategy change predicted to risk planning regression but it actually succeeds.',
    editId: 'avoid-planning-regression',
    description: 'Switch to a parallel planning strategy.',
    sourceStrategy: 'sequential-planning',
    targetStrategy: 'parallel-planning',
    modelId: 'scripted-model',
    taskType: 'planning',
    predictedFixes: [],
    predictedRegressions: ['planning_error'],
    actualSuccess: true,
    expected: (output: string) => output.includes('NET_IMPACT:positive'),
  },
  {
    id: 'predicted-fix-not-confirmed',
    prompt: 'Apply a strategy change predicted to fix data validation but it actually fails.',
    editId: 'miss-data-validation',
    description: 'Tighten output schema validation.',
    sourceStrategy: 'loose-validation',
    targetStrategy: 'strict-validation',
    modelId: 'scripted-model',
    taskType: 'code-generation',
    predictedFixes: ['data_validation'],
    predictedRegressions: [],
    actualSuccess: false,
    expected: (output: string) => output.includes('NET_IMPACT:negative'),
  },
];

interface StrategyChangeImplementation {
  applyStrategyChange: (task: StrategyChangeTask) => string;
}

function createExperience(task: StrategyChangeTask): ExecutionExperience {
  return {
    id: `exp_${task.editId}`,
    runId: `run_${task.editId}`,
    agentId: 'benchmark-agent',
    taskType: task.taskType,
    modelUsed: task.modelId,
    strategyUsed: task.targetStrategy,
    success: task.actualSuccess,
    durationMs: 1,
    tokenCost: 1,
    lessons: [],
    timestamp: new Date().toISOString(),
  };
}

function renderVerdictOutput(
  task: StrategyChangeTask,
  verdict: { fixesConfirmed: string[]; regressionsObserved: string[]; netImpact: string },
): string {
  return [
    `changed from ${task.sourceStrategy} to ${task.targetStrategy}`,
    `FIX_CONFIRMED:${verdict.fixesConfirmed.length > 0 ? 'yes' : 'no'}`,
    `REGRESSION_OBSERVED:${verdict.regressionsObserved.length > 0 ? 'yes' : 'no'}`,
    `NET_IMPACT:${verdict.netImpact}`,
  ].join('; ');
}

export const predictionLoopModule: BenchmarkModule = {
  id: 'predictionLoop',
  name: 'Prediction Loop',
  description:
    'Validates that the PredictionLoop turns pre-change predictions into falsifiable verdicts, while a baseline that skips prediction provides no signal.',
  path: 'selfEvolution/predictionLoop.ts',
  baselineFactory: () => ({
    applyStrategyChange: (task: StrategyChangeTask) =>
      `applied ${task.targetStrategy}; no prediction signal`,
  }),
  treatmentFactory: () => {
    const loop = new PredictionLoop();
    return {
      loop,
      applyStrategyChange: (task: StrategyChangeTask) => {
        // Reset predictions so each trial matches exactly one prediction.
        loop.setPredictions([]);

        const key = `${task.modelId}::${task.taskType}`;
        loop.setLastPredictedStrategy(new Map([[key, task.sourceStrategy]]));

        const prediction = loop.createPrediction(
          task.editId,
          task.description,
          task.targetStrategy,
          task.sourceStrategy,
          task.modelId,
          [task.taskType],
          task.predictedFixes,
          task.predictedRegressions,
        );

        loop.recordExperience(createExperience(task));

        const verdict =
          loop.getVerdicts().find((v) => v.predictionId === prediction.id) ?? {
            fixesConfirmed: [],
            regressionsObserved: [],
            netImpact: task.actualSuccess ? 'positive' : 'negative',
          };

        return renderVerdictOutput(task, verdict);
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as StrategyChangeImplementation;
    const output = impl.applyStrategyChange(task as StrategyChangeTask);
    return {
      output,
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite,
  metrics: ['successRate'],
};
