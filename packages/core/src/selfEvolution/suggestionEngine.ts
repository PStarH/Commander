import type {
  ExecutionExperience,
  OptimizationSuggestion,
  PerModelStrategyStats,
  RegressionEvent,
  StrategyPerformance,
} from '../runtime/types';

export interface SuggestionContext {
  modelPerformance: Map<string, { totalRuns: number; successRate: number; avgTokens: number }>;
  strategyRanking: StrategyPerformance[];
  perModelPriors: Map<string, Map<string, { mean: number; totalTrials: number }>>;
  regressionEvents: RegressionEvent[];
  reflections: string[];
  minSamplesForSuggestion: number;
  enableCrossModelMemory: boolean;
}

export function generateSuggestions(context: SuggestionContext): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];
  const {
    modelPerformance,
    strategyRanking,
    perModelPriors,
    regressionEvents,
    reflections,
    minSamplesForSuggestion,
    enableCrossModelMemory,
  } = context;

  for (const [modelId, stats] of modelPerformance) {
    if (stats.totalRuns >= minSamplesForSuggestion) {
      if (stats.successRate < 0.5 && stats.avgTokens > 10000) {
        const relevantReflections = reflections
          .filter(r => r.includes(modelId))
          .slice(0, 2);

        suggestions.push({
          type: 'model_tier_change',
          target: modelId,
          from: modelId,
          to: suggestUpgradeModel(modelId),
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
  if (enableCrossModelMemory) {
    for (const [modelId, modelMap] of perModelPriors) {
      const entries = Array.from(modelMap.entries())
        .map(([strategy, prior]) => ({ strategy, score: prior.mean, trials: prior.totalTrials }))
        .sort((a, b) => b.score - a.score);

      if (entries.length >= 2 && entries[0].score < 0.6 && entries[0].trials >= minSamplesForSuggestion) {
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
  const recentRegressions = regressionEvents.slice(-5);
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

export function suggestUpgradeModel(currentModelId: string): string {
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
