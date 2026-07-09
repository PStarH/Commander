import { getCostModel } from '../../observability/costModel';
import { evaluateComparison, evaluateTrialSuccess } from './evaluator';
import type { BenchmarkModule, ComparisonOptions, ComparisonResult, LLMClient, Task, TokenUsage } from './types';

function estimateCost(tokens: TokenUsage): number {
  const costModel = getCostModel();
  const breakdown = costModel.calculate('unknown', 'unknown', {
    input: tokens.input,
    output: tokens.output,
    cached: tokens.cached,
    reasoning: tokens.reasoning,
    total: tokens.total,
  });
  return breakdown.totalCostUsd;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export async function runComparison(
  options: ComparisonOptions,
  module: BenchmarkModule,
  createLLM: (mode: 'baseline' | 'treatment') => LLMClient,
): Promise<ComparisonResult> {
  const { mode, n = 30, seed = Date.now() } = options;
  const rng = seededRandom(seed);

  const baselineLLM = createLLM('baseline');
  const treatmentLLM = createLLM('treatment');

  const baselineImpl = module.baselineFactory({ llm: baselineLLM });
  const treatmentImpl = module.treatmentFactory({ llm: treatmentLLM });

  const baselineSuccess: number[] = [];
  const treatmentSuccess: number[] = [];
  const baselineCosts: number[] = [];
  const treatmentCosts: number[] = [];
  const baselineLatencies: number[] = [];
  const treatmentLatencies: number[] = [];
  const errors: ComparisonResult['errors'] = [];

  for (let i = 0; i < n; i++) {
    const shuffled = shuffle(module.taskSuite, rng);

    for (const task of shuffled) {
      // Baseline
      try {
        const start = Date.now();
        const { output, tokenUsage, latencyMs } = await module.runTrial({
          implementation: baselineImpl,
          task,
          llm: baselineLLM,
        });
        const success = await evaluateTrialSuccess(output, task, baselineLLM);
        baselineSuccess.push(success ? 1 : 0);
        baselineCosts.push(estimateCost(tokenUsage));
        baselineLatencies.push(latencyMs ?? Date.now() - start);
      } catch (err) {
        baselineSuccess.push(0);
        baselineCosts.push(0);
        baselineLatencies.push(0);
        errors.push({ side: 'baseline', taskId: task.id, message: (err as Error).message });
      }

      // Treatment
      try {
        const start = Date.now();
        const { output, tokenUsage, latencyMs } = await module.runTrial({
          implementation: treatmentImpl,
          task,
          llm: treatmentLLM,
        });
        const success = await evaluateTrialSuccess(output, task, treatmentLLM);
        treatmentSuccess.push(success ? 1 : 0);
        treatmentCosts.push(estimateCost(tokenUsage));
        treatmentLatencies.push(latencyMs ?? Date.now() - start);
      } catch (err) {
        treatmentSuccess.push(0);
        treatmentCosts.push(0);
        treatmentLatencies.push(0);
        errors.push({ side: 'treatment', taskId: task.id, message: (err as Error).message });
      }
    }
  }

  return evaluateComparison({
    moduleId: module.id,
    mode,
    n: baselineSuccess.length,
    baseline: baselineSuccess,
    treatment: treatmentSuccess,
    baselineCosts,
    treatmentCosts,
    baselineLatencies,
    treatmentLatencies,
    errors,
  });
}
