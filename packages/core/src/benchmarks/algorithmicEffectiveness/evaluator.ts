import type { ComparisonResult, Conclusion, LLMClient, MetricKey, MetricSummary, Task, TokenUsage } from './types';

export async function evaluateTrialSuccess(
  output: string,
  task: Task,
  llm: LLMClient,
): Promise<boolean> {
  if (task.expected !== undefined) {
    if (typeof task.expected === 'function') {
      return task.expected(output);
    }
    if (task.expected instanceof RegExp) {
      return task.expected.test(output);
    }
    return output.toLowerCase().includes(String(task.expected).toLowerCase());
  }

  if (task.judge) {
    const score = await task.judge(output, { llm });
    return score >= 6;
  }

  return false;
}

export function summarizeMetric(values: number[]): MetricSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n === 0 ? 0 : sorted.reduce((a, b) => a + b, 0) / n;
  const median = n === 0 ? 0 : n % 2 === 1 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p95 = n === 0 ? 0 : sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)];
  const variance = n === 0 ? 0 : sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return { mean, median, p95, stdDev: Math.sqrt(variance), raw: values };
}

function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * z);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function wilcoxonSignedRankTest(baseline: number[], treatment: number[]): { pValue: number; zScore: number } {
  const diffs = baseline.map((b, i) => treatment[i] - b).filter((d) => d !== 0);
  const n = diffs.length;
  if (n === 0) return { pValue: 1, zScore: 0 };

  const abs = diffs.map((d) => Math.abs(d));
  const sortedAbs = [...abs].sort((a, b) => a - b);

  function rank(value: number): number {
    const indices: number[] = [];
    for (let i = 0; i < sortedAbs.length; i++) {
      if (sortedAbs[i] === value) indices.push(i);
    }
    // average rank is 1-indexed
    return indices.reduce((a, b) => a + b, 0) / indices.length + 1;
  }

  let positiveRank = 0;
  let negativeRank = 0;
  for (let i = 0; i < diffs.length; i++) {
    const r = rank(abs[i]);
    if (diffs[i] > 0) positiveRank += r;
    else negativeRank += r;
  }

  const W = Math.min(positiveRank, negativeRank);
  const expected = (n * (n + 1)) / 4;
  const variance = (n * (n + 1) * (2 * n + 1)) / 24;
  const zScore = n < 10 ? 0 : (W - expected) / Math.sqrt(variance);
  const pValue = n < 10 ? 1 : 2 * (1 - normalCdf(Math.abs(zScore)));

  return { pValue, zScore };
}

export interface EvaluateComparisonInput {
  moduleId: string;
  mode: 'scripted' | 'live';
  n: number;
  baseline: number[]; // success=1, fail=0
  treatment: number[];
  baselineCosts: number[];
  treatmentCosts: number[];
  baselineLatencies: number[];
  treatmentLatencies: number[];
  baselineLlmScores?: number[];
  treatmentLlmScores?: number[];
  errors: { side: 'baseline' | 'treatment'; taskId: string; message: string }[];
}

export function evaluateComparison(input: EvaluateComparisonInput): ComparisonResult {
  const {
    moduleId,
    mode,
    n,
    baseline,
    treatment,
    baselineCosts,
    treatmentCosts,
    baselineLatencies,
    treatmentLatencies,
    baselineLlmScores = [],
    treatmentLlmScores = [],
    errors,
  } = input;

  const baselineSuccessRates = baseline;
  const treatmentSuccessRates = treatment;

  const successTest = wilcoxonSignedRankTest(baselineSuccessRates, treatmentSuccessRates);
  const costTest = wilcoxonSignedRankTest(baselineCosts, treatmentCosts);
  const latencyTest = wilcoxonSignedRankTest(baselineLatencies, treatmentLatencies);
  const scoreTest =
    baselineLlmScores.length > 0
      ? wilcoxonSignedRankTest(baselineLlmScores, treatmentLlmScores)
      : { pValue: 1, zScore: 0 };

  const pValues: Record<MetricKey, number> = {
    successRate: successTest.pValue,
    cost: costTest.pValue,
    latency: latencyTest.pValue,
    llmScore: scoreTest.pValue,
  };

  const effectSizes: Record<MetricKey, number> = {
    successRate: Math.abs(successTest.zScore) / Math.sqrt(n),
    cost: Math.abs(costTest.zScore) / Math.sqrt(n),
    latency: Math.abs(latencyTest.zScore) / Math.sqrt(n),
    llmScore: Math.abs(scoreTest.zScore) / Math.sqrt(n),
  };

  const baselineValid = baseline.filter((v) => v !== undefined).length;
  const treatmentValid = treatment.filter((v) => v !== undefined).length;
  const baselineErrorRate = (n - baselineValid) / n;
  const treatmentErrorRate = (n - treatmentValid) / n;

  let conclusion: Conclusion;
  if (baselineErrorRate > 0.2 || treatmentErrorRate > 0.2) {
    conclusion = 'TEST_UNSTABLE';
  } else {
    const better = (metric: MetricKey) => {
      const meanBaseline = summarizeMetric(getRaw(metric, 'baseline')).mean;
      const meanTreatment = summarizeMetric(getRaw(metric, 'treatment')).mean;
      // For cost and latency, lower is better
      if (metric === 'cost' || metric === 'latency') {
        return meanTreatment < meanBaseline;
      }
      return meanTreatment > meanBaseline;
    };

    const significantBetter = (Object.keys(pValues) as MetricKey[]).some(
      (m) => pValues[m] < 0.05 && better(m),
    );
    const significantWorse = (Object.keys(pValues) as MetricKey[]).some(
      (m) => pValues[m] < 0.05 && !better(m),
    );

    if (significantBetter && !significantWorse) {
      conclusion = 'SIGNIFICANTLY_BETTER';
    } else if (significantWorse && !significantBetter) {
      conclusion = 'WORSE_THAN_BASELINE';
    } else {
      conclusion = 'NO_SIGNIFICANT_DIFFERENCE';
    }
  }

  function getRaw(metric: MetricKey, side: 'baseline' | 'treatment'): number[] {
    if (metric === 'successRate') return side === 'baseline' ? baselineSuccessRates : treatmentSuccessRates;
    if (metric === 'cost') return side === 'baseline' ? baselineCosts : treatmentCosts;
    if (metric === 'latency') return side === 'baseline' ? baselineLatencies : treatmentLatencies;
    return side === 'baseline' ? baselineLlmScores : treatmentLlmScores;
  }

  return {
    moduleId,
    mode,
    n,
    baseline: summarizeMetric(baselineSuccessRates),
    treatment: summarizeMetric(treatmentSuccessRates),
    pValues,
    effectSizes,
    conclusion,
    errors,
  };
}
