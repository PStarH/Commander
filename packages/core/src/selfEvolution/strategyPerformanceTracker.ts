import type { ExecutionExperience, StrategyPerformance } from '../runtime/types';

export class StrategyPerformanceTracker {
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();

  recordExperience(exp: ExecutionExperience): void {
    const existing = this.strategyPerformance.get(exp.strategyUsed) ?? {
      strategyName: exp.strategyUsed,
      totalRuns: 0,
      successCount: 0,
      avgDurationMs: 0,
      p95DurationMs: 0,
      avgTokenCost: 0,
      successRate: 0,
      lastUsed: '',
      bestForTaskTypes: [],
    };

    const totalRuns = existing.totalRuns + 1;
    existing.successCount += exp.success ? 1 : 0;
    existing.avgDurationMs =
      (existing.avgDurationMs * existing.totalRuns + exp.durationMs) / totalRuns;
    existing.avgTokenCost =
      (existing.avgTokenCost * existing.totalRuns + exp.tokenCost) / totalRuns;
    existing.totalRuns = totalRuns;
    existing.successRate = existing.successCount / totalRuns;
    existing.lastUsed = exp.timestamp;

    // p95 duration: exponential moving average of the upper tail
    // Weight new sample more if it's above current p95 (tracks latency spikes)
    if (existing.p95DurationMs === 0) {
      existing.p95DurationMs = exp.durationMs;
    } else if (exp.durationMs > existing.p95DurationMs) {
      // Above p95: aggressive update (0.3 weight to new high value)
      existing.p95DurationMs = existing.p95DurationMs * 0.7 + exp.durationMs * 0.3;
    } else {
      // Below p95: slow decay (p95 drifts down gradually)
      existing.p95DurationMs = existing.p95DurationMs * 0.95 + exp.durationMs * 0.05;
    }

    if (
      !existing.bestForTaskTypes.includes(exp.taskType) &&
      existing.bestForTaskTypes.length < 20
    ) {
      existing.bestForTaskTypes.push(exp.taskType);
    }

    this.strategyPerformance.set(exp.strategyUsed, existing);
  }

  getStrategyPerformance(): Map<string, StrategyPerformance> {
    return new Map(this.strategyPerformance);
  }

  setStrategyPerformance(perf: Map<string, StrategyPerformance>): void {
    this.strategyPerformance = new Map(perf);
  }

  rankStrategies(): StrategyPerformance[] {
    return Array.from(this.strategyPerformance.values()).sort((a, b) => {
      // Composite ranking: 70% success rate + 15% speed + 15% cost efficiency
      const scoreA = a.successRate * 0.7 + this.speedScore(a) * 0.15 + this.costScore(a) * 0.15;
      const scoreB = b.successRate * 0.7 + this.speedScore(b) * 0.15 + this.costScore(b) * 0.15;
      return scoreB - scoreA;
    });
  }

  recommendBestStrategy(): string {
    const ranked = this.rankStrategies();
    return ranked.length > 0 ? ranked[0].strategyName : 'SEQUENTIAL';
  }

  analyzeModelPerformance(): Map<
    string,
    { totalRuns: number; successRate: number; avgTokens: number }
  > {
    // Build model stats from the strategy performance entries by scanning experiences
    // We need experiences to do this, but this method was called with experiences from MetaLearner.
    // Since we don't have experiences here, we return empty. The facade will handle this.
    return new Map<string, { totalRuns: number; successRate: number; avgTokens: number }>();
  }

  /** Normalize strategy speed to [0, 1] where 1 = fastest. */
  speedScore(perf: StrategyPerformance): number {
    if (perf.totalRuns < 3 || perf.p95DurationMs <= 0) return 0.5; // neutral when insufficient data
    const allP95 = Array.from(this.strategyPerformance.values())
      .filter((p) => p.totalRuns >= 3 && p.p95DurationMs > 0)
      .map((p) => p.p95DurationMs);
    if (allP95.length < 2) return 0.5;
    const min = Math.min(...allP95);
    const max = Math.max(...allP95);
    if (max === min) return 0.5;
    // Invert: lower duration = higher score
    return 1.0 - (perf.p95DurationMs - min) / (max - min);
  }

  /** Normalize strategy cost to [0, 1] where 1 = cheapest. */
  costScore(perf: StrategyPerformance): number {
    if (perf.totalRuns < 3 || perf.avgTokenCost <= 0) return 0.5;
    const allCosts = Array.from(this.strategyPerformance.values())
      .filter((p) => p.totalRuns >= 3 && p.avgTokenCost > 0)
      .map((p) => p.avgTokenCost);
    if (allCosts.length < 2) return 0.5;
    const min = Math.min(...allCosts);
    const max = Math.max(...allCosts);
    if (max === min) return 0.5;
    // Invert: lower cost = higher score
    return 1.0 - (perf.avgTokenCost - min) / (max - min);
  }
}
