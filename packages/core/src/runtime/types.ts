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
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
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
  | 'mission.updated'
  | 'mission.blocked'
  | 'mission.completed'
  | 'memory.written'
  | 'system.alert'
  | 'tool.executed'
  | 'trace.recorded';

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
