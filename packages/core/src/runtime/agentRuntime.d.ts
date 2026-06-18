/**
 * Agent Runtime — Core execution engine for the Commander agent loop.
 *
 * The central orchestrator that drives the LLM → Tools → Verification → Retry
 * cycle. Each call to execute() runs one full agent turn:
 *   1. Model routing (eco → standard → power)
 *   2. Tool selection & availability filtering
 *   3. LLM provider call with timeout & retry
 *   4. Tool execution with dependency-aware planning
 *   5. Verification via UnifiedVerificationPipeline
 *   6. State checkpointing (crash-safe atomic writes)
 *   7. Metrics collection & trace recording
 *
 * Integrates CircuitBreaker, TokenGovernor, ContextCompactor, CompensationRegistry,
 * DeadLetterQueue, CycleDetector, and all tool subsystems.
 */
import type { LLMProvider, AgentExecutionContext, AgentExecutionResult, AgentRuntimeConfig, Tool } from './types';
import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import { ModelRouter } from './modelRouter';
import { SmartModelRouter } from './smartModelRouter';
import { StateCheckpointer } from './stateCheckpointer';
import { type RunRecoveryResult } from './runRecovery';
import { StepTimeoutManager } from './stepTimeoutManager';
import { CompensationRegistry } from './compensationRegistry';
import { AgentInbox } from './agentInbox';
import { TeamRegistry } from './teamRegistry';
import { AgentHandoff } from './agentHandoff';
import { type SingleFlightStats } from './singleFlightRequestCache';
import { type GeminiCacheStats } from './geminiCacheManager';
import type { TenantProvider } from './tenantProvider';
import type { MemoryStore } from '../memory';
export declare class AgentRuntime implements AgentRuntimeInterface {
    private config;
    private providers;
    private tools;
    private router;
    private smartRouter;
    /** When false, the smart router is bypassed and the legacy routeWithCascade path runs even if a smartRouter instance exists. Default ON. */
    private smartRouterActive;
    private activeRuns;
    private pausedRuns;
    private compactor;
    private slidingWindow;
    private circuitBreaker;
    private verificationPipeline;
    private reflexionInjector;
    private governor;
    private samplesStore;
    private memory;
    private traceStore;
    private checkpointer;
    private dlq;
    private leaseManager;
    private reflexionGenerator;
    private stepTimeout;
    private fallbackChain;
    private lastPrefixCacheKey?;
    private compensationRegistry;
    private agentInbox;
    private teamRegistry;
    private agentHandoff;
    private toolCache;
    private semanticCache;
    private singleFlight;
    private geminiCache;
    private outputManager;
    private memoryStore;
    private otelExporter;
    private orchestrator;
    private queueTimer;
    private planner;
    private cycleDetector;
    /** Tools promoted to Tier 1 (full schema) in the current turn — for hallucination rejection gate */
    private promotedTools;
    private runHandle;
    /** Tracks successful mutation tool calls per retry attempt for rollback planning */
    private executedMutations;
    /** RunLedger transaction context (runId, leaseToken, fencingEpoch) */
    private ledgerCtx;
    private compensationEventSubscriber;
    private contentScanner;
    private conversationStore;
    private runningCount;
    private waitingQueue;
    private tenantProvider;
    private tenantRateLimits;
    private tenantRunningCounts;
    private tenantSamplesStores;
    private tenantTraceStores;
    private tenantCheckpointers;
    constructor(config?: Partial<AgentRuntimeConfig>, router?: ModelRouter, tenantProvider?: TenantProvider);
    /**
     * Handle a mutation tool failure by generating a rollback plan and triggering compensation.
     * Publishes a 'tool.compensation_planned' bus event with plan metadata.
     * For safe plans, auto-executes compensation via SagaCoordinator.
     */
    private handleMutationToolFailure;
    /**
     * Execute a compensation plan by iterating through steps and calling
     * compensationRegistry.compensate() for each recorded action.
     */
    private compensateViaSaga;
    /** Invalidate read caches after mutation tools succeed */
    private invalidateMutationCache;
    /**
     * Check if the same tool+args pattern appears ≥3 times in recent calls.
     * Uses stable (alphabetically-sorted) JSON.stringify for deterministic keys.
     * On detection, publishes system.alert, increments metrics, and writes intent log.
     * Returns { retryLoopDetected, count } — caller should break the execution loop.
     */
    private checkRetryLoop;
    registerProvider(name: string, provider: LLMProvider): void;
    registerTool(name: string, tool: Tool): void;
    getProvider(name: string): LLMProvider | undefined;
    getSmartRouter(): SmartModelRouter | null;
    /**
     * Live toggle for SmartModelRouter participation. When false, the runtime
     * falls back to the legacy `routeWithCascade` path even if a smart router
     * instance exists. Default ON at construction. Idempotent.
     */
    setSmartModelRouterEnabled(enabled: boolean): void;
    /** Current state of the SmartModelRouter toggle (for diagnostics). */
    isSmartModelRouterEnabled(): boolean;
    getTool(name: string): Tool | undefined;
    getConfig(): AgentRuntimeConfig;
    /** Access the persistent memory store (SqliteMemoryStore, JsonMemoryStore, etc.) or null if using default in-memory. */
    getMemoryStore(): MemoryStore | null;
    /** Access the state checkpointer for crash recovery and run inspection. */
    getCheckpointer(): StateCheckpointer;
    getInbox(): AgentInbox;
    getTeamRegistry(): TeamRegistry;
    getHandoff(): AgentHandoff;
    getExecutionScheduler(): import("../atr/scheduler").ExecutionScheduler;
    getCompensationRegistry(): CompensationRegistry;
    /** Cancel all in-flight steps managed by the StepTimeoutManager.
     *  Used during graceful shutdown to abort hung tool executions. */
    cancelAllSteps(): number;
    /** Access the step timeout manager for shutdown coordination. */
    getStepTimeoutManager(): StepTimeoutManager;
    /**
     * Resolve tenant context: enforce rate limits, concurrency limits, and set up
     * tenant-scoped storage instances. Returns overrides that must be restored in finally.
     */
    private resolveTenantContext;
    /**
     * Restore tenant overrides after run completes or fails.
     */
    private restoreTenantOverrides;
    /**
     * Execute an agent task end-to-end.
     * Wraps entire body in try/finally to guarantee cleanup (GAP-02, GAP-05).
     * Enforces maxConcurrency via semaphore (GAP-07).
     */
    execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult>;
    private callWithTimeout;
    /** Thin forwarder that adapts callProvider's nullable return for ProviderFallbackChain.
     *  ProviderFallbackChain treats non-throwing returns as success, so we throw on null. */
    private callProviderOrThrow;
    private callProvider;
    /** Tier 4.4 helper: estimate cost of a failed step and attribute it to a failure mode. */
    private recordCostByFailureMode;
    /**
     * Execute a tool call and return STRUCTURED error context to the model.
     * Instead of silently logging errors, the model receives enough context
     * to reason about the failure and decide next steps.
     */
    private executeTool;
    /** Register default compensation handlers for mutation tools */
    private registerDefaultCompensation;
    private generateActionId;
    private acquireSlot;
    private releaseSlot;
    /**
     * List runs that crashed (have checkpoints but no terminal state).
     * Callers can use this to present a resume UI or auto-resume.
     */
    listUnfinishedRuns(): Array<{
        runId: string;
        phase: string;
        timestamp: string;
    }>;
    /** Tier 1.2: Resume a crashed run using the full RunRecovery pipeline.
     *  Validates the lease, reconstructs completedToolCallIds from checkpoint
     *  messages, and returns a result suitable for continuing from the last step.
     *  Returns null if the checkpoint is not found or the lease was lost.
     */
    resume(runId: string, tenantId?: string): Promise<RunRecoveryResult | null>;
    /** List all runs that have recoverable checkpoints (non-terminal phases). */
    listResumableRuns(): Array<{
        runId: string;
        phase: string;
        timestamp: string;
    }>;
    /**
     * Signal a running execution to pause at the next checkpoint boundary.
     * Returns true if the run was active and pause was signaled, false otherwise.
     */
    pauseRun(runId: string): boolean;
    /**
     * Clear the pause flag for a run (e.g., after resume).
     */
    unpauseRun(runId: string): void;
    isPaused(runId: string): boolean;
    /**
     * List all active runs with their pause state.
     * Returns an array of { runId, paused, checkpointPhase }.
     */
    getActiveRuns(): Array<{
        runId: string;
        paused: boolean;
        checkpointPhase?: string;
    }>;
    getActiveRunCount(): number;
    isRunActive(runId: string): boolean;
    getSemanticCacheStats(): import("./semanticCache").SemanticCacheStats;
    getSingleFlightStats(): SingleFlightStats;
    getGeminiCacheStats(): GeminiCacheStats;
    getCostEstimatorHistory(): import("./costEstimator").HistoricalTaskCost[][];
    /** Tier 4.3: Return a per-provider health snapshot for the dashboard. */
    getProviderHealth(): Array<{
        provider: string;
        state: string;
        errorRate: number;
        requestCount: number;
        lastFailureAt: number;
    }>;
    /** Dispose sub-resources (timers, file handles) when this runtime is discarded */
    dispose(): void;
}
//# sourceMappingURL=agentRuntime.d.ts.map