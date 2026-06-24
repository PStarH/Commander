/**
 * AgentExecutionState — mutable execution state shared by all phase modules.
 *
 * Phase modules receive `(ctx, state)` and return an updated state. The
 * orchestrator (the new thin `execute()` facade in `agentRuntime.ts`) owns
 * ONE state object per agent run; phase classes ARE NOT permitted to mutate
 * the AgentRuntime instance's private fields directly.
 *
 * Status: Step 0 / Step 1 — only the lifecycle / checkpointing-relevant fields
 * are populated today. Other fields are pre-declared so later steps can
 * populate them without API churn.
 */

import type {
  AgentExecutionContext,
  AgentExecutionStep,
  AgentExecutionResult,
  LLMRequest,
  RoutingDecision,
  TokenUsage,
} from '../types';
import type { TenantConfig } from '../tenantProvider';
import type { ModelConfig } from '../types/routing';
import type { ToolDefinition, ToolCall } from '../types/tool';
import type { ProjectContext } from '../projectContextLoader';
import type { CostEstimate } from '../costEstimator';
import type { PlannedToolCall } from '../../compensation/rollbackPlanner';

/**
 * Per-tenant override reference object previously held as a private interface
 * inside `agentRuntime.ts` (`TenantOverrides`). Reproduced here for cross-phase
 * visibility. The shape matches the original declaration 1:1.
 */
export interface TenantOverrides {
  origSamplesStore: import('../samplesStore').SamplesStore;
  origTraceStore: import('../traceStore').PersistentTraceStore;
  origCheckpointer: import('../stateCheckpointer').StateCheckpointer;
  origMemory: import('../../threeLayerMemory').ThreeLayerMemory | null;
  origGovernor: import('../tokenGovernor').TokenGovernor;
}

/**
 * Single tool-execution result row used by the Phase 4 toolExecution phase.
 * Plain shape — duplicates the inline type used in the 4,000-line execute()
 * method so phase modules don't have to import a private type.
 */
export interface ToolStoreEntry {
  toolCallId: string;
  name: string;
  output: string;
  error?: string;
  durationMs: number;
}

/**
 * Phases emitted via `this.checkpointer.checkpoint(...)` and
 * `this.checkpointer.terminalCheckpoint(...)`. Stable on disk; update only via
 * additive changes (old phases preserved as keys forever).
 */
export type CheckpointPhaseLabel =
  | 'started'
  | 'tool_execution'
  | 'verification'
  | 'interrupted'
  | 'completed_early_exit'
  | 'completed'
  | 'failed';

/**
 * The shared state object that flows between phase modules during a single
 * agent run. Lifecycle / checkpoint phase (Phase 7) populates the
 * `phaseCheckpointIds`, `lineageTag`, and `crashRecoveryHints` fields.
 */
export interface AgentExecutionState {
  // ── Identity ─────────────────────────────────────────────────────────
  readonly runId: string;
  readonly agentId: string;
  readonly missionId?: string;
  readonly tenantId?: string;
  readonly parentRunId?: string;
  readonly subAgentDepth: number;
  readonly subAgentRole?: string;

  // ── Lifecycle ────────────────────────────────────────────────────────
  startedAt: number;
  currentLane?: string;
  steps: AgentExecutionStep[];
  totalTokenUsage: TokenUsage;

  // ── Tenant / governance ──────────────────────────────────────────────
  tenantConfig?: TenantConfig;
  tenantOverrides?: TenantOverrides;
  intentLogTenantId?: string;

  // ── Routing (Phase 2) ────────────────────────────────────────────────
  routing?: RoutingDecision;
  escalationChain: ModelConfig[];
  batchRouting?: RoutingDecision;
  costEstimate?: CostEstimate;
  cacheKey?: string;
  cacheHit?: boolean;

  // ── Prompts (Phase 3) ────────────────────────────────────────────────
  toolDefs: ToolDefinition[];
  promotedTools: Set<string>;
  registrySummary?: string;
  activeProjectContext?: ProjectContext;
  injectedContextTokens: number;
  contextParts: string[];
  llmRequest?: LLMRequest;

  // ── Loop (Phase 4) ───────────────────────────────────────────────────
  promptCheckpointed: boolean;
  maxIterations: number;
  toolLoopCount: number;
  cycleDetected: boolean;
  retryLoopDetected: boolean;
  retryLoopCount: number;
  recentToolPatterns: string[];
  interruptData: { reason: string; value: unknown } | null;
  cumulativeEvidence: number;
  largestFileWriteContent: string;
  largestFileWritePath: string;
  lastError?: string;
  lastErrorIsPermanent: boolean;
  attempt: number;

  // ── Tool execution (Phase 5) ─────────────────────────────────────────
  rawResults: ToolStoreEntry[];
  cachedResults: ToolStoreEntry[];
  executedMutations: PlannedToolCall[];

  // ── Cleanup (Phase 6) ────────────────────────────────────────────────
  status: AgentExecutionResult['status'];
  summary: string;
  error?: string;
  artifactContent?: string;
  artifactPath?: string;
  interrupt?: AgentExecutionResult['interrupt'];
  compensationResults: Array<{ toolName: string; actionId: string; status: string }>;

  // ── Checkpointing (Phase 7) ──────────────────────────────────────────
  phaseCheckpointIds: Partial<Record<CheckpointPhaseLabel, string>>;
  lineageTag?: string;
  crashRecoveryHints: string[];
  pauseRequested: boolean;
}

/**
 * Build the initial state object at the top of `execute()`. Sub-phases mutate
 * only the fields they own. The orchestrator keeps a stable reference.
 */
export function createInitialAgentExecutionState(ctx: AgentExecutionContext): AgentExecutionState {
  return {
    // Identity
    runId: ctx.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    agentId: ctx.agentId,
    missionId: ctx.missionId,
    tenantId: ctx.tenantId,
    parentRunId: ctx.parentRunId,
    subAgentDepth: ctx.subAgentDepth ?? 0,
    subAgentRole: ctx.subAgentRole,

    // Lifecycle
    startedAt: Date.now(),
    currentLane: undefined,
    steps: [],
    totalTokenUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
    },

    // Tenant
    tenantConfig: undefined,
    tenantOverrides: undefined,
    intentLogTenantId: ctx.tenantId,

    // Routing
    routing: undefined,
    escalationChain: [],
    batchRouting: undefined,
    costEstimate: undefined,
    cacheKey: undefined,
    cacheHit: false,

    // Prompts
    toolDefs: [],
    promotedTools: new Set<string>(),
    registrySummary: undefined,
    activeProjectContext: undefined,
    injectedContextTokens: 0,
    contextParts: [],
    llmRequest: undefined,

    // Loop
    promptCheckpointed: false,
    maxIterations: Math.max(ctx.maxSteps ?? 10, 20),
    toolLoopCount: 0,
    cycleDetected: false,
    retryLoopDetected: false,
    retryLoopCount: 0,
    recentToolPatterns: [],
    interruptData: null,
    cumulativeEvidence: 0,
    largestFileWriteContent: '',
    largestFileWritePath: '',
    lastError: undefined,
    lastErrorIsPermanent: false,
    attempt: 0,

    // Tools
    rawResults: [],
    cachedResults: [],
    executedMutations: [],

    // Cleanup
    status: 'partial',
    summary: '',
    error: undefined,
    artifactContent: undefined,
    artifactPath: undefined,
    interrupt: undefined,
    compensationResults: [],

    // Checkpointing
    phaseCheckpointIds: {},
    lineageTag: undefined,
    crashRecoveryHints: [],
    pauseRequested: false,
  };
}

/** Payload passed to CheckpointingPhase.checkpointStart(). */
export interface CheckpointStartPayload {
  request: LLMRequest;
  projectContext: ProjectContext;
}

/** Payload passed to CheckpointingPhase.checkpointAfterStep(). */
export interface CheckpointStepPayload {
  request: LLMRequest;
  attempt: number;
  stepNumber: number;
  /**
   * Optional `lastError` for the 'verification' checkpoint (which adds
   * `lastError` to its persisted payload). Tool-execution checkpoints
   * omit this field.
   */
  lastError?: string;
}

/** Payload passed to CheckpointingPhase.checkpointTerminal(). */
export interface CheckpointTerminalPayload {
  request: LLMRequest;
  attempt: number;
  stepNumber: number;
  /** For `failed`: propagate lastError so recovery knows what broke. */
  lastError?: string;
  exitSummary?: string;
}

// Re-export the ToolCall type for downstream phase modules.
export type { ToolCall };
