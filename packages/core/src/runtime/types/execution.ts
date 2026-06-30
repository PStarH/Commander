// ============================================================================
// Agent Runtime Types
// ============================================================================

import type { TokenUsage, ModelTier } from './shared';
import type { ToolCall, ToolResult } from './tool';
import type {
  SemanticCacheRuntimeConfig,
  SingleFlightRuntimeConfig,
  GeminiCacheRuntimeConfig,
} from './llm';

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
  /** SubAgentGuard for enforcing per-step limits during sub-agent execution.
   *  When set, agentRuntime calls guard.check() at each step boundary and
   *  guard.recordTokens() after each LLM call. Violations throw SubAgentLimitError. */
  guard?: import('../../ultimate/subAgentGuard').SubAgentGuard;
  /** Human input to resume after interrupt. When set, the runtime returns this as the interrupt's value instead of pausing. */
  resumeWith?: unknown;
  /** Optional preferred model tier. When set, the router uses this tier instead of auto-selecting. */
  preferredModelTier?: ModelTier;
  /** AgentLineage instance ID (Phase 2.2) — set by subAgentExecutor on spawn so
   *  downstream tool calls and LLM calls can reference their lineage node. */
  lineageInstanceId?: string;
  /**
   * Optional verification tool. When set, the runtime will execute this tool
   * after the assistant indicates it is done. If the tool fails, the runtime
   * re-prompts the agent to continue rather than accepting the stop signal.
   */
  verificationTool?: string;
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
  status: 'success' | 'failed' | 'partial' | 'cancelled' | 'interrupted';
  summary: string;
  steps: AgentExecutionStep[];
  totalTokenUsage: TokenUsage;
  totalDurationMs: number;
  error?: string;
  outputData?: Record<string, unknown>;
  /** Content written to files by file_write tool calls during this execution */
  artifactContent?: string;
  /** Present when status is 'interrupted' — contains the interrupt payload */
  interrupt?: { reason: string; value: unknown };
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
 * Configuration for tool approval.
 * Allows injecting a custom approval callback to override the default auto-approve behavior.
 */
export interface ApprovalConfig {
  /** Custom approval callback. If set, overrides the default auto-approve behavior.
   *  The callback receives { id, toolName, arguments, reason } and must return
   *  { approved, requestId, approvedAt, reason? }.
   *  If not set, all tool calls are auto-approved (ToolApproval policies still gate). */
  approvalCallback?: (req: {
    id: string;
    toolName: string;
    arguments: Record<string, unknown>;
    reason?: string;
  }) =>
    | Promise<{ approved: boolean; requestId: string; approvedAt: string; reason?: string }>
    | { approved: boolean; requestId: string; approvedAt: string; reason?: string };
}

/**
 * Output format for the final agent response.
 * - 'auto': Default behavior — let the model decide format, with fallbacks for empty content
 * - 'structured': Prefer structured output (JSON, tool calls) over verbose prose
 * - 'freeform': Allow natural language responses without forcing structure
 * - 'concise': Short answers only, skip explanations
 */
export type OutputFormat = 'auto' | 'structured' | 'freeform' | 'concise';

/**
 * Configuration for the Agent Runtime.
 */
export interface AgentRuntimeConfig {
  defaultModelTier: ModelTier;
  maxStepsPerRun: number;
  maxRetries: number;
  retryDelayMs: number;
  timeoutMs: number;
  /** Dedicated timeout for LLM provider calls (default: 120000ms). */
  llmTimeoutMs?: number;
  /** Max reflexion self-correction iterations on low-confidence verification failure (default: 2). */
  reflexionMaxIterations?: number;
  maxConcurrency: number;
  /** Smart model router: user-configurable, capability-based model selection. */
  smartModelRouter?: {
    enabled: boolean;
    mode?: 'auto' | 'manual' | 'cascade';
    defaultModel?: string;
    modelPool?: Array<{
      id: string;
      provider: string;
      capabilities: string[];
      costPer1MInput: number;
      costPer1MOutput: number;
      costPer1MCachedInput?: number;
      contextWindow: number;
      tier?: ModelTier;
    }>;
  };
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
  /** Semantic (embedding-similarity) response cache. Defaults to disabled. */
  semanticCache?: SemanticCacheRuntimeConfig;
  /** Provider prompt-cache TTL override (Anthropic). '1h' = 2x write premium but 90% off reads. Forced to '5m' in critical governor phase. */
  promptCacheTtl?: '5m' | '1h';
  /** OpenAI prompt_cache_key override. Default auto-derived from tenant+agent+goal-hash for routing stickiness. */
  promptCacheKey?: string;
  /** Single-flight request dedup: collapse concurrent identical LLM requests into one provider call. Default: enabled. */
  singleFlight?: SingleFlightRuntimeConfig;
  /** Google Gemini cachedContent lifecycle manager. 90% off reads on >4K token payloads. Default: enabled. */
  geminiCache?: GeminiCacheRuntimeConfig;
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
  /** Tool approval configuration. Controls how tool calls are approved before execution (default: auto-approve). */
  approval?: ApprovalConfig;
  /** Output format for the final agent response. Controls how the post-loop summary is formatted (default: 'auto'). */
  outputFormat?: OutputFormat;
  /** Directory for auto-exported SOP templates (default: .commander/sops/{agentId}). */
  sopDir?: string;
  /** Name of the LLM provider to use for verification (Stage 2/3). When set, the verification
   *  pipeline uses a different provider than the agent, breaking the evaluator echo chamber. */
  evaluatorProviderName?: string;
  /** Security monitor configuration. */
  securityMonitor?: {
    enabled?: boolean;
  };
  /** Runtime guardian (LLM-based tool call reviewer) configuration. */
  runtimeGuardian?: {
    enabled?: boolean;
    model?: string;
    providerName?: string;
    maxTokens?: number;
    timeoutMs?: number;
  };
  /** Cycle detector configuration. */
  cycleDetection?: {
    enabled?: boolean;
  };
  /** Circuit breaker configuration. */
  circuitBreaker?: {
    /** Open the breaker immediately when a tool permanently fails, rather than
     *  waiting for the LLM to retry the same tool N times. */
    openOnFailure?: boolean;
    /** Default failure threshold before opening the breaker. */
    threshold?: number;
  };
  /** Provider-level retry configuration for transient LLM provider failures. */
  providerRetry?: {
    attempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  /** Goal-completion loop: continue executing if the LLM stops before the goal
   *  is demonstrably complete. */
  goalCompletion?: {
    /** When true, re-prompt the LLM to continue if it stops without a clear
     *  completion signal and budget remains. */
    continueOnStop?: boolean;
    /** Phrases in the assistant message that are treated as completion signals. */
    completionPhrases?: string[];
    /** Custom prompt to append when continuing after an early stop. */
    continuationPrompt?: string;
    /** Maximum number of times the runtime will invoke the verification tool
     *  and re-prompt the agent after a failed verification. Default: 3. */
    verificationAttempts?: number;
  };
  /** Content scanner configuration. Controls which security scan categories
   *  are active on LLM outputs. All categories default to enabled. */
  contentScanner?: {
    enableHtmlScan?: boolean;
    enableCssScan?: boolean;
    enableMetadataScan?: boolean;
    enableUnicodeScan?: boolean;
    enablePromptInjectionScan?: boolean;
    enableSocialEngineeringScan?: boolean;
    enableSemanticManipulationScan?: boolean;
    maxContentLength?: number;
    timeout?: number;
  };
}
