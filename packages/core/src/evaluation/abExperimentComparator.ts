// ─────────────────────────────────────────────────────────────────────────────
// ABExperimentComparator
//
// A/B experiment comparison with statistical significance testing.
// Uses the Wilcoxon signed-rank test (non-parametric, small sample safe)
// to determine if two configurations produce significantly different results.
//
// Unlike parametric tests (t-test), Wilcoxon does not assume normal
// distribution of scores — appropriate for LLM evaluation where score
// distributions are often skewed or bimodal.
// ─────────────────────────────────────────────────────────────────────────────

import type { JudgeResult } from './llmJudgeEngine';

// ============================================================================
// Types
// ============================================================================

export interface ExperimentConfig {
  id: string;
  name: string;
  description?: string;
  datasetId: string;
  configA: {
    label: string;
    model?: string;
    promptVersion?: string;
    params?: Record<string, unknown>;
  };
  configB: {
    label: string;
    model?: string;
    promptVersion?: string;
    params?: Record<string, unknown>;
  };
  createdAt: string;
  status: 'running' | 'completed' | 'failed';
}

export interface ExperimentPairResult {
  caseId: string;
  input: string;
  resultA: JudgeResult;
  resultB: JudgeResult;
  scoreDelta: number; // B - A (positive means B is better)
}

export interface StatisticalResult {
  test: 'wilcoxon-signed-rank';
  n: number; // number of paired samples
  wPlus: number; // sum of positive ranks
  wMinus: number; // sum of negative ranks
  z: number; // z-statistic
  pValue: number; // two-tailed p-value
  effectSize: number; // r = |z| / sqrt(n)
  significant: boolean; // p < 0.05
  confidenceLevel: number; // 1 - pValue
  direction: 'A_better' | 'B_better' | 'no_difference';
  medianDelta: number;
  meanDelta: number;
}

export interface ABExperimentResult {
  experimentId: string;
  config: ExperimentConfig;
  pairs: ExperimentPairResult[];
  stats: StatisticalResult;
  summary: {
    meanScoreA: number;
    meanScoreB: number;
    medianScoreA: number;
    medianScoreB: number;
    p95ScoreA: number;
    p95ScoreB: number;
    improvementPercent: number; // (B - A) / A * 100
    recommendation: 'ship_A' | 'ship_B' | 'inconclusive';
    recommendationReason: string;
  };
  completedAt: string;
}

// ============================================================================
// Wilcoxon Signed-Rank Test Implementation
// ============================================================================

/**
 * Compute the Wilcoxon signed-rank test for paired samples.
 *
 * The test ranks the absolute differences between pairs, then sums
 * the ranks for positive and negative differences separately.
 * The z-statistic is computed from W (the smaller sum) using a
 * normal approximation with continuity correction.
 *
 * @param deltas Array of paired differences (B - A)
 * @param alpha Significance level (default 0.05)
 * @returns Statistical result with z, p-value, and effect size
 */
export function wilcoxonSignedRankTest(
  deltas: number[],
  alpha: number = 0.05,
): StatisticalResult {
  const n = deltas.length;

  // Filter out zero differences (ties)
  const nonZero = deltas.filter((d) => Math.abs(d) > 1e-10);
  const effectiveN = nonZero.length;

  if (effectiveN === 0) {
    return {
      test: 'wilcoxon-signed-rank',
      n,
      wPlus: 0,
      wMinus: 0,
      z: 0,
      pValue: 1.0,
      effectSize: 0,
      significant: false,
      confidenceLevel: 0,
      direction: 'no_difference',
      medianDelta: 0,
      meanDelta: 0,
    };
  }

  // Rank absolute differences (average ranks for ties)
  const absDeltas = nonZero.map((d) => Math.abs(d));
  const ranks = rankAbsoluteValues(absDeltas);

  // Sum positive and negative ranks
  let wPlus = 0;
  let wMinus = 0;
  for (let i = 0; i < nonZero.length; i++) {
    if (nonZero[i] > 0) {
      wPlus += ranks[i];
    } else {
      wMinus += ranks[i];
    }
  }

  // Compute z-statistic using normal approximation
  // E[W] = n(n+1)/4, Var[W] = n(n+1)(2n+1)/24
  // With continuity correction: z = (|W - E[W]| - 0.5) / sqrt(Var[W])
  const ew = (effectiveN * (effectiveN + 1)) / 4;
  const varW = (effectiveN * (effectiveN + 1) * (2 * effectiveN + 1)) / 24;
  const w = Math.min(wPlus, wMinus);
  const z = varW > 0 ? (Math.abs(w - ew) - 0.5) / Math.sqrt(varW) : 0;

  // Two-tailed p-value from z (using error function approximation)
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));

  // Effect size: r = |z| / sqrt(n)
  const effectSize = effectiveN > 0 ? Math.abs(z) / Math.sqrt(effectiveN) : 0;

  // Direction
  let direction: 'A_better' | 'B_better' | 'no_difference';
  if (!significant(pValue, alpha)) {
    direction = 'no_difference';
  } else if (wPlus > wMinus) {
    direction = 'B_better';
  } else {
    direction = 'A_better';
  }

  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  const medianDelta = median(sortedDeltas);
  const meanDelta = deltas.reduce((s, d) => s + d, 0) / (n || 1);

  return {
    test: 'wilcoxon-signed-rank',
    n,
    wPlus,
    wMinus,
    z,
    pValue: Math.max(0, Math.min(1, pValue)),
    effectSize,
    significant: significant(pValue, alpha),
    confidenceLevel: Math.max(0, Math.min(1, 1 - pValue)),
    direction,
    medianDelta,
    meanDelta,
  };
}

// ============================================================================
// ABExperimentComparator
// ============================================================================

export class ABExperimentComparator {
  private experiments: Map<string, ABExperimentResult> = new Map();

  /**
   * Compare two sets of judge results paired by case ID.
   * Performs Wilcoxon signed-rank test on overall scores.
   */
  compare(
    config: ExperimentConfig,
    pairs: ExperimentPairResult[],
  ): ABExperimentResult {
    const deltas = pairs.map((p) => p.scoreDelta);
    const stats = wilcoxonSignedRankTest(deltas);

    const scoresA = pairs.map((p) => p.resultA.overallScore);
    const scoresB = pairs.map((p) => p.resultB.overallScore);

    const meanA = mean(scoresA);
    const meanB = mean(scoresB);
    const medianA = median(scoresA);
    const medianB = median(scoresB);
    const p95A = percentile(scoresA, 0.95);
    const p95B = percentile(scoresB, 0.95);

    const improvementPercent = meanA > 0 ? ((meanB - meanA) / meanA) * 100 : 0;

    let recommendation: 'ship_A' | 'ship_B' | 'inconclusive';
    let recommendationReason: string;

    if (!stats.significant) {
      recommendation = 'inconclusive';
      recommendationReason = `No statistically significant difference (p=${stats.pValue.toFixed(4)} >= 0.05). Sample size n=${stats.n} may be too small.`;
    } else if (stats.direction === 'B_better') {
      recommendation = 'ship_B';
      recommendationReason = `Config B is significantly better (p=${stats.pValue.toFixed(4)}, improvement=${improvementPercent.toFixed(1)}%, effect size r=${stats.effectSize.toFixed(3)})`;
    } else if (stats.direction === 'A_better') {
      recommendation = 'ship_A';
      recommendationReason = `Config A is significantly better (p=${stats.pValue.toFixed(4)}, improvement=${(-improvementPercent).toFixed(1)}%, effect size r=${stats.effectSize.toFixed(3)})`;
    } else {
      recommendation = 'inconclusive';
      recommendationReason = 'No difference detected';
    }

    const result: ABExperimentResult = {
      experimentId: config.id,
      config,
      pairs,
      stats,
      summary: {
        meanScoreA: meanA,
        meanScoreB: meanB,
        medianScoreA: medianA,
        medianScoreB: medianB,
        p95ScoreA: p95A,
        p95ScoreB: p95B,
        improvementPercent,
        recommendation,
        recommendationReason,
      },
      completedAt: new Date().toISOString(),
    };

    this.experiments.set(config.id, result);
    return result;
  }

  /**
   * Get a completed experiment result by ID.
   */
  getResult(experimentId: string): ABExperimentResult | undefined {
    return this.experiments.get(experimentId);
  }

  /**
   * List all completed experiments.
   */
  listResults(limit: number = 50): ABExperimentResult[] {
    return [...this.experiments.values()].slice(-limit);
  }
}

// ============================================================================
// Statistical Helper Functions
// ============================================================================

/**
 * Rank absolute values, using average ranks for ties.
 */
function rankAbsoluteValues(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ value: v, index: i }));
  indexed.sort((a, b) => a.value - b.value);

  const ranks = new Array(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    // Find all tied values
    while (j < indexed.length && indexed[j].value === indexed[i].value) {
      j++;
    }
    // Assign average rank
    const avgRank = (i + 1 + j) / 2; // ranks are 1-indexed
    for (let k = i; k < j; k++) {
      ranks[indexed[k].index] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/**
 * Normal CDF using Abramowitz & Stegun approximation (7.1.26).
 */
function normalCdf(x: number): number {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228;

  const t = 1 / (1 + p * x);
  const phi =
    c * Math.exp(-x * x / 2) * (b1 * t + b2 * t * t + b3 * t * t * t + b4 * t * t * t * t + b5 * t * t * t * t * t);

  return 1 - phi;
}

function significant(pValue: number, alpha: number): boolean {
  return pValue < alpha;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

// ============================================================================
// Singleton
// ============================================================================

let globalComparator: ABExperimentComparator | null = null;

export function getGlobalABComparator(): ABExperimentComparator {
  if (!globalComparator) {
    globalComparator = new ABExperimentComparator();
  }
  return globalComparator;
}
