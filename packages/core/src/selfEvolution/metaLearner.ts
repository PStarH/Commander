import { reportSilentFailure } from '../silentFailureReporter';
import * as nodePath from 'node:path';
import type {
  EvolutionPrediction,
  ExecutionExperience,
  FailureCategory,
  MetaLearnerConfig,
  OptimizationSuggestion,
  PredictionVerdict,
  PerModelStrategyStats,
  RegressionEvent,
  ShadowComparison,
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
  private shadowComparisons: ShadowComparison[] = [];

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

    if (!this.config.enabled) {
      this.persist();
      getMetricsCollector().recordMetaLearnerExperienceCount(this.experiences.length);
      return;
    }

    const hasEnoughRuns = this.experiences.length >= this.config.minRunsBeforeLearning;

    if (hasEnoughRuns) {
      this.perfTracker.recordExperience(exp);
      this.selector.recordExperience(exp);

      if (this.config.enableCrossModelMemory) {
        this.crossModel.recordExperience(exp);
      }

      if (this.config.enablePredictionLoop) {
        this.predictionLoop.recordExperience(exp);
      }

      if (this.config.enableRegressionGate) {
        this.regressionGate.recordExperience(exp);
      }
    }

    if (this.experiences.length % this.config.reflectionFrequency === 0) {
      const reflection = generateReflection(exp);
      this.reflections.push(reflection);
      if (this.reflections.length > 200) {
        this.reflections.shift();
      }

      try {
        getMetricsCollector().recordMetaLearnerReflection(exp.strategyUsed, exp.success);
      } catch (err) {
        reportSilentFailure(err, 'metaLearner:111');
        /* best-effort */
      }

      const bus = getMessageBus();
      bus.publish('memory.written', 'meta-learner', {
        type: 'execution_experience',
        runId: exp.runId,
        success: exp.success,
        strategy: exp.strategyUsed,
        reflection: reflection.slice(0, 200),
      });
    }

    this.persist();
    getMetricsCollector().recordMetaLearnerExperienceCount(this.experiences.length);
  }

  // ========================================================================
  // Strategy Selection
  // ========================================================================

  selectStrategy(taskType: string, modelId?: string): string {
    if (!this.config.enabled) {
      return 'SEQUENTIAL';
    }

    const hasEnoughRuns = this.experiences.length >= this.config.minRunsBeforeLearning;
    if (!hasEnoughRuns) {
      return 'SEQUENTIAL';
    }

    const chosen = this.selector.selectStrategy(
      taskType,
      this.perfTracker.getStrategyPerformance(),
      modelId,
    );

    try {
      getMetricsCollector().recordMetaLearnerStrategySelection(chosen, taskType, modelId);
    } catch (err) {
      reportSilentFailure(err, 'metaLearner:152');
      /* best-effort */
    }

    if (this.config.enablePredictionLoop && modelId) {
      const key = `${modelId}::${taskType}`;
      this.predictionLoop.getLastPredictedStrategy().set(key, chosen);
    }

    return chosen;
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

  getShadowComparisons(limit = 10): ShadowComparison[] {
    return this.shadowComparisons.slice(-limit);
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
    learningActive: boolean;
    runsUntilLearning: number;
  } {
    const strategies = Array.from(this.perfTracker.getStrategyPerformance().values());
    const avgSuccessRate =
      strategies.length > 0
        ? strategies.reduce((s, sp) => s + sp.successRate, 0) / strategies.length
        : 0;

    const learningActive =
      this.config.enabled && this.experiences.length >= this.config.minRunsBeforeLearning;
    const runsUntilLearning = Math.max(
      0,
      this.config.minRunsBeforeLearning - this.experiences.length,
    );

    return {
      totalExperiences: this.experiences.length,
      trackedStrategies: strategies.length,
      avgSuccessRate,
      topStrategies: strategies.sort((a, b) => b.successRate - a.successRate).slice(0, 5),
      totalReflections: this.reflections.length,
      learningActive,
      runsUntilLearning,
    };
  }

  getConvergenceMetrics(): {
    taskTypes: number;
    strategiesPerType: number;
    avgSamplesPerStrategy: number;
    converged: boolean;
    learningCurve: Array<{ taskType: string; improvementRate: number }>;
  } {
    const strategyPerformance = this.perfTracker.getStrategyPerformance();
    const taskTypes = new Set<string>();
    let totalStrategies = 0;
    let totalSamples = 0;

    for (const [key, perf] of strategyPerformance) {
      const taskType = key.split('::')[1] ?? 'unknown';
      taskTypes.add(taskType);
      totalStrategies++;
      totalSamples += perf.totalRuns;
    }

    const avgSamplesPerStrategy = totalStrategies > 0 ? totalSamples / totalStrategies : 0;

    const learningCurve: Array<{ taskType: string; improvementRate: number }> = [];
    for (const taskType of taskTypes) {
      const taskExperiences = this.experiences.filter((e) => e.taskType === taskType);
      if (taskExperiences.length >= 10) {
        const firstHalf = taskExperiences.slice(0, Math.floor(taskExperiences.length / 2));
        const secondHalf = taskExperiences.slice(Math.floor(taskExperiences.length / 2));
        const firstSuccessRate = firstHalf.filter((e) => e.success).length / firstHalf.length;
        const secondSuccessRate = secondHalf.filter((e) => e.success).length / secondHalf.length;
        const improvementRate = secondSuccessRate - firstSuccessRate;
        learningCurve.push({ taskType, improvementRate });
      }
    }

    const converged =
      avgSamplesPerStrategy >= 50 &&
      learningCurve.every((lc) => Math.abs(lc.improvementRate) < 0.1);

    return {
      taskTypes: taskTypes.size,
      strategiesPerType: totalStrategies > 0 ? Math.round(totalStrategies / taskTypes.size) : 0,
      avgSamplesPerStrategy: Math.round(avgSamplesPerStrategy),
      converged,
      learningCurve,
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
  const learner = metaLearnerSingleton.get();
  learner['experiences'] = [];
  learner['reflections'] = [];
  learner['shadowComparisons'] = [];
  learner['config'] = { ...DEFAULT_META_LEARNER_CONFIG, minRunsBeforeLearning: 0, enabled: true };
  learner['perfTracker'] = new StrategyPerformanceTracker();
  learner['selector'] = new StrategySelector();
  learner['crossModel'] = new CrossModelMemory();
  learner['predictionLoop'] = new PredictionLoop(learner['config'].enablePredictionLoop);
  learner['regressionGate'] = new RegressionGate(learner['config'].regressionThreshold);
}

export { DEFAULT_META_LEARNER_CONFIG } from './strategyConstants';
