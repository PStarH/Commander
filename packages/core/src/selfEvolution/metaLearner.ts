import * as fs from 'fs';
import * as nodePath from 'path';
import type {
  AnalysisMode,
  EvolutionInsight,
  EvolutionPrediction,
  ExecutionExperience,
  FailureCategory,
  MetaLearnerConfig,
  OptimizationSuggestion,
  PredictionVerdict,
  PerModelStrategyStats,
  RegressionEvent,
  StrategyPerformance,
} from '../runtime/types';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Beta distribution for Thompson Sampling
// ============================================================================

class BetaDistribution {
  alpha: number;
  beta: number;

  constructor(alpha = 1, beta = 1) {
    this.alpha = alpha;
    this.beta = beta;
  }

  /**
   * Sample from the Beta distribution using Gamma sampling.
   * Improved: uses Marsaglia & Tsang method correctly (the previous
   * Box-Muller approximation was inaccurate for small shape values).
   */
  sample(): number {
    const alphaSample = this.sampleGamma(this.alpha);
    const betaSample = this.sampleGamma(this.beta);
    return alphaSample / (alphaSample + betaSample);
  }

  private sampleGamma(shape: number): number {
    if (shape < 1) {
      // For shape < 1, use the relation: Gamma(a) = Gamma(a+1) * U^(1/a)
      const u = Math.random();
      return Math.pow(u, 1 / shape) * this.sampleGamma(shape + 1);
    }
    // Marsaglia & Tsang method (2000) — accurate for shape >= 1
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number;
      let v: number;
      do {
        // Use Box-Muller for normal distribution (more accurate than sum of uniforms)
        const u1 = Math.random();
        const u2 = Math.random();
        x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  /**
   * Update the distribution with an observation.
   * taskDifficulty (0-1) scales the update magnitude — harder tasks
   * contribute less to avoid penalizing strategies for difficult work.
   */
  update(success: boolean, taskDifficulty: number = 0.5): void {
    // Scale update by difficulty: easy tasks give stronger signal
    const weight = 0.5 + (1 - taskDifficulty) * 0.5; // [0.5, 1.0]
    if (success) {
      this.alpha += weight;
    } else {
      this.beta += weight;
    }
  }

  get mean(): number {
    return this.alpha / (this.alpha + this.beta);
  }

  get totalTrials(): number {
    return this.alpha + this.beta - 2;
  }

  /**
   * UCB1-style exploration bonus.
   * Encourages trying strategies with fewer samples.
   * Returns a bonus value to add to the Thompson sample.
   */
  explorationBonus(totalSamples: number): number {
    if (this.totalTrials === 0) return 1.0; // Max exploration for untried strategies
    return Math.sqrt(2 * Math.log(Math.max(1, totalSamples)) / this.totalTrials);
  }
}

// ============================================================================
// Reflexion — verbal self-reflection
// ============================================================================

function generateReflection(exp: ExecutionExperience): string {
  if (exp.success) {
    const lessons = exp.lessons.length > 0
      ? exp.lessons.join('; ')
      : 'No specific lessons recorded.';
    return [
      `[Reflection: SUCCESS]`,
      `Task: ${exp.taskType} (${exp.strategyUsed})`,
      `Duration: ${exp.durationMs}ms, Cost: ${exp.tokenCost} tokens`,
      `Lessons: ${lessons}`,
      `Summary: The ${exp.strategyUsed} strategy worked well for this ${exp.taskType} task.`,
    ].join('\n');
  }

  // Failure analysis — identify root cause pattern
  const errorHint = exp.errorPattern
    ? `Error pattern: ${exp.errorPattern}`
    : 'No error pattern captured.';

  return [
    `[Reflection: FAILURE]`,
    `Task: ${exp.taskType} (${exp.strategyUsed})`,
    `Duration: ${exp.durationMs}ms, Cost: ${exp.tokenCost} tokens`,
    `${errorHint}`,
    `Analysis:`,
    `  - The ${exp.strategyUsed} strategy may not be optimal for ${exp.taskType} tasks`,
    `  - Consider: more tool access, different model tier, or alternative orchestration mode`,
    `  - If this pattern repeats, the strategy should be deprioritized`,
  ].join('\n');
}

// ============================================================================
// Thompson Sampling for strategy selection
// ============================================================================

const STRATEGY_NAMES = ['SEQUENTIAL', 'PARALLEL', 'HANDOFF', 'MAGENTIC', 'CONSENSUS'];

export const DEFAULT_META_LEARNER_CONFIG: MetaLearnerConfig = {
  analysisMode: 'light',
  enablePredictionLoop: true,
  enableRegressionGate: true,
  enableCrossModelMemory: true,
  regressionThreshold: 0.15,
};

// ============================================================================
// MetaLearner — enhanced with Reflexion + Thompson Sampling
// ============================================================================

export class MetaLearner {
  private experiences: ExecutionExperience[] = [];
  private reflections: string[] = [];
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();
  /** Thompson Sampling: per-task-type Beta distributions over strategies */
  private thompsonPriors: Map<string, BetaDistribution[]> = new Map();
  private maxExperiences: number;
  private minSamplesForSuggestion: number;
  private persistPath: string | null;

  // ========================================================================
  // Prediction loop — falsifiable edit contracts
  // ========================================================================
  private predictions: EvolutionPrediction[] = [];
  private verdicts: PredictionVerdict[] = [];
  /** Tracks last strategy selected per (modelId, taskType) for change detection */
  private lastPredictedStrategy: Map<string, string> = new Map();

  // ========================================================================
  // Regression gate — automatic decline detection
  // ========================================================================
  private regressionEvents: RegressionEvent[] = [];
  /** Rolling success rate history per strategy: Map<strategyName, number[]> */
  private successRateHistory: Map<string, number[]> = new Map();

  // ========================================================================
  // Cross-model strategy memory
  // ========================================================================
  /** Per-model, per-strategy Thompson Sampling: Map<modelId, Map<strategyName, BetaDistribution>> */
  private perModelPriors: Map<string, Map<string, BetaDistribution>> = new Map();

  private static readonly MAX_THOMPSON_PRIORS = 200;
  private static readonly MAX_SUCCESS_RATE_ENTRIES = 200;
  private static readonly MAX_PER_MODEL_PRIORS = 50;

  // ========================================================================
  // Config
  // ========================================================================
  private config: MetaLearnerConfig;

  constructor(
    maxExperiences = 500,
    minSamplesForSuggestion = 5,
    persistPath?: string,
    config?: Partial<MetaLearnerConfig>,
  ) {
    this.maxExperiences = maxExperiences;
    this.minSamplesForSuggestion = minSamplesForSuggestion;
    this.persistPath = persistPath ?? null;
    this.config = { ...DEFAULT_META_LEARNER_CONFIG, ...config };
    if (this.persistPath) {
      this.load();
    }
  }

  // ========================================================================
  // Experience Recording
  // ========================================================================

  recordExperience(exp: ExecutionExperience): void {
    this.experiences.push(exp);
    if (this.experiences.length > this.maxExperiences) {
      this.experiences.shift();
    }

    this.updateStrategyPerformance(exp);
    this.updateThompsonPrior(exp);

    // Cross-model: update per-model priors
    if (this.config.enableCrossModelMemory) {
      this.updatePerModelPrior(exp);
    }

    // Prediction loop: verify outstanding predictions for this model+taskType
    if (this.config.enablePredictionLoop) {
      this.verifyPrediction(exp);
    }

    // Regression gate: check for significant success rate drops
    if (this.config.enableRegressionGate) {
      this.detectRegression(exp);
    }

    // Generate verbal reflection
    const reflection = generateReflection(exp);
    this.reflections.push(reflection);
    if (this.reflections.length > 200) {
      this.reflections.shift();
    }

    const bus = getMessageBus();
    bus.publish('memory.written', 'meta-learner', {
      type: 'execution_experience',
      runId: exp.runId,
      success: exp.success,
      strategy: exp.strategyUsed,
      reflection: reflection.slice(0, 200),
    });

    // Persist for cross-session learning
    this.persist();
  }

  // ========================================================================
  // Thompson Sampling for strategy selection
  // ========================================================================

  /**
   * Select the best strategy for a given task type using Thompson Sampling
   * with UCB1 exploration bonus and speed/cost-aware adjustments.
   *
   * The selection formula:
   *   adjusted[i] = thompsonSample[i] + ucb1Bonus[i] * speedFactor[i] * costFactor[i]
   *
   * This ensures:
   * - Exploration: strategies with fewer trials get a bonus (UCB1)
   * - Exploitation: strategies with higher success rates get higher Thompson samples
   * - Speed awareness: faster strategies are preferred
   * - Cost awareness: cheaper strategies are preferred
   *
   * If prediction loop is enabled, records the (model, taskType) → strategy mapping
   * so that future strategy changes trigger a prediction.
   */
  selectStrategy(taskType: string, modelId?: string): string {
    const priors = this.getOrCreatePriors(taskType);
    const totalSamples = priors.reduce((s, p) => s + p.totalTrials, 0);

    // Thompson Sampling: sample from each Beta distribution
    const samples = priors.map(p => p.sample());

    // UCB1 exploration bonus: encourages trying under-explored strategies
    const explorationBonuses = priors.map(p => p.explorationBonus(totalSamples));

    // Speed bonus: multiply Thompson sample by a speed factor [0.7, 1.3]
    // Only applied when we have enough data (≥3 runs) to have meaningful duration stats.
    const speedFactors = STRATEGY_NAMES.map(name => {
      const perf = this.strategyPerformance.get(name);
      if (!perf || perf.totalRuns < 3) return 1.0;
      const allP95 = STRATEGY_NAMES
        .map(n => this.strategyPerformance.get(n)?.p95DurationMs)
        .filter((d): d is number => d !== undefined && d > 0);
      if (allP95.length < 2) return 1.0;
      const medianP95 = allP95.sort((a, b) => a - b)[Math.floor(allP95.length / 2)];
      const ratio = perf.p95DurationMs / medianP95;
      return Math.max(0.7, Math.min(1.3, 2.0 - ratio));
    });

    // Cost-aware bonus (Budgeted Bandits-inspired): penalize expensive strategies
    // Only applied when we have enough data (≥3 runs).
    const costFactors = STRATEGY_NAMES.map(name => {
      const perf = this.strategyPerformance.get(name);
      if (!perf || perf.totalRuns < 3) return 1.0;
      const allCosts = STRATEGY_NAMES
        .map(n => this.strategyPerformance.get(n)?.avgTokenCost)
        .filter((c): c is number => c !== undefined && c > 0);
      if (allCosts.length < 2) return 1.0;
      const medianCost = allCosts.sort((a, b) => a - b)[Math.floor(allCosts.length / 2)];
      const ratio = perf.avgTokenCost / medianCost;
      return Math.max(0.8, Math.min(1.2, 2.0 - ratio));
    });

    // Combine: Thompson sample + exploration bonus, then apply speed/cost factors
    // Early on (few samples), exploration dominates; later, exploitation dominates
    const explorationWeight = totalSamples < 20 ? 0.5 : 0.2; // More exploration early
    const adjusted = samples.map((s, i) =>
      (s + explorationWeight * explorationBonuses[i]) * speedFactors[i] * costFactors[i]
    );

    const bestIdx = adjusted.indexOf(Math.max(...adjusted));
    const chosen = STRATEGY_NAMES[bestIdx];

    if (this.config.enablePredictionLoop && modelId) {
      const key = `${modelId}::${taskType}`;
      this.lastPredictedStrategy.set(key, chosen);
    }

    return chosen;
  }

  /**
   * Get all strategy scores for a task type (for visualization/debugging).
   */
  getStrategyScores(taskType: string): Array<{ strategy: string; score: number; trials: number; avgDurationMs?: number; p95DurationMs?: number }> {
    const priors = this.getOrCreatePriors(taskType);
    return STRATEGY_NAMES.map((name, i) => {
      const perf = this.strategyPerformance.get(name);
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
   * Returns all task types tracked by the Thompson Sampling priors.
   */
  getTrackedTaskTypes(): string[] {
    return Array.from(this.thompsonPriors.keys());
  }

  private getOrCreatePriors(taskType: string): BetaDistribution[] {
    if (!this.thompsonPriors.has(taskType)) {
      if (this.thompsonPriors.size >= MetaLearner.MAX_THOMPSON_PRIORS) {
        const oldest = this.thompsonPriors.keys().next().value;
        if (oldest) this.thompsonPriors.delete(oldest);
      }
      this.thompsonPriors.set(taskType, STRATEGY_NAMES.map(() => new BetaDistribution()));
    }
    return this.thompsonPriors.get(taskType)!;
  }

  /**
   * Estimate task difficulty from execution experience.
   * Harder tasks (0-1) contribute less to prior updates to avoid
   * penalizing strategies for inherently difficult work.
   */
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

  private updateThompsonPrior(exp: ExecutionExperience): void {
    const priors = this.getOrCreatePriors(exp.taskType);
    const idx = STRATEGY_NAMES.indexOf(exp.strategyUsed);
    if (idx >= 0) {
      const difficulty = this.estimateTaskDifficulty(exp);
      priors[idx].update(exp.success, difficulty);
    }
  }

  // ========================================================================
  // Cross-model strategy memory
  // ========================================================================

  private getOrCreatePerModelPriors(modelId: string, strategy: string): BetaDistribution {
    if (!this.perModelPriors.has(modelId)) {
      if (this.perModelPriors.size >= MetaLearner.MAX_PER_MODEL_PRIORS) {
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

  private updatePerModelPrior(exp: ExecutionExperience): void {
    const prior = this.getOrCreatePerModelPriors(exp.modelUsed, exp.strategyUsed);
    prior.update(exp.success);
  }

  /**
   * Get strategy rankings specific to a model (cross-model memory).
   * Falls back to global rankings when per-model data is insufficient.
   */
  getStrategyScoresForModel(modelId: string): Array<{ strategy: string; score: number; trials: number; avgDurationMs?: number; p95DurationMs?: number }> {
    const modelMap = this.perModelPriors.get(modelId);
    if (!modelMap) {
      // No per-model data yet — return empty, caller can fall back to global
      return [];
    }
    return Array.from(modelMap.entries()).map(([strategy, prior]) => {
      const perf = this.strategyPerformance.get(strategy);
      return {
        strategy,
        score: prior.mean,
        trials: prior.totalTrials,
        avgDurationMs: perf?.avgDurationMs,
        p95DurationMs: perf?.p95DurationMs,
      };
    }).sort((a, b) => b.score - a.score);
  }

  /**
   * Get per-model strategy stats for external inspection.
   */
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

  // ========================================================================
  // Prediction loop — falsifiable edit contracts
  // ========================================================================

  /**
   * Create a prediction for an upcoming strategy change.
   * Called by the harness evolver (or externally) before deploying an edit.
   */
  createPrediction(
    editId: string,
    description: string,
    targetStrategy: string,
    sourceStrategy: string,
    modelId: string,
    taskTypes: string[],
    predictedFixes: FailureCategory[] = [],
    predictedRegressions: FailureCategory[] = [],
  ): EvolutionPrediction {
    const prediction: EvolutionPrediction = {
      id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      editId,
      description,
      predictedFixes,
      predictedRegressions,
      targetStrategy,
      sourceStrategy,
      modelId,
      taskTypes,
      timestamp: new Date().toISOString(),
    };
    this.predictions.push(prediction);
    if (this.predictions.length > 500) this.predictions.shift();
    return prediction;
  }

  /**
   * Verify outstanding predictions against incoming experience.
   * Compares the experience's strategy vs the last selected strategy per (modelId, taskType)
   * to detect strategy changes, then checks if predictions held.
   */
  private verifyPrediction(exp: ExecutionExperience): void {
    if (!this.config.enablePredictionLoop) return;

    const key = `${exp.modelUsed}::${exp.taskType}`;
    const previousStrategy = this.lastPredictedStrategy.get(key);
    if (!previousStrategy || previousStrategy === exp.strategyUsed) return;

    // Strategy changed — find relevant prediction
    const relevant = this.predictions.filter(
      p => p.targetStrategy === exp.strategyUsed
        && p.modelId === exp.modelUsed
        && p.taskTypes.includes(exp.taskType),
    );

    for (const pred of relevant) {
      const fixConfirmed = pred.predictedFixes.length === 0 ? exp.success : true;
      const regressObserved = !exp.success && pred.predictedRegressions.length > 0;

      const verdict: PredictionVerdict = {
        predictionId: pred.id,
        fixesConfirmed: fixConfirmed ? ['confirmed'] : [],
        regressionsObserved: regressObserved ? ['observed'] : [],
        netImpact: exp.success ? 'positive' : 'negative',
        reverted: false,
        verifiedAt: new Date().toISOString(),
      };

      this.verdicts.push(verdict);
      if (this.verdicts.length > 500) this.verdicts.shift();

      const bus = getMessageBus();
      bus.publish('memory.written', 'meta-learner', {
        type: 'prediction_verdict',
        predictionId: pred.id,
        netImpact: verdict.netImpact,
      });
    }
  }

  getPredictions(): EvolutionPrediction[] {
    return [...this.predictions];
  }

  getVerdicts(): PredictionVerdict[] {
    return [...this.verdicts];
  }

  // ========================================================================
  // Regression detection gate
  // ========================================================================

  /**
   * Detect if a strategy's success rate drops significantly.
   * Maintains a rolling window of recent outcomes per strategy
   * and compares current rate against historical baseline.
   */
  private detectRegression(exp: ExecutionExperience): void {
    const histKey = `${exp.strategyUsed}::${exp.modelUsed}`;
    if (!this.successRateHistory.has(histKey)) {
      if (this.successRateHistory.size >= MetaLearner.MAX_SUCCESS_RATE_ENTRIES) {
        const oldest = this.successRateHistory.keys().next().value;
        if (oldest) this.successRateHistory.delete(oldest);
      }
      this.successRateHistory.set(histKey, []);
    }
    const history = this.successRateHistory.get(histKey)!;
    history.push(exp.success ? 1 : 0);

    // Keep last 20 outcomes for the rolling window
    if (history.length > 20) history.shift();

    // Need at least 5 data points and a prior comparison window
    if (history.length < 10) return;

    const recentWindow = Math.min(5, Math.floor(history.length / 2));
    const recent = history.slice(-recentWindow);
    const prior = history.slice(0, history.length - recentWindow);

    const recentRate = recent.reduce((s, v) => s + v, 0) / recent.length;
    const priorRate = prior.reduce((s, v) => s + v, 0) / prior.length;

    if (priorRate > 0 && recentRate < priorRate * (1 - this.config.regressionThreshold)) {
      const dropRatio = priorRate > 0 ? (priorRate - recentRate) / priorRate : 0;
      if (dropRatio >= this.config.regressionThreshold) {
        const event: RegressionEvent = {
          strategyName: exp.strategyUsed,
          modelId: exp.modelUsed,
          taskType: exp.taskType,
          previousSuccessRate: priorRate,
          currentSuccessRate: recentRate,
          dropRatio,
          triggeredAt: new Date().toISOString(),
          autoReverted: false,
        };
        this.regressionEvents.push(event);
        if (this.regressionEvents.length > 200) this.regressionEvents.shift();

        const bus = getMessageBus();
        bus.publish('system.alert', 'meta-learner', {
          type: 'regression_detected',
          strategy: exp.strategyUsed,
          modelId: exp.modelUsed,
          dropRatio,
          priorRate,
          recentRate,
        });
      }
    }
  }

  getRegressionEvents(limit = 20): RegressionEvent[] {
    return this.regressionEvents.slice(-limit);
  }

  // ========================================================================
  // Strategy Performance Tracking
  // ========================================================================

  private updateStrategyPerformance(exp: ExecutionExperience): void {
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
    existing.avgDurationMs = (existing.avgDurationMs * existing.totalRuns + exp.durationMs) / totalRuns;
    existing.avgTokenCost = (existing.avgTokenCost * existing.totalRuns + exp.tokenCost) / totalRuns;
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

    if (!existing.bestForTaskTypes.includes(exp.taskType) && existing.bestForTaskTypes.length < 20) {
      existing.bestForTaskTypes.push(exp.taskType);
    }

    this.strategyPerformance.set(exp.strategyUsed, existing);
  }

  // ========================================================================
  // Optimization Suggestions (with Reflexion-enhanced analysis)
  // ========================================================================

  getSuggestions(): OptimizationSuggestion[] {
    const suggestions: OptimizationSuggestion[] = [];
    const modelPerformance = this.analyzeModelPerformance();
    const strategyRanking = this.rankStrategies();

    for (const [modelId, stats] of modelPerformance) {
      if (stats.totalRuns >= this.minSamplesForSuggestion) {
        if (stats.successRate < 0.5 && stats.avgTokens > 10000) {
          const relevantReflections = this.reflections
            .filter(r => r.includes(modelId))
            .slice(0, 2);

          suggestions.push({
            type: 'model_tier_change',
            target: modelId,
            from: modelId,
            to: this.suggestUpgradeModel(modelId),
            confidence: Math.round((1 - stats.successRate) * 100) / 100,
            evidence: [
              `success_rate: ${(stats.successRate * 100).toFixed(0)}% over ${stats.totalRuns} runs`,
              `avg_tokens: ${Math.round(stats.avgTokens)}`,
              ...(relevantReflections.length > 0 ? [`reflections: ${relevantReflections.length} available`] : []),
            ],
            impact: 'high',
          });
        }
      }
    }

    if (strategyRanking.length > 1 && strategyRanking[0].successRate < 0.6) {
      suggestions.push({
        type: 'strategy_change',
        target: 'default_strategy',
        from: strategyRanking[0].strategyName,
        to: strategyRanking[1].strategyName,
        confidence: Math.round(strategyRanking[1].successRate * 100) / 100,
        evidence: [
          `top: ${strategyRanking[0].strategyName} (${(strategyRanking[0].successRate * 100).toFixed(0)}%)`,
          `alternative: ${strategyRanking[1].strategyName} (${(strategyRanking[1].successRate * 100).toFixed(0)}%)`,
        ],
        impact: 'medium',
      });
    }

    // Cross-model: per-model strategy suggestions
    if (this.config.enableCrossModelMemory) {
      for (const [modelId, modelMap] of this.perModelPriors) {
        const entries = Array.from(modelMap.entries())
          .map(([strategy, prior]) => ({ strategy, score: prior.mean, trials: prior.totalTrials }))
          .sort((a, b) => b.score - a.score);

        if (entries.length >= 2 && entries[0].score < 0.6 && entries[0].trials >= this.minSamplesForSuggestion) {
          suggestions.push({
            type: 'strategy_change',
            target: modelId,
            from: entries[0].strategy,
            to: entries[1].strategy,
            confidence: Math.round(entries[1].score * 100) / 100,
            evidence: [
              `model: ${modelId}`,
              `top: ${entries[0].strategy} (${(entries[0].score * 100).toFixed(0)}%)`,
              `alternative: ${entries[1].strategy} (${(entries[1].score * 100).toFixed(0)}%)`,
            ],
            impact: 'medium',
          });
        }
      }
    }

    // Regression-based: flag strategies with recent drops
    const recentRegressions = this.regressionEvents.slice(-5);
    for (const re of recentRegressions) {
      suggestions.push({
        type: 'strategy_change',
        target: re.strategyName,
        from: re.strategyName,
        to: '(revert)',
        confidence: Math.min(1, re.dropRatio),
        evidence: [
          `regression on ${re.modelId}`,
          `prior rate: ${(re.previousSuccessRate * 100).toFixed(0)}%`,
          `current rate: ${(re.currentSuccessRate * 100).toFixed(0)}%`,
          `drop: ${(re.dropRatio * 100).toFixed(0)}%`,
        ],
        impact: 'high',
      });
    }

    return suggestions;
  }

  // ========================================================================
  // Query Methods
  // ========================================================================

  getStrategyPerformance(): Map<string, StrategyPerformance> {
    return new Map(this.strategyPerformance);
  }

  getExperiences(taskType?: string): ExecutionExperience[] {
    if (taskType) {
      return this.experiences.filter(e => e.taskType === taskType);
    }
    return [...this.experiences];
  }

  getReflections(limit = 10): string[] {
    return this.reflections.slice(-limit);
  }

  /**
   * Update the meta-learner config at runtime.
   * Allows switching analysisMode (light/balanced/thorough) and toggling features.
   */
  setConfig(partial: Partial<MetaLearnerConfig>): void {
    this.config = { ...this.config, ...partial };
    this.persist();
  }

  getConfig(): MetaLearnerConfig {
    return { ...this.config };
  }

  getStats(): {
    totalExperiences: number;
    trackedStrategies: number;
    avgSuccessRate: number;
    topStrategies: StrategyPerformance[];
    totalReflections: number;
  } {
    const strategies = Array.from(this.strategyPerformance.values());
    const avgSuccessRate = strategies.length > 0
      ? strategies.reduce((s, sp) => s + sp.successRate, 0) / strategies.length
      : 0;

    return {
      totalExperiences: this.experiences.length,
      trackedStrategies: strategies.length,
      avgSuccessRate,
      topStrategies: strategies.sort((a, b) => b.successRate - a.successRate).slice(0, 5),
      totalReflections: this.reflections.length,
    };
  }

  private analyzeModelPerformance(): Map<string, { totalRuns: number; successRate: number; avgTokens: number }> {
    const modelMap = new Map<string, { totalRuns: number; successCount: number; totalTokens: number }>();

    for (const exp of this.experiences) {
      const entry = modelMap.get(exp.modelUsed) ?? { totalRuns: 0, successCount: 0, totalTokens: 0 };
      entry.totalRuns++;
      if (exp.success) entry.successCount++;
      entry.totalTokens += exp.tokenCost;
      modelMap.set(exp.modelUsed, entry);
    }

    const result = new Map<string, { totalRuns: number; successRate: number; avgTokens: number }>();
    for (const [modelId, data] of modelMap) {
      result.set(modelId, {
        totalRuns: data.totalRuns,
        successRate: data.successCount / data.totalRuns,
        avgTokens: data.totalTokens / data.totalRuns,
      });
    }
    return result;
  }

  private rankStrategies(): StrategyPerformance[] {
    return Array.from(this.strategyPerformance.values())
      .sort((a, b) => {
        // Composite ranking: 70% success rate + 15% speed + 15% cost efficiency
        const scoreA = a.successRate * 0.7 + this.speedScore(a) * 0.15 + this.costScore(a) * 0.15;
        const scoreB = b.successRate * 0.7 + this.speedScore(b) * 0.15 + this.costScore(b) * 0.15;
        return scoreB - scoreA;
      });
  }

  /** Normalize strategy speed to [0, 1] where 1 = fastest. */
  private speedScore(perf: StrategyPerformance): number {
    if (perf.totalRuns < 3 || perf.p95DurationMs <= 0) return 0.5; // neutral when insufficient data
    const allP95 = Array.from(this.strategyPerformance.values())
      .filter(p => p.totalRuns >= 3 && p.p95DurationMs > 0)
      .map(p => p.p95DurationMs);
    if (allP95.length < 2) return 0.5;
    const min = Math.min(...allP95);
    const max = Math.max(...allP95);
    if (max === min) return 0.5;
    // Invert: lower duration = higher score
    return 1.0 - (perf.p95DurationMs - min) / (max - min);
  }

  /** Normalize strategy cost to [0, 1] where 1 = cheapest. */
  private costScore(perf: StrategyPerformance): number {
    if (perf.totalRuns < 3 || perf.avgTokenCost <= 0) return 0.5;
    const allCosts = Array.from(this.strategyPerformance.values())
      .filter(p => p.totalRuns >= 3 && p.avgTokenCost > 0)
      .map(p => p.avgTokenCost);
    if (allCosts.length < 2) return 0.5;
    const min = Math.min(...allCosts);
    const max = Math.max(...allCosts);
    if (max === min) return 0.5;
    // Invert: lower cost = higher score
    return 1.0 - (perf.avgTokenCost - min) / (max - min);
  }

  private recommendBestStrategy(): string {
    const ranked = this.rankStrategies();
    return ranked.length > 0 ? ranked[0].strategyName : 'SEQUENTIAL';
  }

  private suggestUpgradeModel(currentModelId: string): string {
    const upgrades: Record<string, string> = {
      // Claude family
      'claude-haiku-4-5': 'claude-sonnet-4-6',
      'claude-sonnet-4-6': 'claude-opus-4-8',
      'claude-3-5-haiku': 'claude-sonnet-4-6',
      'claude-3-5-sonnet': 'claude-opus-4-8',
      'claude-3-opus': 'claude-opus-4-8',
      // GPT family
      'gpt-4o-mini': 'gpt-4o',
      'gpt-4o': 'gpt-5',
      // Gemini family
      'gemini-2-flash': 'gemini-2-pro',
      'gemini-2.5-flash': 'gemini-2.5-pro',
      // Mimo family
      'mimo-v2.5-pro': 'claude-sonnet-4-6',
    };
    return upgrades[currentModelId] ?? 'claude-sonnet-4-6';
  }

  // ========================================================================
  // Persistence — cross-session learning
  // ========================================================================

  private persist(): void {
    if (!this.persistPath) return;
    try {
      const dir = nodePath.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Serialize Thompson priors (Beta distributions as alpha/beta pairs)
      const serializedPriors: Record<string, Array<{ alpha: number; beta: number }>> = {};
      for (const [taskType, distributions] of this.thompsonPriors) {
        serializedPriors[taskType] = distributions.map(d => ({ alpha: d.alpha, beta: d.beta }));
      }

      // Serialize cross-model priors
      const serializedCrossModel: Record<string, Record<string, { alpha: number; beta: number }>> = {};
      for (const [modelId, modelMap] of this.perModelPriors) {
        serializedCrossModel[modelId] = {};
        for (const [strategy, dist] of modelMap) {
          serializedCrossModel[modelId][strategy] = { alpha: dist.alpha, beta: dist.beta };
        }
      }

      const data = {
        experiences: this.experiences,
        reflections: this.reflections.slice(-200),
        strategyPerformance: Array.from(this.strategyPerformance.entries()),
        thompsonPriors: serializedPriors,
        predictions: this.predictions,
        verdicts: this.verdicts,
        regressionEvents: this.regressionEvents,
        successRateHistory: Array.from(this.successRateHistory.entries()),
        crossModelPriors: serializedCrossModel,
        config: this.config,
      };

      const tmpPath = this.persistPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.persistPath);
    } catch (e) {
      getGlobalLogger().warn('MetaLearner', 'Persistence failed (best-effort)', { error: (e as Error)?.message });
    }
  }

  private load(): void {
    if (!this.persistPath) return;
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw);

      if (Array.isArray(data.experiences)) this.experiences = data.experiences;
      if (Array.isArray(data.reflections)) this.reflections = data.reflections;

      if (Array.isArray(data.strategyPerformance)) {
        for (const [key, val] of data.strategyPerformance) {
          this.strategyPerformance.set(key, val);
        }
      }

      if (data.thompsonPriors && typeof data.thompsonPriors === 'object') {
        for (const [taskType, dists] of Object.entries(data.thompsonPriors)) {
          const priors = (dists as Array<{ alpha: number; beta: number }>).map(
            d => new BetaDistribution(d.alpha, d.beta)
          );
          this.thompsonPriors.set(taskType, priors);
        }
      }

      // Restore cross-model priors
      if (data.crossModelPriors && typeof data.crossModelPriors === 'object') {
        for (const [modelId, strategies] of Object.entries(data.crossModelPriors)) {
          const modelMap = new Map<string, BetaDistribution>();
          for (const [strategy, d] of Object.entries(strategies as Record<string, { alpha: number; beta: number }>)) {
            modelMap.set(strategy, new BetaDistribution(d.alpha, d.beta));
          }
          this.perModelPriors.set(modelId, modelMap);
        }
      }

      if (Array.isArray(data.predictions)) this.predictions = data.predictions;
      if (Array.isArray(data.verdicts)) this.verdicts = data.verdicts;
      if (Array.isArray(data.regressionEvents)) this.regressionEvents = data.regressionEvents;
      if (Array.isArray(data.successRateHistory)) {
        for (const [key, vals] of data.successRateHistory) {
          this.successRateHistory.set(key, vals);
        }
      }
      if (data.config && typeof data.config === 'object') {
        this.config = { ...this.config, ...data.config };
      }
    } catch (e) {
      getGlobalLogger().warn('MetaLearner', 'Load failed (best-effort)', { error: (e as Error)?.message });
    }
  }
}

import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

let _metaLearnerPath: string | undefined;

const metaLearnerSingleton = createTenantAwareSingleton(() =>
  new MetaLearner(500, 5, _metaLearnerPath ?? nodePath.join(process.cwd(), '.commander_memory', 'meta-learner.json')),
);

export function getMetaLearner(persistPath?: string): MetaLearner {
  if (persistPath) _metaLearnerPath = persistPath;
  return metaLearnerSingleton.get();
}

export function resetMetaLearner(): void {
  metaLearnerSingleton.reset();
}

export function clearMetaLearnerState(): void {
  const learner = metaLearnerSingleton.getGlobal();
  learner['experiences'] = [];
  learner['reflections'] = [];
  learner['strategyPerformance'].clear();
  learner['thompsonPriors'].clear();
  learner['predictions'] = [];
  learner['verdicts'] = [];
  learner['regressionEvents'] = [];
  learner['perModelPriors'].clear();
  learner['successRateHistory'].clear();
}
