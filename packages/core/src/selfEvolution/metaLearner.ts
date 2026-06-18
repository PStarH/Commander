import * as nodePath from 'path';
import type {
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
import { getMetricsCollector } from '../runtime/metricsCollector';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';

import { BetaDistribution } from './betaDistribution';
import { generateReflection } from './reflection';
import { DEFAULT_META_LEARNER_CONFIG } from './strategyConstants';
import { StrategySelector } from './strategySelector';
import { CrossModelMemory } from './crossModelMemory';
import { PredictionLoop } from './predictionLoop';
import { RegressionGate } from './regressionGate';
import { StrategyPerformanceTracker } from './strategyPerformanceTracker';
import { generateSuggestions, type SuggestionContext } from './suggestionEngine';
import { persist, load } from './metaLearnerPersistence';

// ============================================================================
// MetaLearner — facade over focused sub-modules
// ============================================================================

export class MetaLearner {
  private experiences: ExecutionExperience[] = [];
  private reflections: string[] = [];
  private maxExperiences: number;
  private minSamplesForSuggestion: number;
  private persistPath: string | null;
  private config: MetaLearnerConfig;
  private shadowComparisons: Array<{
    runId: string;
    taskType: string;
    mainStrategy: string;
    shadowStrategy: string;
    mainSuccess: boolean;
    shadowSuccess: boolean;
    mainDurationMs: number;
    shadowDurationMs: number;
    timestamp: string;
  }> = [];

  // Sub-module instances
  private selector = new StrategySelector();
  private crossModel = new CrossModelMemory();
  private predictionLoop: PredictionLoop;
  private regressionGate: RegressionGate;
  private perfTracker = new StrategyPerformanceTracker();

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
    this.predictionLoop = new PredictionLoop(this.config.enablePredictionLoop);
    this.regressionGate = new RegressionGate(this.config.regressionThreshold);
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

    this.perfTracker.recordExperience(exp);
    this.selector.recordExperience(exp);

    // Cross-model: update per-model priors
    if (this.config.enableCrossModelMemory) {
      this.crossModel.recordExperience(exp);
    }

    // Prediction loop: verify outstanding predictions for this model+taskType
    if (this.config.enablePredictionLoop) {
      this.predictionLoop.recordExperience(exp);
    }

    // Regression gate: check for significant success rate drops
    if (this.config.enableRegressionGate) {
      this.regressionGate.recordExperience(exp);
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

    // Update experience count gauge
    getMetricsCollector().recordMetaLearnerExperienceCount(this.experiences.length);
  }

  // ========================================================================
  // Strategy Selection
  // ========================================================================

  selectStrategy(taskType: string, modelId?: string): string {
    const chosen = this.selector.selectStrategy(
      taskType,
      this.perfTracker.getStrategyPerformance(),
      modelId,
    );

    if (this.config.enablePredictionLoop && modelId) {
      const key = `${modelId}::${taskType}`;
      this.predictionLoop.getLastPredictedStrategy().set(key, chosen);
    }

    return chosen;
  }

  /**
   * Select the runner-up (second-best) strategy for shadow mode comparison.
   */
  selectShadowStrategy(taskType: string): string | null {
    return this.selector.selectShadowStrategy(taskType, this.perfTracker.getStrategyPerformance());
  }

  /**
   * Record a shadow comparison result.
   */
  recordShadowComparison(params: {
    runId: string;
    taskType: string;
    mainStrategy: string;
    shadowStrategy: string;
    mainSuccess: boolean;
    shadowSuccess: boolean;
    mainDurationMs: number;
    shadowDurationMs: number;
  }): void {
    this.shadowComparisons.push({
      ...params,
      timestamp: new Date().toISOString(),
    });
    if (this.shadowComparisons.length > 200) this.shadowComparisons.shift();

    this.selector.recordShadowComparison({
      taskType: params.taskType,
      shadowStrategy: params.shadowStrategy,
      shadowSuccess: params.shadowSuccess,
    });
  }

  /**
   * Get recent shadow mode comparisons.
   */
  getShadowComparisons(limit = 10): Array<{
    runId: string;
    taskType: string;
    mainStrategy: string;
    shadowStrategy: string;
    mainSuccess: boolean;
    shadowSuccess: boolean;
    mainDurationMs: number;
    shadowDurationMs: number;
    timestamp: string;
  }> {
    return this.shadowComparisons.slice(-limit);
  }

  // ========================================================================
  // Query Methods
  // ========================================================================

  getStrategyScores(taskType: string): Array<{
    strategy: string;
    score: number;
    trials: number;
    avgDurationMs?: number;
    p95DurationMs?: number;
  }> {
    return this.selector.getStrategyScores(taskType, this.perfTracker.getStrategyPerformance());
  }

  /**
   * Calculate adjusted scores for all strategies on a task type.
   * Mirrors the scoring used by selectStrategy/selectShadowStrategy.
   */
  calculateAdjustedScores(taskType: string): Array<{
    name: string;
    score: number;
    trials: number;
    avgDurationMs?: number;
    p95DurationMs?: number;
  }> {
    return this.selector
      .getStrategyScores(taskType, this.perfTracker.getStrategyPerformance())
      .map((s) => ({
        name: s.strategy,
        score: s.score,
        trials: s.trials,
        avgDurationMs: s.avgDurationMs,
        p95DurationMs: s.p95DurationMs,
      }));
  }

  getTrackedTaskTypes(): string[] {
    return this.selector.getTrackedTaskTypes();
  }

  getStrategyScoresForModel(modelId: string): Array<{
    strategy: string;
    score: number;
    trials: number;
    avgDurationMs?: number;
    p95DurationMs?: number;
  }> {
    return this.crossModel.getStrategyScoresForModel(
      modelId,
      this.perfTracker.getStrategyPerformance(),
    );
  }

  getPerModelStats(): PerModelStrategyStats[] {
    return this.crossModel.getPerModelStats();
  }

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
    return this.predictionLoop.createPrediction(
      editId,
      description,
      targetStrategy,
      sourceStrategy,
      modelId,
      taskTypes,
      predictedFixes,
      predictedRegressions,
    );
  }

  getPredictions(): EvolutionPrediction[] {
    return this.predictionLoop.getPredictions();
  }

  getVerdicts(): PredictionVerdict[] {
    return this.predictionLoop.getVerdicts();
  }

  getRegressionEvents(limit = 20): RegressionEvent[] {
    return this.regressionGate.getRegressionEvents(limit);
  }

  getStrategyPerformance(): Map<string, StrategyPerformance> {
    return this.perfTracker.getStrategyPerformance();
  }

  getExperiences(taskType?: string): ExecutionExperience[] {
    if (taskType) {
      return this.experiences.filter((e) => e.taskType === taskType);
    }
    return [...this.experiences];
  }

  getReflections(limit = 10): string[] {
    return this.reflections.slice(-limit);
  }

  getSuggestions(): OptimizationSuggestion[] {
    const modelPerformance = this.analyzeModelPerformance();
    const strategyRanking = this.perfTracker.rankStrategies();

    // Build per-model priors map for the suggestion engine
    const perModelPriors = new Map<string, Map<string, { mean: number; totalTrials: number }>>();
    for (const [modelId, modelMap] of this.crossModel.getPerModelPriors()) {
      const priorsMap = new Map<string, { mean: number; totalTrials: number }>();
      for (const [strategy, prior] of modelMap) {
        priorsMap.set(strategy, { mean: prior.mean, totalTrials: prior.totalTrials });
      }
      perModelPriors.set(modelId, priorsMap);
    }

    const context: SuggestionContext = {
      modelPerformance,
      strategyRanking,
      perModelPriors,
      regressionEvents: this.regressionGate.getRegressionEventsList(),
      reflections: this.reflections,
      minSamplesForSuggestion: this.minSamplesForSuggestion,
      enableCrossModelMemory: this.config.enableCrossModelMemory,
    };

    return generateSuggestions(context);
  }

  setConfig(partial: Partial<MetaLearnerConfig>): void {
    this.config = { ...this.config, ...partial };
    this.predictionLoop = new PredictionLoop(this.config.enablePredictionLoop);
    this.regressionGate = new RegressionGate(this.config.regressionThreshold);
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
    const strategies = Array.from(this.perfTracker.getStrategyPerformance().values());
    const avgSuccessRate =
      strategies.length > 0
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

  // ========================================================================
  // Private helpers
  // ========================================================================

  private analyzeModelPerformance(): Map<
    string,
    { totalRuns: number; successRate: number; avgTokens: number }
  > {
    const modelMap = new Map<
      string,
      { totalRuns: number; successCount: number; totalTokens: number }
    >();

    for (const exp of this.experiences) {
      const entry = modelMap.get(exp.modelUsed) ?? {
        totalRuns: 0,
        successCount: 0,
        totalTokens: 0,
      };
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

  // ========================================================================
  // Persistence
  // ========================================================================

  private persist(): void {
    const state = {
      experiences: this.experiences,
      reflections: this.reflections.slice(-200),
      strategyPerformance: this.perfTracker.getStrategyPerformance(),
      thompsonPriors: this.selector.getThompsonPriors(),
      predictions: this.predictionLoop.getPredictions(),
      verdicts: this.predictionLoop.getVerdicts(),
      regressionEvents: this.regressionGate.getRegressionEventsList(),
      successRateHistory: this.regressionGate.getSuccessRateHistory(),
      perModelPriors: this.crossModel.getPerModelPriors(),
      config: this.config,
    };
    persist(state, this.persistPath);
  }

  private load(): void {
    const state = {
      experiences: this.experiences,
      reflections: this.reflections,
      strategyPerformance: new Map<string, StrategyPerformance>(),
      thompsonPriors: new Map<string, BetaDistribution[]>(),
      predictions: [] as EvolutionPrediction[],
      verdicts: [] as PredictionVerdict[],
      regressionEvents: [] as RegressionEvent[],
      successRateHistory: new Map<string, number[]>(),
      perModelPriors: new Map<string, Map<string, BetaDistribution>>(),
      config: this.config,
    };
    load(state, this.persistPath);

    // Sync loaded state into sub-modules
    this.experiences = state.experiences;
    this.reflections = state.reflections;
    this.config = state.config;
    this.perfTracker.setStrategyPerformance(state.strategyPerformance);
    this.selector.setThompsonPriors(state.thompsonPriors);
    this.predictionLoop.setPredictions(state.predictions);
    this.predictionLoop.setVerdicts(state.verdicts);
    this.regressionGate.setRegressionEvents(state.regressionEvents);
    this.regressionGate.setSuccessRateHistory(state.successRateHistory);
    this.crossModel.setPerModelPriors(state.perModelPriors);
  }
}

// ============================================================================
// Singleton helpers
// ============================================================================

let _metaLearnerPath: string | undefined;

const metaLearnerSingleton = createTenantAwareSingleton(
  () =>
    new MetaLearner(
      500,
      5,
      _metaLearnerPath ?? nodePath.join(process.cwd(), '.commander_memory', 'meta-learner.json'),
    ),
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
  learner['shadowComparisons'] = [];
  learner['perfTracker'] = new StrategyPerformanceTracker();
  learner['selector'] = new StrategySelector();
  learner['crossModel'] = new CrossModelMemory();
  learner['predictionLoop'] = new PredictionLoop(learner['config']?.enablePredictionLoop ?? true);
  learner['regressionGate'] = new RegressionGate(learner['config']?.regressionThreshold ?? 0.15);
}

export { DEFAULT_META_LEARNER_CONFIG } from './strategyConstants';
