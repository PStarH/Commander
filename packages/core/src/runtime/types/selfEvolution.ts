// ============================================================================
// Self-Evolution Types
// ============================================================================

// ============================================================================
// Self-Evolution: Analysis Mode & Trajectory Debugger
// ============================================================================

/**
 * How aggressively the self-evolution loop analyzes execution trajectories.
 * - light: heuristic keyword matching only, zero extra LLM calls
 * - balanced: heuristic first, LLM fallback for unclassified failures (default)
 * - thorough: LLM analysis for every failure, highest insight cost
 */
export type AnalysisMode = 'light' | 'balanced' | 'thorough';

/**
 * Categorised failure patterns identified by trajectory analysis.
 */
export type FailureCategory =
  | 'tool_misuse'
  | 'context_overflow'
  | 'timeout'
  | 'model_refusal'
  | 'missing_capability'
  | 'planning_error'
  | 'hallucination'
  | 'dependency_failure'
  | 'quality_gate'
  | 'rate_limit'
  | 'authentication'
  | 'resource_exhaustion'
  | 'data_validation'
  | 'unclassified';

/**
 * A recorded experience for the self-evolution engine.
 */
export interface ExecutionExperience {
  id: string;
  runId: string;
  agentId: string;
  missionId?: string;
  taskType: string;
  modelUsed: string;
  strategyUsed: string;
  success: boolean;
  durationMs: number;
  tokenCost: number;
  errorPattern?: string;
  lessons: string[];
  toolsUsed?: string[];
  topology?: string;
  estimatedTokens?: number;
  systemPrompt?: string;
  availableTools?: string[];
  modelTier?: string;
  splitFrom?: string;
  mergedFrom?: string;
  nodeId?: string;
  timestamp: string;
}

/**
 * Optimization suggestion from the meta-learner.
 */
export interface OptimizationSuggestion {
  type: 'model_tier_change' | 'strategy_change' | 'prompt_template_change' | 'tool_change';
  target: string;
  from: string;
  to: string;
  confidence: number;
  evidence: string[];
  impact: 'low' | 'medium' | 'high';
}

/**
 * Meta-learner state tracking what strategies work best.
 */
export interface StrategyPerformance {
  strategyName: string;
  totalRuns: number;
  successCount: number;
  avgDurationMs: number;
  p95DurationMs: number; // 95th percentile duration — tracks tail latency
  avgTokenCost: number;
  successRate: number;
  lastUsed: string;
  bestForTaskTypes: string[];
}

/**
 * A structured insight produced by analysing one execution experience.
 */
export interface EvolutionInsight {
  runId: string;
  taskType: string;
  modelUsed: string;
  strategyUsed: string;
  success: boolean;
  errorPattern?: string;
  failureCategory: FailureCategory;
  /** 0-1 classification confidence */
  confidence: number;
  evidence: string[];
  suggestion?: string;
  /** Tokens consumed by LLM analysis (0 in light mode) */
  analysisTokens: number;
}

// ============================================================================
// Self-Evolution: Falsifiable Prediction Loop
// ============================================================================

/**
 * A prediction made when the evolver changes a strategy or harness component.
 * Every edit becomes a falsifiable contract verified by the next round.
 */
export interface EvolutionPrediction {
  id: string;
  /** Which logical "edit" this prediction belongs to */
  editId: string;
  description: string;
  /** What should improve (failure categories expected to decrease) */
  predictedFixes: FailureCategory[];
  /** What might regress (failure categories to watch) */
  predictedRegressions: FailureCategory[];
  targetStrategy: string;
  sourceStrategy: string;
  modelId: string;
  taskTypes: string[];
  timestamp: string;
}

/** Verdict produced when the next round of experiences arrives. */
export interface PredictionVerdict {
  predictionId: string;
  fixesConfirmed: string[];
  regressionsObserved: string[];
  netImpact: 'positive' | 'neutral' | 'negative';
  reverted: boolean;
  verifiedAt: string;
}

// ============================================================================
// Self-Evolution: Regression Detection Gate
// ============================================================================

/**
 * Fired when a strategy's success rate drops significantly after a change.
 */
export interface RegressionEvent {
  strategyName: string;
  modelId: string;
  taskType: string;
  previousSuccessRate: number;
  currentSuccessRate: number;
  dropRatio: number;
  triggeredAt: string;
  autoReverted: boolean;
}

// ============================================================================
// Self-Evolution: Cross-Model Strategy Memory
// ============================================================================

/**
 * Per-model, per-strategy performance snapshot.
 */
export interface PerModelStrategyStats {
  modelId: string;
  strategy: string;
  totalRuns: number;
  successCount: number;
  successRate: number;
  avgTokenCost: number;
  lastUsed: string;
}

/**
 * Unified config for the extended MetaLearner.
 * All features default ON except LLM analysis (defaults to light).
 */
/**
 * Shadow-mode comparison between the main selected strategy and an
 * alternate strategy executed in the background.
 */
export interface ShadowComparison {
  id: string;
  runId: string;
  timestamp: string;
  taskType: string;
  mainStrategy: string;
  shadowStrategy: string;
  mainSuccess: boolean;
  shadowSuccess: boolean;
  mainDurationMs: number;
  shadowDurationMs: number;
  mainTokenCost: number;
  shadowTokenCost: number;
}

export interface MetaLearnerConfig {
  /** Trajectory analysis depth. Light = zero extra LLM cost. */
  analysisMode: AnalysisMode;
  /** Enable falsifiable prediction → verification loop. Zero token cost. */
  enablePredictionLoop: boolean;
  /** Enable automatic regression detection and rollback. Zero token cost. */
  enableRegressionGate: boolean;
  /** Enable per-model strategy performance tracking. Zero token cost. */
  enableCrossModelMemory: boolean;
  /** Success rate drop ratio that triggers regression alert (default 0.15 = 15%) */
  regressionThreshold: number;
  /** Master switch to enable/disable self-evolution learning */
  enabled: boolean;
  /** Minimum runs before learning effects activate (default 50) */
  minRunsBeforeLearning: number;
  /** Generate reflection every N runs (default 10) */
  reflectionFrequency: number;
}
