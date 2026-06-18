/**
 * CompensationQueue — durable, cross-process compensation retry queue.
 *
 * Closes the "in-memory compensation lost on crash" gap from the
 * reversibility audit. The legacy CompensationRegistry retries failed
 * compensations in-process only; if the process crashes mid-retry, the
 * compensation is lost. The ledger-based saga compensator (see RunLedger)
 * is crash-safe but requires the run to reach the ABORTED state via the
 * scheduler. This queue handles the edge case where:
 *   1. A mutation tool completed (side effect applied)
 *   2. A subsequent tool failed and the registry's in-memory retry
 *      exhausted
 *   3. The process crashed BEFORE the saga abort path ran
 *   4. A new process starts and needs to compensate the orphan mutation
 *
 * Behavior:
 *   - enqueue(): persist a new pending compensation
 *   - markInProgress(): atomically claim it (prevents double-compensation
 *     across processes)
 *   - markCompleted(): success — delete row
 *   - markFailed(): schedule next attempt with backoff
 *   - markEscalated(): after maxAttempts, move to escalated state for
 *     manual review via commander compensation list/retry <id>
 *   - retry(): force re-attempt of an escalated item
 *
 * Persistence: SQLite-backed (better-sqlite3). Per-tenant isolation via
 * tenant_id column. WAL mode for crash safety.
 *
 * Tier 2.4 of reversibility-rfc-v2 (M1 + M11).
 */
export type CompensationStatus = 'pending' | 'in_progress' | 'escalated';
export interface CompensationQueueItem {
    id: string;
    runId: string;
    agentId?: string;
    tenantId?: string;
    toolName: string;
    args: string;
    attemptCount: number;
    maxAttempts: number;
    status: CompensationStatus;
    lastError?: string;
    enqueuedAt: string;
    lastAttemptAt?: string;
    nextAttemptAt: string;
    compensationHandlerKey: string;
}
export interface CompensationQueueConfig {
    filePath?: string;
    /** Default 10. After this many attempts, item is escalated. */
    defaultMaxAttempts?: number;
    /** Backoff base in ms. Actual delay = base * 2^(attempt-1), capped. */
    backoffBaseMs?: number;
    /** Backoff cap in ms. */
    backoffMaxMs?: number;
}
export declare function defaultCompensationQueuePath(): string;
export declare class CompensationQueue {
    private db;
    private config;
    private stmtEnqueue;
    private stmtGet;
    private stmtList;
    private stmtListPending;
    private stmtClaim;
    private stmtComplete;
    private stmtFail;
    private stmtEscalate;
    private stmtRetry;
    private stmtCount;
    private stmtDelete;
    constructor(config?: Partial<CompensationQueueConfig>);
    private openDb;
    private prepareStatements;
    enqueue(input: {
        id: string;
        runId: string;
        agentId?: string;
        tenantId?: string;
        toolName: string;
        args: unknown;
        compensationHandlerKey: string;
        maxAttempts?: number;
    }): void;
    /**
     * Atomically claim the next due item for processing. Returns null if
     * no item is due. The atomic UPDATE prevents two processes from
     * compensating the same action.
     */
    claimNext(): CompensationQueueItem | null;
    markCompleted(id: string): void;
    markFailed(id: string, error: string, currentAttempt: number): 'pending' | 'escalated';
    markEscalated(id: string, error: string): void;
    /**
     * Force-retry an escalated item. Resets attempt_count to 0 and
     * schedules immediate next attempt.
     */
    retry(id: string): boolean;
    get(id: string): CompensationQueueItem | null;
    list(opts?: {
        limit?: number;
        status?: CompensationStatus;
    }): CompensationQueueItem[];
    countByStatus(): Record<CompensationStatus, number>;
    close(): void;
}
export declare function getCompensationQueue(): CompensationQueue;
export declare function resetCompensationQueueForTesting(): void;
//# sourceMappingURL=compensationQueue.d.ts.map