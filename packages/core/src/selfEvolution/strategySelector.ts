import type { ExecutionExperience } from '../runtime/types';
import { BetaDistribution } from './betaDistribution';
import { STRATEGY_NAMES } from './strategyConstants';

export class StrategySelector {
  private thompsonPriors: Map<string, BetaDistribution[]> = new Map();

  static readonly MAX_THOMPSON_PRIORS = 200;

  selectStrategy(
    taskType: string,
    strategyPerformance: Map<string, { totalRuns: number; p95DurationMs?: number; avgTokenCost?: number }>,
    modelId?: string,
  ): string {
    const priors = this.getOrCreatePriors(taskType);
    const totalSamples = priors.reduce((s, p) => s + p.totalTrials, 0);

    // Thompson Sampling: sample from each Beta distribution
    const samples = priors.map(p => p.sample());

    // UCB1 exploration bonus: encourages trying under-explored strategies
    const explorationBonuses = priors.map(p => p.explorationBonus(totalSamples));

    // Speed bonus: multiply Thompson sample by a speed factor [0.7, 1.3]
    // Only applied when we have enough data (≥3 runs) to have meaningful duration stats.
    const speedFactors = STRATEGY_NAMES.map(name => {
      const perf = strategyPerformance.get(name);
      if (!perf || perf.totalRuns < 3) return 1.0;
      const allP95 = STRATEGY_NAMES
        .map(n => strategyPerformance.get(n)?.p95DurationMs)
        .filter((d): d is number => d !== undefined && d > 0);
      if (allP95.length < 2) return 1.0;
      const medianP95 = allP95.sort((a, b) => a - b)[Math.floor(allP95.length / 2)];
      const ratio = perf.p95DurationMs! / medianP95;
      return Math.max(0.7, Math.min(1.3, 2.0 - ratio));
    });

    // Cost-aware bonus (Budgeted Bandits-inspired): penalize expensive strategies
    // Only applied when we have enough data (≥3 runs).
    const costFactors = STRATEGY_NAMES.map(name => {
      const perf = strategyPerformance.get(name);
      if (!perf || perf.totalRuns < 3) return 1.0;
      const allCosts = STRATEGY_NAMES
        .map(n => strategyPerformance.get(n)?.avgTokenCost)
        .filter((c): c is number => c !== undefined && c > 0);
      if (allCosts.length < 2) return 1.0;
      const medianCost = allCosts.sort((a, b) => a - b)[Math.floor(allCosts.length / 2)];
      const ratio = perf.avgTokenCost! / medianCost;
      return Math.max(0.8, Math.min(1.2, 2.0 - ratio));
    });

    // Combine: Thompson sample + exploration bonus, then apply speed/cost factors
    // Early on (few samples), exploration dominates; later, exploitation dominates
    const explorationWeight = totalSamples < 20 ? 0.5 : 0.2; // More exploration early
    const adjusted = samples.map((s, i) =>
      (s + explorationWeight * explorationBonuses[i]) * speedFactors[i] * costFactors[i]
    );

    const bestIdx = adjusted.indexOf(Math.max(...adjusted));
    return STRATEGY_NAMES[bestIdx];
  }

  getStrategyScores(
    taskType: string,
    strategyPerformance: Map<string, { totalRuns?: number; avgDurationMs?: number; p95DurationMs?: number }>,
  ): Array<{ strategy: string; score: number; trials: number; avgDurationMs?: number; p95DurationMs?: number }> {
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

  /**
   * Select the runner-up (second-best) strategy for shadow mode comparison.
   * Returns null if there aren't at least 2 strategies with data.
   */
  selectShadowStrategy(
    taskType: string,
    strategyPerformance: Map<string, { totalRuns: number }>,
  ): string | null {
    const priors = this.getOrCreatePriors(taskType);
    const ranked = this.getStrategyScores(taskType, strategyPerformance);
    if (ranked.length < 2) return null;

    const runnerUp = ranked.find((r, i) => {
      if (i === 0) return false; // skip the winner
      return priors[STRATEGY_NAMES.indexOf(r.strategy)].totalTrials > 0;
    });

    return runnerUp?.strategy ?? null;
  }

  /**
   * Feed a shadow comparison result into the Thompson priors as a weak signal.
   */
  recordShadowComparison(params: {
    taskType: string;
    shadowStrategy: string;
    shadowSuccess: boolean;
  }): void {
    const priors = this.getOrCreatePriors(params.taskType);
    const shadowIdx = STRATEGY_NAMES.indexOf(params.shadowStrategy);
    if (shadowIdx < 0) return;

    const weight = 0.5;
    if (params.shadowSuccess) {
      priors[shadowIdx].alpha += weight;
    } else {
      priors[shadowIdx].beta += weight;
    }
  }

  getTrackedTaskTypes(): string[] {
    return Array.from(this.thompsonPriors.keys());
  }

  recordExperience(exp: ExecutionExperience): void {
    const priors = this.getOrCreatePriors(exp.taskType);
    const idx = STRATEGY_NAMES.indexOf(exp.strategyUsed);
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
      this.thompsonPriors.set(taskType, STRATEGY_NAMES.map(() => new BetaDistribution()));
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
