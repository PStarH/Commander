/**
 * Runtime Types for Commander Multi-Agent Execution Engine
 *
 * The runtime is the execution layer that actually drives LLM calls,
 * tool execution, and agent coordination. This file defines all types
 * shared across the runtime subsystem.
 */

// Re-export from shared.ts
export type {
  TokenUsage,
  ModelTier,
  ROMARole,
  ArtifactReference,
  ArtifactStore,
  TaskTreeNode,
} from './types/shared';

// Re-export from llm.ts
export type {
  LLMMessage,
  ReasoningConfig,
  LLMRequest,
  ApiCallRecord,
  CacheConfig,
  SemanticCacheRuntimeConfig,
  SingleFlightRuntimeConfig,
  GeminiCacheRuntimeConfig,
  CacheUsage,
  LLMResponse,
  LLMStreamChunk,
  LLMProvider,
} from './types/llm';

// Re-export from tool.ts
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  IdempotencyKeyContext,
  Tool,
  CompiledSchema,
  ValidationResult,
} from './types/tool';

// Re-export from routing.ts
export type { ModelConfig, RoutingDecision } from './types/routing';

// Re-export from execution.ts
export type {
  AgentExecutionContext,
  AgentExecutionStep,
  RetryConfig,
  ObservationFeedbackConfig,
  AgentExecutionResult,
  ToolRetrievalConfig,
  EntropyGatingConfig,
  SpeculativeExecutionConfig,
  ApprovalConfig,
  OutputFormat,
  AgentRuntimeConfig,
} from './types/execution';

// Re-export from messageBus.ts
export type {
  MessageBusTopic,
  MessagePriority,
  BusPayloadMap,
  TypedBusMessage,
  BusMessage,
  MessageHandler,
} from './types/messageBus';

// Re-export from trace.ts
export type { TraceEvent, TraceSpan, ExecutionTrace } from './types/trace';

// Re-export from htmlReport.ts
export type { HTMLReportSection, HTMLReport } from './types/htmlReport';

// Re-export from selfEvolution.ts
export type {
  ExecutionExperience,
  OptimizationSuggestion,
  StrategyPerformance,
  AnalysisMode,
  FailureCategory,
  EvolutionInsight,
  EvolutionPrediction,
  PredictionVerdict,
  RegressionEvent,
  PerModelStrategyStats,
  MetaLearnerConfig,
} from './types/selfEvolution';
