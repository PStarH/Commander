/**
 * Runtime Types for Commander Multi-Agent Execution Engine
 *
 * The runtime is the execution layer that actually drives LLM calls,
 * tool execution, and agent coordination. This file defines all types
 * shared across the runtime subsystem.
 */

// ============================================================================
// LLM Provider Abstraction
// ============================================================================

/**
 * A single message in a conversation with an LLM.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  /** MiMo reasoning models put internal reasoning here. Must be passed back on follow-up calls. */
  reasoning_content?: string;
  /** OpenAI-format tool calls for assistant messages */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Reasoning/thinking configuration for LLM providers that support it.
 * Controls whether the model performs internal reasoning before answering.
 */
export interface ReasoningConfig {
  /** Enable reasoning/thinking tokens (default: model-dependent) */
  enabled: boolean;
  /** Maximum tokens for reasoning/thinking (0 = use provider default) */
  budget?: number;
  /** Effort level — some providers support low/medium/high reasoning effort */
  effort?: 'low' | 'medium' | 'high';
}

/**
 * Request payload sent to an LLM provider.
 */
export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  cacheConfig?: CacheConfig;
  /** Reasoning/thinking config for supported providers (e.g. MiMo, OpenAI o-series) */
  reasoningConfig?: ReasoningConfig;
}

/**
 * Record of a single LLM API call for audit/provenance purposes.
 * Written to samples store for every call.
 */
export interface ApiCallRecord {
  /** Schema version for forward-compatible deserialization */
  schemaVersion?: number;
  /** Unique call ID */
  callId: string;
  /** Run/mission context */
  runId?: string;
  agentId?: string;
  /** Request snapshot */
  model: string;
  provider: string;
  temperature?: number;
  maxTokens?: number;
  reasoningConfig?: ReasoningConfig;
  /** Token usage */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Performance */
  durationMs: number;
  finishReason: string;
  /** Whether this was a retry */
  attemptNumber: number;
  /** Truncated content for audit (first 500 chars) */
  contentPrefix: string;
  /** Extracted code solution (eval context: function body or full solution from response) */
  extractedCode?: string;
  /** Error if any */
  error?: string;
  /** Evaluation task ID (e.g. "HumanEval/64") */
  taskId?: string;
  /** Full request messages for full prompt/response replay (debugging) */
  fullMessages?: unknown[];
  /** Full LLM response object (replay/audit) */
  fullResponse?: unknown;
  /** Reasoning / chain-of-thought content from extended-thinking providers */
  reasoningContent?: string;
  /** Tenant that owns this call (multi-tenant isolation) */
  tenantId?: string;
  /** Parent runId for sub-agent correlation */
  parentRunId?: string;
  /** ISO timestamp */
  timestamp: string;
}

/**
 * Configuration for prompt caching across providers.
 * 
 * Provider details:
 * - Anthropic: cache_control markers on system prompt or tool defs. 90% off reads.
 *   Min 1024 tokens for cache write. 1.25x write premium (5min), 2x (1hr TTL).
 * - OpenAI: automatic on prompts >1024 tokens. 50% off reads. 5-10min TTL.
 * - Gemini: automatic on prompts >4K tokens. 90% off reads. Configurable TTL.
 */
export interface CacheConfig {
  /** Mark the system prompt block as cacheable */
  cacheSystemPrompt: boolean;
  /** Mark tool definitions as cacheable */
  cacheTools: boolean;
  /** Mark the conversation history (up to N messages) as cacheable */
  cacheHistory?: number;
  /** Explicit cache_control markers (Anthropic-style) */
  useCacheControl: boolean;
}

export interface CacheUsage {
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Response from an LLM provider.
 */
export interface LLMResponse {
  content: string;
  model: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  toolCalls?: ToolCall[];
  /** MiMo reasoning models put internal reasoning here. Present on responses from reasoning models. */
  reasoning_content?: string;
}

/**
 * Provider-native streaming event. Providers may expose this in addition to
 * call() when they need protocol-specific streaming behavior.
 */
export interface LLMStreamChunk {
  contentDelta?: string;
  toolCallDelta?: Partial<ToolCall>;
  usage?: Partial<TokenUsage>;
  done?: boolean;
}

/**
 * Token usage tracking.
 *
 * Cache fields are optional — only providers that support prompt caching
 * (Anthropic, OpenAI, Gemini) populate them. Cost calculation must apply
 * provider-specific multipliers (see TokenSentinel.calculateCost).
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from prompt cache (Anthropic cache_read, OpenAI cached_tokens, Gemini cachedContent) */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache (Anthropic cache_creation, OpenAI implicit on first hit) */
  cacheWriteTokens?: number;
}

/**
 * Abstract LLM provider interface.
 * Implementations: OpenAI, Anthropic, Google, MockLLMProvider
 */
export interface LLMProvider {
  readonly name: string;
  call(request: LLMRequest): Promise<LLMResponse>;
  stream?(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}

// ============================================================================
// Tool System
// ============================================================================

/**
 * Definition of a tool an agent can call.
 * Enhanced with BFCL-compatible fields for precise function calling.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Examples of valid tool calls for few-shot disambiguation */
  examples?: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Category hint for tool selection disambiguation */
  category?: string;
  /** Whether this tool should be hidden from general-purpose models (specialized) */
  hidden?: boolean;
}

/**
 * A tool call made by the LLM.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Result of executing a tool.
 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  error?: string;
  durationMs: number;
  /** True if this result was served from idempotency cache, not freshly executed. */
  fromCache?: boolean;
}

/**
 * Interface for a tool that can be executed.
 * Safety flags control concurrent execution and execution behavior.
 */
export interface IdempotencyKeyContext {
  runId: string;
  stepId: string;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
  /** If true, tool can run in parallel with other concurrent-safe tools. Default: false */
  isConcurrencySafe?: boolean;
  /** If true, tool only reads state (no side effects). Allows speculative execution. Default: false */
  isReadOnly?: boolean;
  /** Max execution time in ms. 0 = no limit. Default: 0 */
  timeout?: number;
  /** Max output size in chars. Larger outputs are truncated and linked to file. Default: 10000 */
  maxOutputSize?: number;
  /** Compiled schema for runtime validation (populated by ToolRegistry) */
  compiledSchema?: CompiledSchema;
  /** True if tool call is safe to replay: same args + same run + same step → cached result. */
  isIdempotent?: boolean;
  /** Static or function-derivable key for ATR idempotency cache. Overrides default SHA-256 derivation. */
  idempotencyKey?: string | ((args: Record<string, unknown>, ctx: IdempotencyKeyContext) => string);
  /** External system this tool touches (e.g. 'github', 'stripe', 'shell'). For audit + safety gates. */
  externalSystem?: string;
  /** Risk level: 'low' (read), 'medium' (idempotent write), 'high' (destructive). Default: 'medium'. */
  riskLevel?: 'low' | 'medium' | 'high';
  /** If true, tool can have irreversible side effects and requires explicit user approval. Default: false */
  destructive?: boolean;
}

/**
 * Compiled (pre-processed) JSON Schema for fast runtime validation.
 * Created once at tool registration time via compileSchema().
 */
export interface CompiledSchema {
  requiredFields: string[];
  propertyTypes: Map<string, string>;
  propertyEnums: Map<string, unknown[]>;
  propertyConstraints: Map<string, { minimum?: number; maximum?: number }>;
  defaults: Map<string, unknown>;
  raw: Record<string, unknown>;
}

/**
 * Result of validating tool call arguments against a compiled schema.
 */
export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    path: string;
    message: string;
    expectedType?: string;
    actualValue?: unknown;
  }>;
  repairedArgs?: Record<string, unknown>;
}

// ============================================================================
// Model Router Types
// ============================================================================

/**
 * Model capability tiers for routing decisions.
 */
export type ModelTier = 'eco' | 'standard' | 'power' | 'consensus';

/**
 * Configuration for a single model in the router.
 */
export interface ModelConfig {
  id: string;
  provider: string;       // e.g. 'openai', 'anthropic', 'google'
  tier: ModelTier;
  costPer1KInput: number;   // USD per 1K input tokens
  costPer1KOutput: number;  // USD per 1K output tokens
  capabilities: string[];   // e.g. 'code', 'reasoning', 'creative'
  contextWindow: number;    // max context tokens
  /** Priority within tier (lower = preferred first) */
  priority: number;
}

/**
 * Result of a routing decision.
 */
export interface RoutingDecision {
  modelId: string;
  tier: ModelTier;
  provider: string;
  reasoning: string[];
  estimatedCost: number;
  maxTokens: number;
}

// ============================================================================
// Agent Runtime Types
// ============================================================================

/**
 * Context passed to an agent for execution.
 */
export interface AgentExecutionContext {
   runId?: string;
   agentId: string;
   missionId?: string;
   projectId: string;
   goal: string;
    /** GAP-09: Tenant isolation — tenant this execution belongs to */
    tenantId?: string;
    /** GAP-09: User isolation — user who initiated this execution */
    userId?: string;
    /** Parent runId for sub-agent correlation (multi-agent hierarchy) */
    parentRunId?: string;
    /** Sub-agent recursion depth (0 = root agent) */
    subAgentDepth?: number;
    /** Sub-agent role label (e.g., 'planner', 'coder', 'verifier') */
    subAgentRole?: string;
    /** Execution lane for concurrency isolation. If set, routes to this named lane. */
    lane?: string;
   /** Optional JSON schema for validating the final assistant output. */
   outputSchema?: Record<string, unknown>;
   contextData: {
     warRoomSnapshot?: unknown;
     memoryItems?: unknown[];
     agentState?: Record<string, unknown>;
     governanceProfile?: unknown;
   };
availableTools: string[];
    maxSteps: number;
    tokenBudget: number;
    outputDir?: string;
    abortSignal?: AbortSignal;
}

/**
 * A step in agent execution.
 */
export interface AgentExecutionStep {
   stepNumber: number;
   timestamp: string;
   type: 'thought' | 'tool_call' | 'tool_result' | 'response';
   content: string;
   tokenUsage?: TokenUsage;
   durationMs: number;
   /** For tool calls: which tool and args */
   toolCall?: ToolCall;
   toolResult?: ToolResult;
}

/**
 * Retry backoff configuration.
 */
export interface RetryConfig {
  /** Maximum number of retries (default: 2) */
  maxRetries: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelayMs: number;
  /** Retry on specific HTTP status codes */
  retryableStatusCodes: number[];
}

/**
 * Observation feedback configuration.
 */
export interface ObservationFeedbackConfig {
  /** Enable observation feedback (default: false) */
  enabled: boolean;
  /** Maximum number of observation hints to include (default: 3) */
  maxHints: number;
  /** Summary length for each observation hint (default: 200) */
  hintSummaryLength: number;
}

/**
 * Result of a full agent execution.
 */
export interface AgentExecutionResult {
  runId: string;
  agentId: string;
  missionId?: string;
  status: 'success' | 'failed' | 'partial' | 'cancelled';
  summary: string;
  steps: AgentExecutionStep[];
  totalTokenUsage: TokenUsage;
  totalDurationMs: number;
  error?: string;
  outputData?: Record<string, unknown>;
  /** Content written to files by file_write tool calls during this execution */
  artifactContent?: string;
}

/**
 * Configuration for dynamic tool retrieval (ITR-inspired).
 * Dynamically selects only relevant tools per step instead of loading all.
 */
export interface ToolRetrievalConfig {
  /** Enable dynamic tool retrieval (default: false) */
  enabled: boolean;
  /** Minimum number of tools to always include (default: 3) */
  minTools: number;
  /** Maximum number of tools to include per request (default: 10) */
  maxTools: number;
  /** Tools to always include regardless of relevance scoring */
  alwaysInclude: string[];
}

/**
 * Configuration for entropy-based tool gating.
 * Skips unnecessary tool loading when model is already confident.
 */
export interface EntropyGatingConfig {
  /** Enable entropy-based gating (default: false) */
  enabled: boolean;
}

/**
 * Configuration for PASTE-style speculative execution.
 * Pre-executes predicted next tool calls during LLM processing time.
 */
export interface SpeculativeExecutionConfig {
  /** Enable speculative execution (default: false) */
  enabled: boolean;
  /** Maximum speculative predictions per step (default: 2) */
  maxPredictions: number;
  /** Minimum confidence threshold (0-1) for speculative predictions (default: 0.3) */
  minConfidence: number;
}

/**
 * Configuration for the Agent Runtime.
 */
export interface AgentRuntimeConfig {
  defaultModelTier: ModelTier;
  maxStepsPerRun: number;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  maxConcurrency: number;
  /** Observation masking: keep last N tool results, replace older with placeholders. 0 = disabled. */
  observationMaskWindow: number;
  /** Use descending scheduler for parallel tools (broad→narrow). */
  enableDescendingScheduler: boolean;
  /** Hard cap on total tokens per execution. 0 = disabled. */
  budgetHardCapTokens: number;
  /** Dynamic tool retrieval config (ITR-inspired) */
  toolRetrieval?: ToolRetrievalConfig;
  /** Entropy-based tool gating config */
  entropyGating?: EntropyGatingConfig;
/** PASTE-style speculative execution config */
   speculativeExecution?: SpeculativeExecutionConfig;
   /** Retry backoff configuration */
   retryConfig?: RetryConfig;
    /** Observation feedback: feed tool results back as hints to improve LLM reasoning */
    observationFeedback?: ObservationFeedbackConfig;
    /** Memory store type for persistent storage. 'in-memory' (default) keeps data in process memory; 'sqlite' uses better-sqlite3; 'json' uses a flat file. */
    memoryStoreType?: 'in-memory' | 'sqlite' | 'json';
  /** Enable compensation tracking for mutation tools (defaults to true). */
  enableCompensation?: boolean;
  /** Enable ToolResultCache for read-only tool results (defaults to true). */
  enableToolCaching?: boolean;
    /** OpenTelemetry exporter configuration. When enabled, execution traces are exported to an OTLP-compatible endpoint (Jaeger, Tempo, SigNoz, etc.). */
    otelExporter?: {
      /** Enable OTLP trace export (default: false) */
      enabled: boolean;
      /** OTLP HTTP endpoint (default: http://localhost:4318/v1/traces) */
      endpoint?: string;
      /** Service name for identifying traces (default: commander) */
      serviceName?: string;
      /** Additional HTTP headers (e.g. for auth tokens) */
      headers?: Record<string, string>;
    };
}

// ============================================================================
// Message Bus Types
// ============================================================================

/**
 * Topics for inter-agent messages.
 */
export type MessageBusTopic =
   | '*'
   | 'agent.started'
   | 'agent.completed'
   | 'agent.failed'
   | 'agent.message'
   | 'agent.started.typed'
   | 'agent.completed.typed'
   | 'agent.failed.typed'
   | 'mission.updated'
   | 'mission.blocked'
   | 'mission.completed'
   | 'memory.written'
   | 'skills.created'
   | 'system.alert'
   | 'tool.executed'
   | 'trace.recorded'
   | 'workflow.replan'
   | 'channel.message'
   | 'channel.connected'
   | 'channel.disconnected'
   | 'channel.error'
    | 'channel.interaction'
    | 'tool.started'
    | 'tool.completed'
    | 'tool.timeout'
    | 'tool.retry'
    | 'tool.blocked'
    | 'goal.started'
    | 'goal.decomposed'
    | 'goal.round_started'
    | 'goal.round_completed'
    | 'goal.worker_started'
    | 'goal.worker_completed'
    | 'goal.worker_failed'
    | 'goal.critic_started'
    | 'goal.critic_completed'
    | 'goal.manager_review'
    | 'goal.completed'
    | 'swarm.started'
    | 'swarm.fission'
    | 'swarm.fusion_conflict'
    | 'swarm.round_completed'
    | 'swarm.completed'
    | 'drive.started'
    | 'drive.step_started'
    | 'drive.step_completed'
    | 'drive.step_failed'
    | 'drive.completed';

/**
 * Priority levels for messages.
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Per-topic payload type map.
 * Each known topic declares what shape its payload has.
 * Topics not listed here (or '*' wildcard) use `unknown`.
 */
export interface BusPayloadMap {
  'agent.started': { taskId: string; goal: string; detail?: string; execId?: string };
  'agent.completed': { taskId: string; status: string; metrics?: Record<string, number> };
  'agent.failed': { taskId: string; error: string };
  'agent.message': { from: string; content: string };
  'goal.started': { goal: string; mode: string };
  'goal.decomposed': { subGoalCount: number; decomposition: unknown };
  'goal.round_started': { round: number; activeGoals: number };
  'goal.round_completed': { round: number; decision: string };
  'goal.worker_started': { goalId: string; goal: string };
  'goal.worker_completed': { goalId: string };
  'goal.worker_failed': { goalId: string; error: string };
  'goal.critic_started': { goalId: string };
  'goal.critic_completed': { goalId: string };
  'goal.manager_review': { round: number };
  'goal.completed': { goal: string; status: string; summary: string };
  'drive.started': { goal: string; mode: string };
  'drive.step_started': { stepId: string; description: string };
  'drive.step_completed': { stepId: string; result?: string };
  'drive.step_failed': { stepId: string; error: string };
  'drive.completed': { summary: string };
  'swarm.started': { goal: string; agentCount: number };
  'swarm.fission': { parentId: string; childIds: string[] };
  'swarm.fusion_conflict': { agentIds: string[]; conflict: string };
  'swarm.round_completed': { round: number; results: unknown[] };
  'swarm.completed': { summary: string };
  'memory.written': { layer: string; content: string; tags?: string[] };
  'skills.created': { skills: string[]; execId: string };
  'system.alert': { level: 'info' | 'warn' | 'error'; message: string; detail?: string };
  'tool.executed': { name: string; durationMs: number; success: boolean };
  'tool.started': { name: string };
  'tool.completed': { name: string; durationMs: number };
  'tool.timeout': { name: string; timeoutMs: number };
  'tool.retry': { name: string; attempt: number; error: string };
  'tool.blocked': { name: string; reason: string };
  'workflow.replan': { phase: string; reason: string; agentId: string };
  'channel.message': { channelId: string; content: string };
  'channel.connected': { channelId: string };
  'channel.disconnected': { channelId: string };
  'channel.error': { channelId: string; error: string };
  'channel.interaction': { channelId: string; type: string; data: unknown };
  'mission.updated': { missionId: string; status: string };
  'mission.blocked': { missionId: string; reason: string };
  'mission.completed': { missionId: string; result: string };
  'trace.recorded': { traceId: string; spanCount: number };
}

/**
 * A message on the bus, typed per topic.
 * For a known topic T, `payload` is the correct shape.
 * For '*' or unknown topics, `payload` stays `unknown`.
 */
export type TypedBusMessage<T extends MessageBusTopic = MessageBusTopic> =
  T extends keyof BusPayloadMap
    ? Omit<BusMessage, 'topic' | 'payload'> & { topic: T; payload: BusPayloadMap[T] }
    : BusMessage & { topic: T };

/**
 * A message on the bus.
 */
export interface BusMessage {
  id: string;
  topic: MessageBusTopic;
  source: string;           // agent ID or 'system'
  target?: string;          // specific agent or undefined = broadcast
  payload: unknown;
  priority: MessagePriority;
  timestamp: string;
  ttl?: number;             // time-to-live in ms
}

/**
 * Handler for bus messages.
 */
export type MessageHandler = (message: BusMessage) => void | Promise<void>;

// ============================================================================
// Execution Trace Types
// ============================================================================

/**
 * A single trace event in execution history.
 * Follows OpenTelemetry span attribute naming conventions for easy export.
 */
export interface TraceEvent {
  /** Schema version for forward-compatible deserialization */
  schemaVersion?: number;
  id: string;
  /** Span ID — unique per event, used for parent-child relationships */
  spanId: string;
  /** Trace ID — shared across all events in an execution, survives restarts */
  traceId: string;
  runId: string;
  agentId: string;
  type: 'llm_call' | 'tool_execution' | 'decision' | 'error' | 'state_change';
  timestamp: string;
  durationMs: number;
  data: {
    input?: unknown;
    output?: unknown;
    /** OTel convention: gen_ai.request.model, gen_ai.response.model */
    modelInfo?: { model: string; provider: string; tier: ModelTier };
    /** OTel convention: gen_ai.usage.prompt_tokens, gen_ai.usage.completion_tokens */
    tokenUsage?: TokenUsage;
    error?: string;
    stateTransition?: { from: string; to: string };
  };
  /** Parent span ID for creating trace trees */
  parentSpanId?: string;
}

/**
 * Active span handle returned by startSpan().
 * Records duration automatically on end().
 */
export interface TraceSpan {
  spanId: string;
  traceId: string;
  /** Finish the span and record it. Duration computed from start to now. */
  end(attributes?: { output?: unknown; error?: string }): TraceEvent;
  /** Add a child event to this span without ending it */
  recordChild(type: TraceEvent['type'], attrs?: { input?: unknown; output?: unknown; error?: string; durationMs?: number }): TraceEvent;
}

/**
 * A complete trace of an execution.
 */
export interface ExecutionTrace {
  runId: string;
  traceId: string;
  agentId: string;
  missionId?: string;
  /** Tenant that owns this run (for multi-tenant isolation) */
  tenantId?: string;
  /** Parent runId when this is a sub-agent run */
  parentRunId?: string;
  /** Sub-agent depth (0 = root, 1 = first-level sub-agent, etc.) */
  subAgentDepth?: number;
  /** Role of this sub-agent within the agent team */
  subAgentRole?: string;
  startedAt: string;
  completedAt?: string;
  events: TraceEvent[];
  summary: {
    totalEvents: number;
    totalDurationMs: number;
    totalTokens: number;
    llmCalls: number;
    toolExecutions: number;
    errors: number;
    modelUsed: string;
  };
}

// ============================================================================
// HTML Report Types
// ============================================================================

/**
 * Section of an HTML report.
 */
export interface HTMLReportSection {
  title: string;
  content: string;   // HTML content
  collapsible?: boolean;
  priority: number;  // display order
}

/**
 * Complete HTML report for human consumption.
 */
export interface HTMLReport {
  title: string;
  subtitle?: string;
  metadata: Record<string, string>;
  sections: HTMLReportSection[];
  generatedAt: string;
  /** Highlights/insights for the executive summary */
  highlights: string[];
}

// ============================================================================
// Self-Evolution Types
// ============================================================================

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
}
