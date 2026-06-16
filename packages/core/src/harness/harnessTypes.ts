/**
 * Harness Types — Pluggable Agent Execution Strategies
 *
 * The Harness abstraction allows Commander to support multiple agent execution
 * backends (default, code-agent, MCP) that can be selected per model/tier/provider.
 *
 * Inspired by:
 * - OpenClaw's AgentHarness (model-scoped → provider-scoped → auto → fallback)
 * - Oh My Pi: dual-entry agent loop, append-only context, event stream,
 *   permission system, sub-agents, skills, intent tracing, steering
 * - Codex CLI: clean core/exec/tui separation, Guardian approval, sandbox,
 *   plan mode, approval modes, diff-based editing, file watcher, network policy
 */
import type {
  LLMProvider,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  Tool,
  ToolCall,
  ToolResult,
  AgentExecutionContext,
  AgentExecutionResult,
  ModelTier,
  ToolDefinition,
} from '../runtime/types';

// ============================================================================
// Harness Capabilities
// ============================================================================

/**
 * Capability flags a harness advertises. Commander queries these to decide
 * which harness to use for a given task and to enable/disable features.
 *
 * Mapping to reference systems:
 * - Oh My Pi: supportsSubAgents (TaskExecutor), supportsSteering (Agent.steer),
 *   supportsIntentTracing (_i field), supportsSkillsLoading (SKILL.md)
 * - Codex CLI: supportsGuardianApproval (Guardian), supportsPlanMode,
 *   supportsPatchApplication (apply_patch), supportsSandboxedExecution,
 *   supportsNetworkPolicy, supportsCommandClassification,
 *   supportsFileWatching (notify crate)
 * - Both: supportsAppendOnlyContext (stable prefix caching),
 *   supportsHashlineEdits (Oh My Pi hashline system)
 */
export interface HarnessCapabilities {
  // ── Sub-Agent System (Oh My Pi) ──
  supportsSubAgents: boolean;
  // ── Mid-Turn Steering (Oh My Pi Agent.steer) ──
  supportsSteering: boolean;
  // ── Guardian Approval (Codex CLI) ──
  supportsGuardianApproval: boolean;
  // ── Hashline-Anchored Code Edits (Oh My Pi) ──
  supportsHashlineEdits: boolean;
  // ── Append-Only Context for stable prefix caching (Oh My Pi) ──
  supportsAppendOnlyContext: boolean;
  // ── Intent Tracing via _i field on tool calls (Oh My Pi) ──
  supportsIntentTracing: boolean;
  // ── Plan Mode — read-only execution with plan document (Codex CLI) ──
  supportsPlanMode: boolean;
  // ── Patch-based file editing (Codex CLI apply_patch) ──
  supportsPatchApplication: boolean;
  // ── Skills system — auto-discover SKILL.md files (Oh My Pi) ──
  supportsSkillsLoading: boolean;
  // ── Session persistence with versioning (Codex CLI JSONL) ──
  supportsSessionPersistence: boolean;
  // ── File watcher for hot-reload / change detection (Codex CLI) ──
  supportsFileWatching: boolean;
  // ── Network policy enforcement (Codex CLI MITM proxy) ──
  supportsNetworkPolicy: boolean;
  // ── Command safety classification (Codex CLI is_known_safe_command) ──
  supportsCommandClassification: boolean;
  // ── Sandboxed execution (Codex CLI Seatbelt/Landlock) ──
  supportsSandboxedExecution: boolean;
  // ── Concurrent tool execution (parallel safe) ──
  supportsConcurrentExecution: boolean;
  // ── Reasoning effort tuning (Codex CLI reasoning_effort) ──
  supportsReasoningEffort: boolean;

  /** Maximum number of tools that can execute concurrently */
  maxConcurrentTools: number;
  /** Maximum tool calls the model can make in a single turn before forced continuation */
  maxToolCallsPerTurn: number;
  /** Human-readable summary */
  description: string;
}

// ============================================================================
// Harness Selection Context
// ============================================================================

/**
 * Context used by the HarnessRegistry to decide which harness to use.
 * Injected per-run from AgentExecutionContext + RoutingDecision.
 */
export interface HarnessSelectionContext {
  /** The resolved model ID (e.g., "gpt-4o", "claude-sonnet-4-6") */
  model: string;
  /** The resolved model tier */
  tier: ModelTier;
  /** The provider name (e.g., "openai", "anthropic") */
  provider: string;
  /** Feature flags requested for this run */
  features: string[];
  /** Tenant ID for multi-tenant isolation */
  tenantId?: string;
  /** User ID who initiated this execution */
  userId?: string;
  /** Approval mode (Codex CLI — suggest/auto-edit/full-auto) */
  approvalMode?: ApprovalMode;
  /** Reasoning effort level (Codex CLI) */
  reasoningEffort?: ReasoningEffort;
  /** Plan mode flag */
  planMode?: boolean;
}

// ============================================================================
// Approval Mode (Codex CLI)
// ============================================================================

/**
 * Codex-style approval modes.
 *
 * - `suggest`: Read-only — no file edits, no command execution. Most restrictive.
 *   Used for safe exploration and plan generation.
 * - `auto-edit`: Auto-approve file edits within workspace, but require approval
 *   for shell commands and network access.
 * - `full-auto`: Auto-approve within workspace sandbox, no human approval needed.
 * - `danger-full-access`: Skip all approval checks. Bypasses sandbox.
 *   Use with extreme caution.
 */
export type ApprovalMode =
  | 'suggest'
  | 'auto-edit'
  | 'full-auto'
  | 'danger-full-access';

/**
 * Reasoning effort levels (Codex CLI reasoning_effort).
 * Controls how much internal reasoning the model performs.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

// ============================================================================
// Intent Tracing (Oh My Pi _i field)
// ============================================================================

/**
 * Intent metadata attached to a tool call via the `_i` field in arguments.
 * Oh My Pi uses this to track WHY the model is making a particular call,
 * improving auditability and reasoning transparency.
 */
export interface Intent {
  /** Short, human-readable description of what this call intends to do */
  summary: string;
  /** Why this call is being made (rationale) */
  rationale?: string;
  /** Confidence score 0-1 */
  confidence?: number;
  /** Categorization tags */
  tags?: string[];
  /** Plan item this call is fulfilling (when in plan mode) */
  planItemId?: string;
}

// ============================================================================
// Hashline Anchor (Oh My Pi)
// ============================================================================

/**
 * A hashline anchor for code edits — inspired by Oh My Pi's hashline system.
 *
 * Hashlines uniquely identify code locations using content hashes, making
 * edits resilient to line number shifts. The model includes these in tool
 * call arguments to specify exact edit locations.
 */
export interface HashlineAnchor {
  /** File path */
  filePath: string;
  /** Content hash of the anchor line(s) */
  hash: string;
  /** The anchor line content (for display/debugging) */
  anchor: string;
  /** 0-based line number (approximate, for reference only) */
  line: number;
}

// ============================================================================
// Patch Application (Codex CLI apply_patch)
// ============================================================================

/**
 * A single hunk in a unified diff / apply_patch operation.
 */
export interface PatchHunk {
  /** Old line range (start, count). count=0 means pure insertion. */
  oldStart: number;
  oldCount: number;
  /** New line range (start, count). */
  newStart: number;
  newCount: number;
  /** Old content lines (with leading space or '-') */
  oldLines: string[];
  /** New content lines (with leading '+') */
  newLines: string[];
}

export interface PatchRequest {
  /** File path relative to workspace */
  filePath: string;
  /** The patch hunks to apply */
  hunks: PatchHunk[];
  /** Optional description of why this patch */
  description?: string;
}

export interface PatchResult {
  success: boolean;
  /** The resulting diff for display */
  diff?: string;
  /** Error message if !success */
  error?: string;
  /** Number of lines added */
  added: number;
  /** Number of lines removed */
  removed: number;
}

// ============================================================================
// Plan Mode (Codex CLI)
// ============================================================================

/**
 * Status of a plan item.
 */
export type PlanItemStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'skipped';

/**
 * A single item in a plan document (Codex CLI PlanItemArg).
 */
export interface PlanItem {
  id: string;
  title: string;
  description?: string;
  status: PlanItemStatus;
  /** Tools this step is expected to use */
  expectedTools?: string[];
  /** Optional dependency on other plan items (by id) */
  dependsOn?: string[];
  /** Result/notes for completed items */
  result?: string;
  /** Started timestamp (ms since epoch) */
  startedAt?: number;
  /** Completed timestamp */
  completedAt?: number;
}

/**
 * Plan mode configuration. When enabled, the harness executes in read-only
 * mode (no write/exec tools) and produces a structured plan document.
 */
export interface PlanModeConfig {
  /** Read-only execution — write tools are blocked */
  readOnly: boolean;
  /** Tools allowed in plan mode (defaults to read-only tools) */
  allowedTools: string[];
  /** Generate a plan document at the end of execution */
  generatePlan: boolean;
  /** Plan items (filled during execution) */
  items: PlanItem[];
  /** Whether the plan can be approved to proceed with full execution */
  allowApproval: boolean;
}

// ============================================================================
// Steering (Oh My Pi Agent.steer)
// ============================================================================

/**
 * A steering message that can be injected mid-run (Oh My Pi Agent.steer).
 * Steering messages are processed between LLM/tool calls, allowing users
 * to redirect the agent's behavior without aborting the run.
 */
export interface SteerMessage {
  id: string;
  message: string;
  /** ISO timestamp when added */
  timestamp: number;
  /** Priority — higher priority messages are processed first (default: 0) */
  priority?: number;
  /** Whether this steer should cancel current tool execution */
  abortCurrent?: boolean;
}

// ============================================================================
// Sub-Agents (Oh My Pi TaskExecutor)
// ============================================================================

/**
 * Handle to a spawned sub-agent. Used for tracking and result collection.
 */
export interface SubAgentHandle {
  id: string;
  goal: string;
  parentRunId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  /** Subset of tools this sub-agent is allowed to use */
  allowedTools?: string[];
  /** Result of the sub-agent execution */
  result?: AgentExecutionResult;
  /** Progress events from the sub-agent */
  events?: HarnessEvent[];
}

/**
 * Parameters for spawning a sub-agent.
 */
export interface SubAgentSpawnParams {
  /** The sub-agent's goal/instruction */
  goal: string;
  /** Subset of tools to allow (default: all parent tools) */
  allowedTools?: string[];
  /** Token budget for sub-agent (default: 25% of parent budget) */
  tokenBudget?: number;
  /** Max steps for sub-agent (default: half of parent max) */
  maxSteps?: number;
  /** Provider to use (default: inherit from parent) */
  provider?: string;
  /** Model to use (default: inherit from parent) */
  modelId?: string;
  /** Optional sub-agent role (e.g. "coder", "researcher") for trace correlation. */
  role?: string;
  /** Whether to run in parallel with parent (true) or block (false). Default: false */
  parallel?: boolean;
  /** Optional output schema */
  outputSchema?: Record<string, unknown>;
}

// ============================================================================
// Command Safety (Codex CLI)
// ============================================================================

/**
 * Safety classification for a command.
 */
export type CommandSafetyLevel =
  | 'safe'
  | 'caution'
  | 'risky'
  | 'dangerous'
  | 'unknown';

/**
 * Result of classifying a command's safety.
 */
export interface CommandClassification {
  level: CommandSafetyLevel;
  /** Human-readable description of what the command does */
  description: string;
  /** Patterns that triggered the classification */
  triggers: string[];
  /** Whether auto-execution is allowed at this safety level */
  autoExecuteAllowed: boolean;
  /** Recommended action */
  recommendation: 'allow' | 'warn' | 'block';
}

// ============================================================================
// Network Policy (Codex CLI MITM Proxy)
// ============================================================================

/**
 * Network access policy. Used to allow/deny outbound HTTP requests.
 */
export interface NetworkPolicy {
  /** Domain patterns allowed for outbound requests (e.g. ["api.openai.com"]) */
  allowedDomains: string[];
  /** Domain patterns explicitly blocked */
  blockedDomains: string[];
  /** Whether to allow private network ranges (10.x, 192.168.x, 127.x, ::1) */
  allowPrivateNetworks: boolean;
  /** Whether to allow file:// and other non-http protocols */
  allowLocalProtocols: boolean;
}

export interface NetworkCheckResult {
  allowed: boolean;
  reason: string;
  policy: 'allow' | 'deny' | 'ask';
  /** Matched domain pattern that triggered the decision */
  matchedPattern?: string;
}

// ============================================================================
// File Watcher (Codex CLI notify crate)
// ============================================================================

/**
 * A change event emitted by the file watcher.
 */
export interface FileChangeEvent {
  type: 'created' | 'modified' | 'deleted' | 'renamed';
  path: string;
  timestamp: number;
  /** For renames, the old path */
  oldPath?: string;
  /** File size in bytes (if known) */
  size?: number;
}

// ============================================================================
// Session Persistence (Codex CLI JSONL)
// ============================================================================

/**
 * Persisted session metadata. Codex CLI uses JSONL with schema versioning
 * for forward-compatible session history.
 */
export interface SessionInfo {
  id: string;
  goal: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  /** Run IDs in this session */
  runIds: string[];
  /** Schema version for forward compat */
  schemaVersion: number;
  /** Total tokens used in this session */
  totalTokens?: number;
  /** Total cost in USD */
  totalCostUsd?: number;
  /** Working directory when session was started */
  cwd?: string;
  /** User-defined tags for this session */
  tags?: string[];
}

// ============================================================================
// Skills System (Oh My Pi SKILL.md)
// ============================================================================

/**
 * Reference to a loaded skill. Skills are content blocks (typically SKILL.md
 * files) that can be injected into the system prompt.
 */
export interface SkillRef {
  id: string;
  name: string;
  description: string;
  /** Tags for skill discovery */
  tags: string[];
  /** Source of the skill (builtin/user/community) */
  source: 'builtin' | 'user' | 'community' | 'learned';
  /** Disclosure level — controls how much of the skill content is exposed */
  disclosure: 0 | 1 | 2;
  /** The skill content (markdown / instructions) */
  content: string;
}

// ============================================================================
// Event Stream (Oh My Pi AgentEvent)
// ============================================================================

/**
 * Events emitted by a harness during execution. Consumers (TUI, HTTP, plugins)
 * subscribe to these for real-time visibility into agent behavior.
 *
 * Modeled after Oh My Pi's AgentEvent union — a tagged union of all possible
 * events in an agent's lifecycle.
 */
export type HarnessEvent =
  | { type: 'run_start'; runId: string; goal: string; harness: string; timestamp: number }
  | { type: 'llm_request'; request: LLMRequest; runId: string; timestamp: number }
  | { type: 'llm_response'; response: LLMResponse; runId: string; timestamp: number }
  | { type: 'tool_call_start'; toolCall: ToolCall; intent?: Intent; runId: string; timestamp: number }
  | { type: 'tool_call_end'; toolCall: ToolCall; result: ToolResult; runId: string; timestamp: number }
  | { type: 'guardian_decision'; toolCall: ToolCall; decision: GuardianDecision; runId: string; timestamp: number }
  | { type: 'intent_extracted'; toolCall: ToolCall; intent: Intent; runId: string; timestamp: number }
  | { type: 'steer_message'; message: SteerMessage; runId: string; timestamp: number }
  | { type: 'compaction'; dropped: number; saved: number; runId: string; timestamp: number }
  | { type: 'plan_update'; items: PlanItem[]; runId: string; timestamp: number }
  | { type: 'plan_item_status'; itemId: string; status: PlanItemStatus; runId: string; timestamp: number }
  | { type: 'sub_agent_start'; handle: SubAgentHandle; runId: string; timestamp: number }
  | { type: 'sub_agent_end'; handle: SubAgentHandle; result: AgentExecutionResult; runId: string; timestamp: number }
  | { type: 'sub_agent_progress'; handle: SubAgentHandle; event: HarnessEvent; runId: string; timestamp: number }
  | { type: 'file_change'; event: FileChangeEvent; runId: string; timestamp: number }
  | { type: 'session_update'; info: SessionInfo; runId: string; timestamp: number }
  | { type: 'checkpoint'; phase: string; stepNumber: number; runId: string; timestamp: number }
  | { type: 'run_complete'; result: AgentExecutionResult; runId: string; timestamp: number }
  | { type: 'run_error'; error: string; runId: string; timestamp: number };

/**
 * Guardian decision (extracted to top-level so HarnessEvent can reference it).
 */
export interface GuardianDecision {
  approved: boolean;
  reason: string;
  /** If rejected, a suggested alternative approach */
  suggestion?: string;
  /** Confidence in the decision (0-1) */
  confidence?: number;
  /** Which policy/rules triggered the decision */
  triggers?: string[];
}

// ============================================================================
// Event Stream Subscription
// ============================================================================

/**
 * A handler for harness events. Used with the event stream subscription.
 */
export type HarnessEventHandler = (event: HarnessEvent) => void | Promise<void>;

/**
 * Returned from a subscription — call to unsubscribe.
 */
export type Unsubscribe = () => void;

// ============================================================================
// Harness Services (Strict Facade)
// ============================================================================

/**
 * Services provided to harness implementations.
 *
 * This is a STRICT facade — harnesses get access to specific Commander
 * infrastructure services without direct access to AgentRuntime internals.
 * This prevents circular dependencies and maintains testability.
 *
 * Every harness MUST use these services instead of instantiating its own
 * tools, caches, or checkpoints, so that Commander's tenant isolation,
 * metrics, and plugin hooks are always respected.
 */
export interface HarnessServices {
  // ── Provider & Tool Access ──
  getProvider(name: string): LLMProvider | undefined;
  getTool(name: string): Tool | undefined;
  getToolDefinition(name: string): ToolDefinition | undefined;
  listTools(): string[];

  // ── Caching ──
  cacheResult(call: ToolCall, result: ToolResult, tenantId?: string): void;
  getCachedResult(call: ToolCall, tenantId?: string): ToolResult | null;
  invalidateCache(pattern: string): void;

  // ── State Persistence ──
  checkpoint(state: {
    runId: string;
    phase: string;
    stepNumber: number;
    messages: LLMMessage[];
    tokenUsage: { totalTokens: number };
    error?: string;
  }): void;

  // ── Plugin System (Harnesses MUST fire standard CommanderPlugin hooks) ──
  fireBeforeLLMCall(ctx: { request: LLMRequest; agentId: string; runId: string }): Promise<LLMRequest>;
  fireAfterLLMCall(ctx: { request: LLMRequest; response: LLMResponse | null; agentId: string; runId: string }): Promise<void>;
  fireBeforeToolCall(ctx: { toolName: string; args: Record<string, unknown>; agentId: string; runId: string }): Promise<{ blocked: boolean; error?: string }>;
  fireAfterToolCall(ctx: { toolName: string; args: Record<string, unknown>; result: ToolResult; agentId: string; runId: string }): Promise<ToolResult>;
  fireOnAgentStart(ctx: { agentId: string; runId: string }): Promise<void>;
  fireOnAgentComplete(ctx: { result: AgentExecutionResult; runId: string }): Promise<void>;
  fireOnError(ctx: { error: string; runId: string; agentId: string }): Promise<void>;

  // ── Metrics ──
  recordLLMCall(model: string, provider: string, tokens: number, durationMs: number, tenantId?: string): void;
  recordToolCall(name: string, durationMs: number, error?: string, tenantId?: string): void;

  // ── Context Compaction ──
  compactMessages(messages: LLMMessage[], taskType?: string): { messages: LLMMessage[]; dropped: number; saved: number };

  // ── Content Safety ──
  scanContent(content: string): Promise<{ isSafe: boolean; threats: Array<{ type: string; severity: string }> }>;

  // ── Token Governance ──
  reportTokenUsage(tokens: number): void;
  getRemainingBudget(): number;
  isBudgetCritical(): boolean;

  // ── Event Stream (Oh My Pi AgentEvent pattern) ──
  publishEvent(event: HarnessEvent): void;
  subscribeEvents(handler: HarnessEventHandler): Unsubscribe;

  // ── Skills System (Oh My Pi SKILL.md) ──
  loadSkills(query?: { tags?: string[]; name?: string; limit?: number }): Promise<SkillRef[]>;
  injectSkill(skillId: string, currentSystemPrompt: string): Promise<string>;

  // ── Sub-Agents (Oh My Pi TaskExecutor) ──
  spawnSubAgent(params: SubAgentSpawnParams, parentRunId: string, tenantId?: string): Promise<SubAgentHandle>;
  waitForSubAgent(handle: SubAgentHandle, signal?: AbortSignal): Promise<AgentExecutionResult>;

  // ── File Watcher (Codex notify crate) ──
  watchFile(path: string, handler: (event: FileChangeEvent) => void): Unsubscribe;

  // ── Session Persistence (Codex JSONL) ──
  saveSession(info: SessionInfo): Promise<void>;
  loadSession(sessionId: string): Promise<SessionInfo | null>;
  listSessions(limit?: number): Promise<SessionInfo[]>;

  // ── Network Policy (Codex MITM proxy) ──
  checkNetworkPolicy(url: string, policy?: NetworkPolicy): NetworkCheckResult;

  // ── Command Safety (Codex is_known_safe_command) ──
  classifyCommand(command: string): CommandClassification;

  // ── Steer Queue (Oh My Pi Agent.steer) ──
  pushSteer(message: string, priority?: number, abortCurrent?: boolean): void;
  popSteer(): SteerMessage | null;
  drainSteerQueue(): SteerMessage[];

  // ── Patch Application (Codex apply_patch) ──
  applyPatch(request: PatchRequest): PatchResult;

  // ── Plan Mode (Codex CLI) ──
  updatePlanItem(itemId: string, update: Partial<PlanItem>): void;
  getPlanItems(): PlanItem[];
}

// ============================================================================
// Harness Run Parameters
// ============================================================================

/**
 * Parameters passed to AgentHarness.runAttempt() for a single agent execution.
 * Derived from AgentExecutionContext by the harness integration code.
 */
export interface HarnessRunParams {
  /** The agent's goal/instruction */
  goal: string;
  /** Initial LLM messages (built from goal + context) */
  messages: LLMMessage[];
  /** Names of available tools */
  availableTools: string[];
  /** Token budget for this run */
  tokenBudget: number;
  /** Maximum execution steps */
  maxSteps: number;
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Tenant ID for isolation */
  tenantId?: string;
  /** User ID */
  userId?: string;
  /** Provider routing decision */
  routing: { modelId: string; tier: ModelTier; provider: string; maxTokens: number };
  /** Harness services facade */
  services: HarnessServices;
  /** Optional output schema for structured output extraction */
  outputSchema?: Record<string, unknown>;
  /** Approval mode (Codex CLI) */
  approvalMode?: ApprovalMode;
  /** Reasoning effort (Codex CLI) */
  reasoningEffort?: ReasoningEffort;
  /** Plan mode configuration (Codex CLI) */
  planMode?: PlanModeConfig;
  /** Pre-loaded skill IDs to inject into system prompt */
  skills?: string[];
  /** Session ID for persistence (Codex CLI) */
  sessionId?: string;
  /** Network policy (Codex CLI) */
  networkPolicy?: NetworkPolicy;
}

// ============================================================================
// Selection Rule
// ============================================================================

/**
 * A rule that maps execution context characteristics to a harness name.
 * Rules are evaluated in priority order (highest first).
 */
export interface HarnessSelectionRule {
  /** Priority (higher = evaluated first). Use 100 for model-specific, 0 for fallback. */
  priority: number;
  /** Human-readable rule name for logging/debugging */
  name: string;
  /** Match function — return true if this rule applies */
  matcher: (ctx: HarnessSelectionContext) => boolean;
  /** Target harness name (must match AgentHarness.name) */
  harness: string;
  /** Optional: reason template for logging ({{model}} etc. replaced at match time) */
  reason?: string;
}

// ============================================================================
// AgentHarness — Primary Interface
// ============================================================================

/**
 * A pluggable agent execution backend.
 *
 * Each harness implements a complete agent loop strategy:
 * - DefaultHarness: wraps existing AgentRuntime (backward compatible)
 * - CodeAgentHarness: Oh My Pi + Codex CLI patterns (showcase)
 * - McpHarness: exposes Commander via Model Context Protocol
 *
 * Harnesses MUST use HarnessServices for all infrastructure access
 * (providers, tools, caching, hooks, metrics) to ensure Commander's
 * tenant isolation, plugin hooks, and observability are always respected.
 */
export interface AgentHarness {
  /** Unique harness identifier (e.g., "default", "code-agent", "mcp") */
  readonly name: string;

  /**
   * Check whether this harness supports the given execution context.
   * Called by HarnessRegistry.select() to find matching harnesses.
   */
  supports(ctx: HarnessSelectionContext): boolean;

  /**
   * Execute one agent run.
   *
   * The harness is responsible for the full agent loop:
   *   1. LLM call(s) via services.getProvider()
   *   2. Tool execution via services.getTool()
   *   3. Verification / compaction
   *   4. Firing standard CommanderPlugin hooks
   *   5. Returning a valid AgentExecutionResult
   *
   * The harness receives an AbortSignal and should respect it.
   */
  runAttempt(params: HarnessRunParams): Promise<AgentExecutionResult>;

  /**
   * Abort the current run attempt (if any).
   * Called when Commander needs to cancel an in-progress execution.
   */
  abort(): void;

  /**
   * Push a steering message into the current run (Oh My Pi Agent.steer).
   * Steering messages are processed between LLM/tool calls.
   * Default: no-op (harnesses without steering support ignore the message).
   */
  steer(message: string, priority?: number, abortCurrent?: boolean): void;

  /**
   * Subscribe to events from this harness's current/future runs.
   * Returns an unsubscribe function.
   */
  subscribe(handler: HarnessEventHandler): Unsubscribe;

  /**
   * Advertise capabilities for introspection and feature gating.
   */
  getCapabilities(): HarnessCapabilities;
}

// ============================================================================
// Harness Registry Config
// ============================================================================

/**
 * Configuration for the HarnessRegistry.
 */
export interface HarnessConfig {
  /** Enable harness selection (default: true). When disabled, always uses DefaultHarness. */
  enabled: boolean;
  /** If true, log every selection decision */
  verbose: boolean;
  /** Custom selection rules (appended after built-in rules) */
  customRules?: HarnessSelectionRule[];
  /** Default approval mode for all harnesses (Codex CLI) */
  defaultApprovalMode?: ApprovalMode;
  /** Default reasoning effort for all harnesses (Codex CLI) */
  defaultReasoningEffort?: ReasoningEffort;
  /** Default network policy for all harnesses (Codex CLI) */
  defaultNetworkPolicy?: NetworkPolicy;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  enabled: true,
  verbose: false,
  defaultApprovalMode: 'auto-edit',
  defaultReasoningEffort: 'medium',
};

// ============================================================================
// Built-in Rule Constants
// ============================================================================

/** Model prefixes that trigger the code-agent harness for power-tier models */
const POWER_CODE_MODELS = ['gpt-4', 'claude-opus', 'claude-sonnet', 'deepseek-v', 'mimo'];

/** Model prefixes that trigger the code-agent harness for standard-tier */
const STANDARD_CODE_MODELS = ['claude-sonnet', 'gpt-4o', 'deepseek', 'gemini-2'];

/**
 * Built-in selection rules.
 */
export const BUILTIN_HARNESS_RULES: HarnessSelectionRule[] = [
  // ── Priority 100: Power-tier code models → code-agent harness ──
  {
    priority: 100,
    name: 'power-code-models',
    matcher: (ctx) =>
      ctx.tier === 'power' &&
      POWER_CODE_MODELS.some((p) => ctx.model.startsWith(p)),
    harness: 'code-agent',
    reason: 'power model {{model}} → code-agent harness (full capability)',
  },

  // ── Priority 90: Standard-tier code models → code-agent harness ──
  {
    priority: 90,
    name: 'standard-code-models',
    matcher: (ctx) =>
      ctx.tier === 'standard' &&
      STANDARD_CODE_MODELS.some((p) => ctx.model.startsWith(p)),
    harness: 'code-agent',
    reason: 'standard model {{model}} → code-agent harness (balanced)',
  },

  // ── Priority 50: MCP server mode → mcp harness ──
  {
    priority: 50,
    name: 'mcp-server-mode',
    matcher: (ctx) => ctx.features.includes('mcp-server'),
    harness: 'mcp',
    reason: 'MCP server mode requested → mcp harness',
  },

  // ── Priority 0: Everything else → default harness (backward compatible) ──
  {
    priority: 0,
    name: 'fallback',
    matcher: () => true,
    harness: 'default',
    reason: 'fallback → default harness',
  },
];
