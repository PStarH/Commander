/**
 * StateCheckpointer — Crash-safe execution state persistence for AgentRuntime.
 *
 * Writes a JSON snapshot of mutable execution state after every LLM call,
 * tool execution cycle, and verification. Atomic writes (write to tmp, rename)
 * prevent corruption. Enables crash recovery and long-running workflow resilience.
 */
import type { LLMMessage, TokenUsage } from './types';
import type { LeaseManager } from '../atr/leaseManager';
export interface CheckpointState {
    runId: string;
    agentId: string;
    missionId?: string;
    timestamp: string;
    phase: 'started' | 'llm_call' | 'tool_execution' | 'verification' | 'completed' | 'completed_early_exit' | 'failed' | 'interrupted';
    stepNumber: number;
    attemptNumber: number;
    messages: LLMMessage[];
    tokenUsage: TokenUsage;
    stepDurations: number[];
    context: {
        agentId: string;
        missionId?: string;
        projectId: string;
        goal: string;
        availableTools: string[];
        maxSteps: number;
        tokenBudget: number;
        /** Cache key of loaded project context files, for resumability. */
        projectContextCacheKey?: string;
        /** Project context files read at run start. */
        projectContextFiles?: string[];
    };
    lastError?: string;
    totalDurationMs: number;
    /** ATR lease token — required when StateCheckpointer is bound to a LeaseManager. */
    leaseToken?: string;
    /** ATR fencing epoch — must match the live lease for the write to be accepted. */
    fencingEpoch?: number;
    /** Monotonic version of this checkpoint file; bumped on every successful write. */
    version?: number;
}
export declare class StateCheckpointer {
    private baseDir;
    private tenantId?;
    private leaseManager?;
    private pruneCounter;
    constructor(baseDir?: string, tenantId?: string, options?: {
        leaseManager?: LeaseManager;
    });
    setLeaseManager(leaseManager: LeaseManager | undefined): void;
    /**
     * Validate that `state` carries a live lease on `runId`. Bumps `state.version`
     * monotonically before write. Returns false (and skips the write) if fenced.
     * When no LeaseManager is bound, validation is a no-op and the write proceeds.
     */
    private authorize;
    checkpoint(state: CheckpointState): void;
    terminalCheckpoint(state: CheckpointState): void;
    resume(runId: string): CheckpointState | null;
    listCheckpoints(): {
        runId: string;
        phase: string;
        timestamp: string;
    }[];
    deleteCheckpoint(runId: string): void;
    prune(keepCount: number): void;
    /** Release any resources held by this checkpointer. */
    dispose(): void;
    /**
     * Load the latest checkpoint for a run. Returns null if no checkpoint exists.
     * If a LeaseManager is bound, validates the lease before returning.
     */
    loadCheckpoint(runId: string): CheckpointState | null;
    private _readFile;
}
//# sourceMappingURL=stateCheckpointer.d.ts.map