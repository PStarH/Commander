import type { MetaLearnerConfig } from '../runtime/types';

// StrategyName is the self-evolution meta-learner vocabulary (Thompson
// sampling candidates). Distinct from OrchestrationTopology (the agent
// coordination pattern taxonomy). The D3.2 enum consolidation targets
// OrchestrationTopology only — STRATEGY_NAMES stays at 5 entries so the
// adaptive orchestrator's Bayesian prior + bandit convergence logic remain
// untouched. Verified via baseline ripple test (port-research, June 2026),
// each name has ≥1 production caller in src/ outside of this module:
//   SEQUENTIAL  → adaptiveOrchestrator, taskComplexityAnalyzer, metaLearner, telos
//   PARALLEL    → adaptiveOrchestrator, taskComplexityAnalyzer, metaLearner, telos
//   HANDOFF     → taskComplexityAnalyzer (returned as 'HANDOFF' on deep dependency graphs)
//   MAGENTIC    → metaLearnerBridge (baseline prior for Magentic-One style debates)
//   CONSENSUS   → taskComplexityAnalyzer (multi-judge consensus reducer)
export const STRATEGY_NAMES = [
  'SEQUENTIAL',
  'PARALLEL',
  'HANDOFF',
  'MAGENTIC',
  'CONSENSUS',
] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

export const DEFAULT_META_LEARNER_CONFIG: MetaLearnerConfig = {
  analysisMode: 'light',
  enablePredictionLoop: true,
  enableRegressionGate: true,
  enableCrossModelMemory: true,
  regressionThreshold: 0.15,
  enabled: true,
  minRunsBeforeLearning: 50,
  reflectionFrequency: 10,
};
