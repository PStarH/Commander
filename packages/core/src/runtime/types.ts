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
 * Token usage tracking.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Abstract LLM provider interface.
 * Implementations: OpenAI, Anthropic, Google, MockLLMProvider
 */
export interface LLMProvider {
  readonly name: string;
  call(request: LLMRequest): Promise<LLMResponse>;
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
}

/**
 * Interface for a tool that can be executed.
 * Safety flags control concurrent execution and execution behavior.
 */
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
   contextData: {
     warRoomSnapshot?: unknown;
     memoryItems?: unknown[];
     agentState?: Record<string, unknown>;
     governanceProfile?: unknown;
   };
availableTools: string[];
    maxSteps: number;
    tokenBudget: number;
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
}

// ============================================================================
// Message Bus Types
// ============================================================================

/**
 * Topics for inter-agent messages.
 */
export type MessageBusTopic =
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
   | 'system.alert'
   | 'tool.executed'
   | 'trace.recorded'
   | 'workflow.replan'
   | 'channel.message'
   | 'channel.connected'
   | 'channel.disconnected'
   | 'channel.error'
   | 'channel.interaction';

/**
 * Priority levels for messages.
 */
export type MessagePriority = 'low' | 'normal' | 'high' | 'critical';

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
 */
export interface TraceEvent {
  id: string;
  runId: string;
  agentId: string;
  type: 'llm_call' | 'tool_execution' | 'decision' | 'error' | 'state_change';
  timestamp: string;
  durationMs: number;
  data: {
    input?: unknown;
    output?: unknown;
    modelInfo?: { model: string; provider: string; tier: ModelTier };
    tokenUsage?: TokenUsage;
    error?: string;
    stateTransition?: { from: string; to: string };
  };
  parentId?: string;        // for nested traces
}

/**
 * A complete trace of an execution.
 */
export interface ExecutionTrace {
  runId: string;
  agentId: string;
  missionId?: string;
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
  avgTokenCost: number;
  successRate: number;
  lastUsed: string;
  bestForTaskTypes: string[];
}
