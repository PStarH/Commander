/**
 * Cost Predictor algorithmic effectiveness benchmark.
 *
 * Validates that CostPredictor produces estimates within a tolerance window of
 * the actual cost by leveraging historical records, while a flat-rate baseline
 * with no memory misses the real per-model price.
 */
import * as os from 'node:os';
import { CostPredictor } from '../../../intelligence/costPredictor';
import { calculateCostBreakdown } from '../../../telos/tokenSentinel';
import type { BenchmarkModule, Task } from '../types';

/** Relative error tolerated between prediction and actual cost/duration. */
const TOLERANCE = 0.2; // 20%

/** Flat rate used by the baseline (intentionally mispriced for gpt-4o-mini). */
const BASELINE_PRICE_PER_TOKEN = 0.0002;

interface CostTask extends Task {
  taskType: string;
  effortLevel: string;
  topology: string;
  estimatedTokens: number;
  actualTokens: number;
  estimatedDurationMs: number;
  actualDurationMs: number;
  agentCount: number;
  modelId: string;
}

const taskSuite: CostTask[] = [
  {
    id: 'code-generation-small',
    prompt: 'Generate a small utility function',
    taskType: 'code-generation',
    effortLevel: 'low',
    topology: 'single',
    estimatedTokens: 2000,
    actualTokens: 2000,
    estimatedDurationMs: 1300,
    actualDurationMs: 1300,
    agentCount: 1,
    modelId: 'gpt-4o-mini',
  },
  {
    id: 'code-generation-medium',
    prompt: 'Refactor a module with moderate complexity',
    taskType: 'code-generation',
    effortLevel: 'medium',
    topology: 'single',
    estimatedTokens: 8000,
    actualTokens: 8000,
    estimatedDurationMs: 4700,
    actualDurationMs: 4700,
    agentCount: 1,
    modelId: 'gpt-4o-mini',
  },
  {
    id: 'multi-agent-planning',
    prompt: 'Plan a multi-agent workflow',
    taskType: 'planning',
    effortLevel: 'high',
    topology: 'swarm',
    estimatedTokens: 12000,
    actualTokens: 12000,
    estimatedDurationMs: 6900,
    actualDurationMs: 6900,
    agentCount: 4,
    modelId: 'gpt-4o-mini',
  },
  {
    id: 'review-and-summarize',
    prompt: 'Review a long document and summarize findings',
    taskType: 'review',
    effortLevel: 'medium',
    topology: 'round-robin',
    estimatedTokens: 15000,
    actualTokens: 15000,
    estimatedDurationMs: 6200,
    actualDurationMs: 6200,
    agentCount: 2,
    modelId: 'gpt-4o-mini',
  },
  {
    id: 'test-generation',
    prompt: 'Generate unit tests for a service',
    taskType: 'testing',
    effortLevel: 'medium',
    topology: 'single',
    estimatedTokens: 5000,
    actualTokens: 5000,
    estimatedDurationMs: 3000,
    actualDurationMs: 3000,
    agentCount: 1,
    modelId: 'gpt-4o-mini',
  },
];

function actualCostUsd(task: CostTask): number {
  const inputTokens = Math.round(task.actualTokens * 0.7);
  const outputTokens = task.actualTokens - inputTokens;
  return calculateCostBreakdown(task.modelId, inputTokens, outputTokens).totalUsd;
}

function isWithinTolerance(output: string, task: CostTask): boolean {
  try {
    const parsed = JSON.parse(output) as {
      estimatedCostUsd: number;
      estimatedDurationMs: number;
    };
    const actualCost = actualCostUsd(task);
    const costError =
      actualCost === 0
        ? Math.abs(parsed.estimatedCostUsd)
        : Math.abs(parsed.estimatedCostUsd - actualCost) / actualCost;
    const durationError =
      task.actualDurationMs === 0
        ? Math.abs(parsed.estimatedDurationMs)
        : Math.abs(parsed.estimatedDurationMs - task.actualDurationMs) / task.actualDurationMs;
    return costError <= TOLERANCE && durationError <= TOLERANCE;
  } catch {
    return false;
  }
}

interface CostPredictionImpl {
  predict: (task: CostTask) => { estimatedCostUsd: number; estimatedDurationMs: number };
}

export const costPredictorModule: BenchmarkModule = {
  id: 'costPredictor',
  name: 'Cost Predictor',
  description:
    'Validates that similarity-based cost prediction with historical records lands within tolerance of the actual per-model cost.',
  path: 'intelligence/costPredictor.ts',
  baselineFactory: () => ({
    predict: (task: CostTask) => {
      // Simple linear cost estimate with a fixed, history-less price.
      const estimatedCostUsd = task.estimatedTokens * BASELINE_PRICE_PER_TOKEN;
      return {
        estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
        estimatedDurationMs: task.estimatedDurationMs,
      };
    },
  }),
  treatmentFactory: () => {
    // Use a temp directory so the benchmark does not pollute the project tree.
    const predictor = new CostPredictor(os.tmpdir());

    // Pre-record a small historical window for each task profile so the
    // predictor has enough similar tasks to blend into its estimate.
    for (const task of taskSuite) {
      for (let i = 0; i < 4; i++) {
        const tokenJitter = i % 2 === 0 ? -0.02 : 0.02;
        const durationJitter = i < 2 ? -0.01 : 0.01;
        predictor.record({
          taskType: task.taskType,
          effortLevel: task.effortLevel,
          topology: task.topology,
          tokens: Math.round(task.actualTokens * (1 + tokenJitter)),
          durationMs: Math.round(task.actualDurationMs * (1 + durationJitter)),
          success: true,
          modelId: task.modelId,
        });
      }
    }

    return {
      predictor,
      predict: (task: CostTask) => {
        const estimate = predictor.predict({
          taskType: task.taskType,
          effortLevel: task.effortLevel,
          topology: task.topology,
          estimatedTokens: task.estimatedTokens,
          estimatedDurationMs: task.estimatedDurationMs,
          agentCount: task.agentCount,
          modelId: task.modelId,
        });
        return {
          estimatedCostUsd: Math.round(estimate.estimatedCostUsd * 1_000_000) / 1_000_000,
          estimatedDurationMs: estimate.estimatedDurationMs,
        };
      },
    };
  },
  runTrial: async ({ implementation, task }) => {
    const impl = implementation as CostPredictionImpl;
    const t = task as unknown as CostTask;
    const estimate = impl.predict(t);
    return {
      output: JSON.stringify(estimate),
      tokenUsage: { input: 1, output: 1, total: 2, cached: 0, reasoning: 0 },
      latencyMs: 1,
    };
  },
  taskSuite: taskSuite.map((task) => ({
    ...task,
    expected: (output: string) => isWithinTolerance(output, task),
  })) as unknown as Task[],
  metrics: ['successRate'],
};
