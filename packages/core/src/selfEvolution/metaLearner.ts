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

  sample(): number {
    // Simple approximation using gamma distribution properties
    const alphaSample = this.sampleGamma(this.alpha);
    const betaSample = this.sampleGamma(this.beta);
    return alphaSample / (alphaSample + betaSample);
  }

  private sampleGamma(shape: number): number {
    if (shape < 1) {
      // Small shape correction
      const u = Math.random();
      return Math.pow(u, 1 / shape) * this.sampleGamma(shape + 1);
    }
    // Marsaglia & Tsang method for gamma sampling
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x = 0;
      let v = 1;
      for (let i = 0; i < 12; i++) {
        x += Math.random();
      }
      x = (x - 6) / 6; // Box-Muller approximation
      v = Math.pow(1 + c * x, 3);
      if (v > 0 && Math.log(Math.random()) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
        return d * v;
      }
    }
  }

  update(success: boolean): void {
    if (success) {
      this.alpha += 1;
    } else {
      this.beta += 1;
    }
  }

  get mean(): number {
    return this.alpha / (this.alpha + this.beta);
  }

  get totalTrials(): number {
    return this.alpha + this.beta - 2;
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
   * Select the best strategy for a given task type using Thompson Sampling.
   * If prediction loop is enabled, records the (model, taskType) → strategy mapping
   * so that future strategy changes trigger a prediction.
   */
  selectStrategy(taskType: string, modelId?: string): string {
    const priors = this.getOrCreatePriors(taskType);
    const samples = priors.map(p => p.sample());
    const bestIdx = samples.indexOf(Math.max(...samples));
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
  getStrategyScores(taskType: string): Array<{ strategy: string; score: number; trials: number }> {
    const priors = this.getOrCreatePriors(taskType);
    return STRATEGY_NAMES.map((name, i) => ({
      strategy: name,
      score: priors[i].mean,
      trials: priors[i].totalTrials,
    })).sort((a, b) => b.score - a.score);
  }

  private getOrCreatePriors(taskType: string): BetaDistribution[] {
    if (!this.thompsonPriors.has(taskType)) {
      this.thompsonPriors.set(taskType, STRATEGY_NAMES.map(() => new BetaDistribution()));
    }
    return this.thompsonPriors.get(taskType)!;
  }

  private updateThompsonPrior(exp: ExecutionExperience): void {
    const priors = this.getOrCreatePriors(exp.taskType);
    const idx = STRATEGY_NAMES.indexOf(exp.strategyUsed);
    if (idx >= 0) {
      priors[idx].update(exp.success);
    }
  }

  // ========================================================================
  // Cross-model strategy memory
  // ========================================================================

  private getOrCreatePerModelPriors(modelId: string, strategy: string): BetaDistribution {
    if (!this.perModelPriors.has(modelId)) {
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
  getStrategyScoresForModel(modelId: string): Array<{ strategy: string; score: number; trials: number }> {
    const modelMap = this.perModelPriors.get(modelId);
    if (!modelMap) {
      // No per-model data yet — return empty, caller can fall back to global
      return [];
    }
    return Array.from(modelMap.entries()).map(([strategy, prior]) => ({
      strategy,
      score: prior.mean,
      trials: prior.totalTrials,
    })).sort((a, b) => b.score - a.score);
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

    if (!existing.bestForTaskTypes.includes(exp.taskType)) {
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
      .sort((a, b) => b.successRate - a.successRate);
  }

  private recommendBestStrategy(): string {
    const ranked = this.rankStrategies();
    return ranked.length > 0 ? ranked[0].strategyName : 'SEQUENTIAL';
  }

  private suggestUpgradeModel(currentModelId: string): string {
    const upgrades: Record<string, string> = {
      'claude-3-5-haiku': 'claude-3-5-sonnet',
      'gpt-4o-mini': 'gpt-4o',
      'gemini-2-flash': 'gemini-2-pro',
      'claude-3-5-sonnet': 'claude-3-opus',
      'gpt-4o': 'gpt-5',
    };
    return upgrades[currentModelId] ?? 'claude-3-5-sonnet';
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

let globalLearner: MetaLearner | null = null;

export function getMetaLearner(persistPath?: string): MetaLearner {
  if (!globalLearner) {
    globalLearner = new MetaLearner(500, 5, persistPath ?? nodePath.join(process.cwd(), '.commander_memory', 'meta-learner.json'));
  }
  return globalLearner;
}

export function resetMetaLearner(): void {
  globalLearner = null;
}

export function clearMetaLearnerState(): void {
  if (globalLearner) {
    globalLearner['experiences'] = [];
    globalLearner['reflections'] = [];
    globalLearner['strategyPerformance'].clear();
    globalLearner['thompsonPriors'].clear();
  }
}
