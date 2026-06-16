import type { ExecutionExperience, PerModelStrategyStats } from '../runtime/types';
import { BetaDistribution } from './betaDistribution';
import { STRATEGY_NAMES } from './strategyConstants';

export class CrossModelMemory {
  /** Per-model, per-strategy Thompson Sampling: Map<modelId, Map<strategyName, BetaDistribution>> */
  private perModelPriors: Map<string, Map<string, BetaDistribution>> = new Map();

  static readonly MAX_PER_MODEL_PRIORS = 50;

  recordExperience(exp: ExecutionExperience): void {
    const prior = this.getOrCreatePerModelPriors(exp.modelUsed, exp.strategyUsed);
    prior.update(exp.success);
  }

  getStrategyScoresForModel(
    modelId: string,
    strategyPerformance: Map<string, { avgDurationMs?: number; p95DurationMs?: number }>,
  ): Array<{
    strategy: string;
    score: number;
    trials: number;
    avgDurationMs?: number;
    p95DurationMs?: number;
  }> {
    const modelMap = this.perModelPriors.get(modelId);
    if (!modelMap) {
      // No per-model data yet — return empty, caller can fall back to global
      return [];
    }
    return Array.from(modelMap.entries())
      .map(([strategy, prior]) => {
        const perf = strategyPerformance.get(strategy);
        return {
          strategy,
          score: prior.mean,
          trials: prior.totalTrials,
          avgDurationMs: perf?.avgDurationMs,
          p95DurationMs: perf?.p95DurationMs,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  getPerModelStats(): PerModelStrategyStats[] {
    const stats: PerModelStrategyStats[] = [];
    for (const [modelId, modelMap] of this.perModelPriors) {
      for (const [strategy, prior] of modelMap) {
        stats.push({
          modelId,
          strategy,
          totalRuns: prior.totalTrials,
          successCount: prior.alpha - 1,
          successRate: prior.mean,
          avgTokenCost: 0,
          lastUsed: '',
        });
      }
    }
    return stats;
  }

  getPerModelPriors(): Map<string, Map<string, BetaDistribution>> {
    return this.perModelPriors;
  }

  setPerModelPriors(priors: Map<string, Map<string, BetaDistribution>>): void {
    this.perModelPriors = priors;
  }

  private getOrCreatePerModelPriors(modelId: string, strategy: string): BetaDistribution {
    if (!this.perModelPriors.has(modelId)) {
      if (this.perModelPriors.size >= CrossModelMemory.MAX_PER_MODEL_PRIORS) {
        const oldest = this.perModelPriors.keys().next().value;
        if (oldest) this.perModelPriors.delete(oldest);
      }
      this.perModelPriors.set(modelId, new Map());
    }
    const modelMap = this.perModelPriors.get(modelId)!;
    if (!modelMap.has(strategy)) {
      modelMap.set(strategy, new BetaDistribution());
    }
    return modelMap.get(strategy)!;
  }
}
