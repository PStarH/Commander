/**
 * Strategy Meta-Learner — Thompson Sampling for strategy optimization
 *
 * Implements the IMetaLearner contract from Pillar IV.
 *
 * Uses Thompson Sampling (Beta distribution) for exploration/exploitation:
 * - Each strategy has a Beta(α, β) posterior over its success rate
 * - On each selection, sample from each strategy's Beta distribution
 * - Choose the strategy with the highest sampled value
 * - Update the posterior after observing the outcome
 *
 * This naturally balances exploration (trying new strategies) with
 * exploitation (using known-good strategies).
 *
 * Per constraint PIV-FR-07, implements Meta-Learner architecture.
 * Per constraint PIV-FR-08, uses Thompson Sampling.
 */

import { getGlobalLogger } from '../logging';
import type {
  IMetaLearner,
  RetrievalFeedback,
  StrategyContext,
  StrategySelection,
  StrategyEvaluation,
} from '../contracts/pillarIV';

// ============================================================================
// Types
// ============================================================================

interface StrategyStats {
  /** Beta distribution α parameter (successes + 1) */
  alpha: number;
  /** Beta distribution β parameter (failures + 1) */
  beta: number;
  /** Total times this strategy was selected */
  totalRuns: number;
  /** Total successful runs */
  successCount: number;
  /** Sum of utility scores */
  totalUtility: number;
  /** Sum of token costs */
  totalTokens: number;
  /** Sum of latencies */
  totalLatencyMs: number;
  /** Last time this strategy was selected */
  lastUsed: number;
}

// ============================================================================
// StrategyMetaLearner Implementation
// ============================================================================

export class StrategyMetaLearner implements IMetaLearner {
  private strategies: Map<string, StrategyStats> = new Map();
  private layerWeights: { episodic: number; semantic: number; procedural: number };
  private explorationDecay: number;
  private minExplorationBonus: number;
  private selectionHistory: Array<{ strategyId: string; timestamp: number; success: boolean }> = [];

  constructor(options?: {
    initialLayerWeights?: { episodic: number; semantic: number; procedural: number };
    explorationDecay?: number;
    minExplorationBonus?: number;
  }) {
    this.layerWeights = options?.initialLayerWeights ?? {
      episodic: 0.3,
      semantic: 0.4,
      procedural: 0.3,
    };
    this.explorationDecay = options?.explorationDecay ?? 0.99;
    this.minExplorationBonus = options?.minExplorationBonus ?? 0.01;
  }

  /**
   * Update layer weights based on retrieval feedback.
   * If a layer was used and the result was useful, increase its weight.
   * If not useful, decrease its weight.
   */
  updateWeights(feedback: RetrievalFeedback): void {
    const learningRate = 0.05;
    const difficultyMultiplier = feedback.taskDifficulty
      ? 1 + feedback.taskDifficulty * 0.5
      : 1;

    const total = this.layerWeights.episodic + this.layerWeights.semantic + this.layerWeights.procedural;
    const adjust = (feedback.wasUseful ? 1 : -1) * learningRate * difficultyMultiplier;

    for (const layer of feedback.layersUsed) {
      if (layer === 'episodic') {
        this.layerWeights.episodic = Math.max(0.05, Math.min(0.9, this.layerWeights.episodic + adjust));
      } else if (layer === 'semantic') {
        this.layerWeights.semantic = Math.max(0.05, Math.min(0.9, this.layerWeights.semantic + adjust));
      } else if (layer === 'procedural') {
        this.layerWeights.procedural = Math.max(0.05, Math.min(0.9, this.layerWeights.procedural + adjust));
      }
    }

    // Normalize weights to sum to 1
    const newTotal = this.layerWeights.episodic + this.layerWeights.semantic + this.layerWeights.procedural;
    this.layerWeights.episodic /= newTotal;
    this.layerWeights.semantic /= newTotal;
    this.layerWeights.procedural /= newTotal;

    getGlobalLogger().debug('StrategyMetaLearner', 'Weights updated', {
      ...this.layerWeights,
      wasUseful: feedback.wasUseful,
    });
  }

  /**
   * Select the optimal strategy using Thompson Sampling.
   *
   * For each available strategy, sample from its Beta(α, β) distribution.
   * The strategy with the highest sampled value is selected.
   * An exploration bonus is added to rarely-used strategies.
   */
  selectStrategy(context: StrategyContext): StrategySelection {
    const available = context.availableStrategies;

    if (available.length === 0) {
      throw new Error('No strategies available for selection');
    }

    let bestStrategy = available[0];
    let bestSample = -Infinity;
    let bestExplorationBonus = 0;

    for (const strategyId of available) {
      const stats = this.getOrCreateStats(strategyId);

      // Sample from Beta(α, β) using the gamma distribution method
      const sample = this.sampleBeta(stats.alpha, stats.beta);

      // Exploration bonus: decreases with usage (encourages exploration of new strategies)
      const usageFactor = Math.max(
        this.minExplorationBonus,
        Math.pow(this.explorationDecay, stats.totalRuns),
      );
      const explorationBonus = usageFactor * 0.1;

      const totalScore = sample + explorationBonus;

      if (totalScore > bestSample) {
        bestSample = totalScore;
        bestStrategy = strategyId;
        bestExplorationBonus = explorationBonus;
      }
    }

    // Update last used time
    const stats = this.getOrCreateStats(bestStrategy);
    stats.lastUsed = Date.now();
    stats.totalRuns++;

    // Record selection
    this.selectionHistory.push({
      strategyId: bestStrategy,
      timestamp: stats.lastUsed,
      success: false, // Will be updated when evaluate() is called
    });

    // Compute confidence from the Beta distribution
    const mean = stats.alpha / (stats.alpha + stats.beta);
    const variance = (stats.alpha * stats.beta) /
      (Math.pow(stats.alpha + stats.beta, 2) * (stats.alpha + stats.beta + 1));
    const confidence = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) * 2));

    getGlobalLogger().debug('StrategyMetaLearner', 'Strategy selected', {
      strategyId: bestStrategy,
      confidence,
      explorationBonus: bestExplorationBonus,
      sampledValue: bestSample,
    });

    return {
      strategyId: bestStrategy,
      confidence,
      explorationBonus: bestExplorationBonus,
    };
  }

  /**
   * Evaluate a strategy's effectiveness.
   * Updates the strategy's posterior based on observed outcomes.
   */
  evaluate(strategyId: string): StrategyEvaluation {
    const stats = this.getOrCreateStats(strategyId);
    const sampleCount = stats.alpha + stats.beta - 2; // Subtract prior (1, 1)
    const meanUtility = sampleCount > 0 ? stats.totalUtility / sampleCount : 0;
    const meanSuccessRate = sampleCount > 0 ? stats.successCount / sampleCount : 0;

    // Compute regret: difference between optimal and actual
    let bestMeanUtility = 0;
    for (const [, s] of this.strategies) {
      const mean = s.totalRuns > 0 ? s.totalUtility / s.totalRuns : 0;
      if (mean > bestMeanUtility) bestMeanUtility = mean;
    }
    const regret = Math.max(0, bestMeanUtility - meanUtility);

    return {
      strategyId,
      meanUtility,
      sampleCount,
      regret,
    };
  }

  /**
   * Record the outcome of a strategy execution.
   * Updates the Beta distribution posterior.
   */
  recordOutcome(strategyId: string, success: boolean, utility: number): void {
    const stats = this.getOrCreateStats(strategyId);

    if (success) {
      stats.alpha += 1;
      stats.successCount++;
    } else {
      stats.beta += 1;
    }

    stats.totalUtility += utility;

    // Update the last selection in history
    const lastSelection = this.selectionHistory[this.selectionHistory.length - 1];
    if (lastSelection && lastSelection.strategyId === strategyId) {
      lastSelection.success = success;
    }

    getGlobalLogger().debug('StrategyMetaLearner', 'Outcome recorded', {
      strategyId,
      success,
      utility,
      alpha: stats.alpha,
      beta: stats.beta,
    });
  }

  /**
   * Get the current layer weights.
   */
  getLayerWeights(): { episodic: number; semantic: number; procedural: number } {
    return { ...this.layerWeights };
  }

  /**
   * Get all registered strategies.
   */
  getStrategies(): string[] {
    return [...this.strategies.keys()];
  }

  /**
   * Get strategy statistics.
   */
  getStrategyStats(strategyId: string): StrategyStats | undefined {
    const stats = this.strategies.get(strategyId);
    return stats ? { ...stats } : undefined;
  }

  /**
   * Get the selection history.
   */
  getSelectionHistory(): Array<{ strategyId: string; timestamp: number; success: boolean }> {
    return [...this.selectionHistory];
  }

  // ------------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------------

  private getOrCreateStats(strategyId: string): StrategyStats {
    if (!this.strategies.has(strategyId)) {
      this.strategies.set(strategyId, {
        alpha: 1, // Beta(1, 1) = uniform prior
        beta: 1,
        totalRuns: 0,
        successCount: 0,
        totalUtility: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
        lastUsed: 0,
      });
    }
    return this.strategies.get(strategyId)!;
  }

  /**
   * Sample from a Beta(α, β) distribution using the gamma method.
   * Beta(α, β) = Gamma(α) / (Gamma(α) + Gamma(β))
   */
  private sampleBeta(alpha: number, beta: number): number {
    const x = this.sampleGamma(alpha, 1);
    const y = this.sampleGamma(beta, 1);
    return x / (x + y);
  }

  /**
   * Sample from a Gamma(α, θ) distribution using Marsaglia-Tsang method.
   */
  private sampleGamma(shape: number, scale: number): number {
    if (shape < 1) {
      // Use boosting for shape < 1
      const u = Math.random();
      return this.sampleGamma(shape + 1, scale) * Math.pow(u, 1 / shape);
    }

    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    let x: number;
    let v: number;

    do {
      do {
        x = this.sampleStandardNormal();
        v = 1 + c * x;
      } while (v <= 0);

      v = v * v * v;
      const u = Math.random();
      const accept = u < 1 - 0.0331 * x * x * x * x;

      if (accept) return d * v * scale;

      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v * scale;
      }
    } while (true);
  }

  /**
   * Sample from a standard normal distribution (Box-Muller).
   */
  private sampleStandardNormal(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalStrategyMetaLearner: StrategyMetaLearner | null = null;

export function getGlobalStrategyMetaLearner(): StrategyMetaLearner {
  if (!globalStrategyMetaLearner) {
    globalStrategyMetaLearner = new StrategyMetaLearner();
  }
  return globalStrategyMetaLearner;
}
