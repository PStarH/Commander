import * as fs from 'fs';
import * as nodePath from 'path';
import type {
  ExecutionExperience,
  OptimizationSuggestion,
  StrategyPerformance,
} from '../runtime/types';
import { getMessageBus } from '../runtime/messageBus';

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

  constructor(maxExperiences = 500, minSamplesForSuggestion = 5, persistPath?: string) {
    this.maxExperiences = maxExperiences;
    this.minSamplesForSuggestion = minSamplesForSuggestion;
    this.persistPath = persistPath ?? null;
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
   * This explores (tries untested strategies) while exploiting (prefers proven ones).
   */
  selectStrategy(taskType: string): string {
    const priors = this.getOrCreatePriors(taskType);
    const samples = priors.map(p => p.sample());
    const bestIdx = samples.indexOf(Math.max(...samples));
    return STRATEGY_NAMES[bestIdx];
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

      const data = {
        experiences: this.experiences,
        reflections: this.reflections.slice(-200),
        strategyPerformance: Array.from(this.strategyPerformance.entries()),
        thompsonPriors: serializedPriors,
      };

      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Persistence is best-effort
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
    } catch {
      // Load is best-effort
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
