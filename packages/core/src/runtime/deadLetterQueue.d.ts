import type { ErrorClass } from './llmRetry';
export type DLQCategory = 'llm' | 'tool' | 'execution' | 'verification' | 'circuit_breaker' | 'compensation' | 'semantic_drift';
/**
 * Tier 4.1: Standardized failure-mode discriminator. Each DLQ entry should
 * include a `mode:<FailureMode>` tag so operators can filter by cause
 * (timeout, rate_limit, auth, etc.) rather than parsing free-form messages.
 */
export type FailureMode = 'timeout' | 'rate_limit' | 'auth' | 'validation' | 'compilation' | 'execution' | 'provider_unavailable' | 'budget_exceeded' | 'verification' | 'compensation_exhausted' | 'cascade_escalation' | 'subagent_limit' | 'circuit_open' | 'semantic_degradation' | 'unknown';
export declare const failureModeTag: (mode: FailureMode) => string;
export interface DeadLetterEntry {
    id: string;
    category: DLQCategory;
    runId: string;
    agentId: string;
    missionId?: string;
    timestamp: string;
    errorClass: ErrorClass;
    errorMessage: string;
    retryable: boolean;
    attemptNumber: number;
    /** Name of the operation that failed */
    operationName: string;
    /** Snapshot of input args or request at time of failure */
    inputSnapshot?: string;
    /** Token usage before failure */
    tokenUsage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    /** Whether a compensation action was executed */
    compensated: boolean;
    /** Whether the failure was recovered (retry succeeded) */
    recovered: boolean;
    /** Tags for filtering */
    tags: string[];
}
export declare class DeadLetterQueue {
    private baseDir;
    private buffers;
    private lineCounts;
    constructor(baseDir?: string);
    record(entry: DeadLetterEntry): void;
    /**
     * Convenience: enqueue from partial spec. Fills sensible defaults for
     * the DeadLetterEntry required fields. Used by observability hooks
     * (circuit breaker, compensation, sub-agent) that don't have a full
     * run context.
     */
    enqueue(spec: {
        category: DLQCategory;
        runId?: string;
        agentId?: string;
        missionId?: string;
        operationName: string;
        errorMessage: string;
        errorClass?: ErrorClass;
        retryable?: boolean;
        attemptNumber?: number;
        compensated?: boolean;
        recovered?: boolean;
        tags?: string[];
        failureMode?: FailureMode;
        failureModeNumber?: number;
        payload?: Record<string, unknown>;
    }): void;
    private static readonly MAX_ENTRIES_PER_FILE;
    flush(category?: DLQCategory): void;
    readEntries(category: DLQCategory, limit?: number): DeadLetterEntry[];
    /**
     * Get retryable entries: transient failures that haven't been recovered.
     * Useful for automated retry scheduling.
     */
    getRetryableEntries(category: DLQCategory, limit?: number): DeadLetterEntry[];
    getStats(): {
        category: string;
        count: number;
    }[];
}
//# sourceMappingURL=deadLetterQueue.d.ts.map