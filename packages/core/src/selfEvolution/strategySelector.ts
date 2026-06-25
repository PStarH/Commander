import type { ExecutionExperience } from '../runtime/types';
import { BetaDistribution } from './betaDistribution';
import { STRATEGY_NAMES, type StrategyName } from './strategyConstants';

export class StrategySelector {
  private thompsonPriors: Map<string, BetaDistribution[]> = new Map();

  static readonly MAX_THOMPSON_PRIORS = 200;

  private computeAdjustmentFactors(
    taskType: string,
    strategyPerformance: Map<
      string,
      { totalRuns: number; p95DurationMs?: number; avgTokenCost?: number }
    >,
  ): {
    samples: number[];
    explorationBonuses: number[];
    speedFactors: number[];
    costFactors: number[];
    explorationWeight: number;
  } {
    const priors = this.getOrCreatePriors(taskType);
    const totalSamples = priors.reduce((s, p) => s + p.totalTrials, 0);

    // Thompson Sampling: sample from each Beta distribution
    const samples = priors.map((p) => p.sample());

    // UCB1 exploration bonus: encourages trying under-explored strategies
    const explorationBonuses = priors.map((p) => p.explorationBonus(totalSamples));

    // Speed bonus: multiply Thompson sample by a speed factor [0.7, 1.3]
    // Only applied when we have enough data (≥3 runs) to have meaningful duration stats.
    const speedFactors = STRATEGY_NAMES.map((name) => {
      const perf = strategyPerformance.get(name);
      if (!perf || perf.totalRuns < 3) return 1.0;
      const allP95 = STRATEGY_NAMES.map((n) => strategyPerformance.get(n)?.p95DurationMs).filter(
        (d): d is number => d !== undefined && d > 0,
      );
      if (allP95.length < 2) return 1.0;
      const medianP95 = allP95.sort((a, b) => a - b)[Math.floor(allP95.length / 2)];
      const ratio = perf.p95DurationMs! / medianP95;
      return Math.max(0.7, Math.min(1.3, 2.0 - ratio));
    });

    // Cost-aware bonus (Budgeted Bandits-inspired): penalize expensive strategies
    // Only applied when we have enough data (≥3 runs).
    const costFactors = STRATEGY_NAMES.map((name) => {
      const perf = strategyPerformance.get(name);
      if (!perf || perf.totalRuns < 3) return 1.0;
      const allCosts = STRATEGY_NAMES.map((n) => strategyPerformance.get(n)?.avgTokenCost).filter(
        (c): c is number => c !== undefined && c > 0,
      );
      if (allCosts.length < 2) return 1.0;
      const medianCost = allCosts.sort((a, b) => a - b)[Math.floor(allCosts.length / 2)];
      const ratio = perf.avgTokenCost! / medianCost;
      return Math.max(0.8, Math.min(1.2, 2.0 - ratio));
    });

    const explorationWeight = totalSamples < 20 ? 0.5 : 0.2;
    return { samples, explorationBonuses, speedFactors, costFactors, explorationWeight };
  }

  selectStrategy(
    taskType: string,
    strategyPerformance: Map<
      string,
      { totalRuns: number; p95DurationMs?: number; avgTokenCost?: number }
    >,
    _modelId?: string,
  ): string {
    const { samples, explorationBonuses, speedFactors, costFactors, explorationWeight } =
      this.computeAdjustmentFactors(taskType, strategyPerformance);

    const adjusted = samples.map(
      (s, i) => (s + explorationWeight * explorationBonuses[i]) * speedFactors[i] * costFactors[i],
    );

    const bestIdx = adjusted.indexOf(Math.max(...adjusted));
    return STRATEGY_NAMES[bestIdx];
  }

  /**
   * Calculate the adjusted score for every strategy.
   * Mirrors the scoring used by selectStrategy so callers can inspect the ranking.
   */
  calculateAdjustedScores(
    taskType: string,
    strategyPerformance: Map<
      string,
      { totalRuns: number; p95DurationMs?: number; avgTokenCost?: number }
    >,
  ): Array<{ name: string; score: number }> {
    const { samples, explorationBonuses, speedFactors, costFactors, explorationWeight } =
      this.computeAdjustmentFactors(taskType, strategyPerformance);

    const adjusted = samples.map(
      (s, i) => (s + explorationWeight * explorationBonuses[i]) * speedFactors[i] * costFactors[i],
    );

    return STRATEGY_NAMES.map((name, i) => ({ name, score: adjusted[i] })).sort(
      (a, b) => b.score - a.score,
    );
  }

  getStrategyScores(
    taskType: string,
    strategyPerformance: Map<
      string,
      { totalRuns?: number; avgDurationMs?: number; p95DurationMs?: number }
    >,
  ): Array<{
    strategy: string;
    score: number;
    trials: number;
    avgDurationMs?: number;
    p95DurationMs?: number;
  }> {
    const priors = this.getOrCreatePriors(taskType);
    return STRATEGY_NAMES.map((name, i) => {
      const perf = strategyPerformance.get(name);
      return {
        strategy: name,
        score: priors[i].mean,
        trials: priors[i].totalTrials,
        avgDurationMs: perf?.avgDurationMs,
        p95DurationMs: perf?.p95DurationMs,
      };
    }).sort((a, b) => b.score - a.score);
  }

  getTrackedTaskTypes(): string[] {
    return Array.from(this.thompsonPriors.keys());
  }

  recordExperience(exp: ExecutionExperience): void {
    const priors = this.getOrCreatePriors(exp.taskType);
    const idx = STRATEGY_NAMES.indexOf(exp.strategyUsed as StrategyName);
    if (idx >= 0) {
      const difficulty = this.estimateTaskDifficulty(exp);
      priors[idx].update(exp.success, difficulty);
    }
  }

  getThompsonPriors(): Map<string, BetaDistribution[]> {
    return this.thompsonPriors;
  }

  setThompsonPriors(priors: Map<string, BetaDistribution[]>): void {
    this.thompsonPriors = priors;
  }

  private getOrCreatePriors(taskType: string): BetaDistribution[] {
    if (!this.thompsonPriors.has(taskType)) {
      if (this.thompsonPriors.size >= StrategySelector.MAX_THOMPSON_PRIORS) {
        const oldest = this.thompsonPriors.keys().next().value;
        if (oldest) this.thompsonPriors.delete(oldest);
      }
      this.thompsonPriors.set(
        taskType,
        STRATEGY_NAMES.map(() => new BetaDistribution()),
      );
    }
    return this.thompsonPriors.get(taskType)!;
  }

  private estimateTaskDifficulty(exp: ExecutionExperience): number {
    let difficulty = 0.5; // baseline

    // Higher token cost → harder task
    if (exp.tokenCost > 50000) difficulty += 0.2;
    else if (exp.tokenCost > 20000) difficulty += 0.1;

    // Longer duration → harder task
    if (exp.durationMs > 60000) difficulty += 0.15;
    else if (exp.durationMs > 30000) difficulty += 0.05;

    // Error patterns suggest complexity
    if (exp.errorPattern) {
      if (/context|overflow|token/i.test(exp.errorPattern)) difficulty += 0.1;
      if (/timeout|deadline/i.test(exp.errorPattern)) difficulty += 0.1;
    }

    // Multi-tool tasks are harder
    if ((exp.toolsUsed?.length ?? 0) > 3) difficulty += 0.1;

    return Math.min(1, difficulty);
  }
}
