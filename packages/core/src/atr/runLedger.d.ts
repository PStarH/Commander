/**
 * RunLedger — P0-2 ATR kernel component.
 *
 * The "settlement" half of the kernel. Coordinates the run state machine
 * (PENDING → EXECUTING → VERIFYING → COMMITTED / ABORTED → COMPENSATED),
 * persists every CompensableAction, and integrates with:
 *
 *   - LeaseManager      → process fencing (zombie rejection)
 *   - IdempotencyStore  → tool-call dedup across retries/replays
 *   - CompensationRegistry (runtime) → saga-style undo
 *
 * Why a separate ledger and not just "use CompensationRegistry"?
 *   CompensationRegistry is in-memory and per-AgentRuntime. The ledger is
 *   crash-safe (SQLite) and is the source of truth for "what side effects
 *   have we already taken on behalf of this runId?" — across process
 *   restarts, across worker migrations, across tenant boundaries.
 *
 * The ledger's compensateAll() iterates the persisted action list in
 * REVERSE execution order, calling the registered compensation handler for
 * each. This is the actual saga semantics the old CompensationRegistry
 * never delivered.
 *
 * Tenancy: the SQLite key is SHA256(tenantId || "::" || runId), so each
 * tenant's run records are physically isolated.
 */
import type { CompensableAction, RunState, RunTransaction } from './types';
import { LeaseManager, type AcquireResult } from './leaseManager';
import { IdempotencyStore } from './idempotencyStore';
export interface RunLedgerConfig {
    filePath: string;
    defaultTtlSeconds: number;
    defaultHolder: string;
    defaultIdempotencyTtlSeconds: number;
}
export type CompensationHandler = (action: CompensableAction) => Promise<{
    success: boolean;
    error?: string;
}>;
export interface StartRunInput {
    runId?: string;
    intentHash: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    ttlSeconds?: number;
    holder?: string;
}
export interface RecordActionInput {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
    actionId?: string;
    toolName: string;
    externalSystem: string;
    args: Record<string, unknown>;
    idempotencyKey: string;
    compensable: boolean;
    tags?: string[];
    description?: string;
}
export interface CompensationOutcome {
    attempted: number;
    succeeded: number;
    failed: number;
    errors: Array<{
        actionId: string;
        toolName: string;
        error: string;
    }>;
}
export declare class RunLedger {
    private db;
    private config;
    private leaseManager;
    private idempotencyStore;
    private handlers;
    private stmtGetTx;
    private stmtInsertTx;
    private stmtUpdateTxState;
    private stmtAppendAction;
    private stmtListActions;
    private stmtGetAction;
    private stmtUpdateActionResult;
    private stmtUpdateActionError;
    private stmtMarkCompensated;
    private stmtListUncompensated;
    private stmtListByState;
    constructor(config?: Partial<RunLedgerConfig>);
    constructor(leaseManager: LeaseManager, idempotencyStore: IdempotencyStore, config?: Partial<RunLedgerConfig>);
    private openDb;
    private prepareStatements;
    /**
     * Register a compensation handler for a tool. The handler is invoked by
     * abortAndCompensate() in reverse execution order. A handler that returns
     * success=false (or throws) is retried up to maxAttempts; persistent failure
     * is reported in the CompensationOutcome.
     */
    registerCompensation(toolName: string, handler: CompensationHandler): void;
    /**
     * Start a new run. Acquires a lease and persists a PENDING transaction.
     * If the runId already exists, returns the existing transaction (idempotent).
     */
    start(input: StartRunInput): {
        lease: AcquireResult;
        tx: RunTransaction;
    };
    /**
     * Transition a run to EXECUTING. Validates the lease token + epoch before
     * updating. Returns false if the caller is fenced.
     */
    beginExecuting(runId: string, leaseToken: string, fencingEpoch: number, options?: {
        tenantId?: string;
    }): boolean;
    /**
     * Transition a run to VERIFYING. Same lease validation as beginExecuting.
     */
    beginVerifying(runId: string, leaseToken: string, fencingEpoch: number, options?: {
        tenantId?: string;
    }): boolean;
    /**
     * Mark the run as committed (terminal success). No compensation runs.
     */
    commit(runId: string, leaseToken: string, fencingEpoch: number, options?: {
        tenantId?: string;
    }): boolean;
    /**
     * Record a compensable action against the run. Persists immediately so
     * even a synchronous crash leaves the side-effect on the books for later
     * compensation. Validates the lease before writing.
     */
    recordAction(input: RecordActionInput): CompensableAction | null;
    /**
     * Persist a tool's result (or error) on its action record. Idempotent.
     */
    recordResult(actionId: string, result: string): void;
    recordError(actionId: string, error: string): void;
    /**
     * Abort the run and compensate every still-pending action in REVERSE
     * execution order. This is the saga implementation the runtime used to
     * delegate (incorrectly) to CompensationRegistry.
     *
     * Non-compensable actions are skipped with a logged warning. Handlers
     * are retried up to 3 times each. Persistent failures are reported in
     * the CompensationOutcome.errors array (for the dead-letter / ops queue).
     */
    abortAndCompensate(runId: string, leaseToken: string, fencingEpoch: number, errorMessage: string, options?: {
        tenantId?: string;
        maxAttempts?: number;
    }): Promise<{
        aborted: boolean;
        outcome: CompensationOutcome;
    }>;
    /** Load a run transaction by id. */
    getTransaction(runId: string, options?: {
        tenantId?: string;
    }): RunTransaction | null;
    /** List all runs in a given state (e.g. 'ABORTED' for ops triage). */
    listByState(state: RunState, options?: {
        tenantId?: string;
    }): RunTransaction[];
    private loadActions;
    private rowToAction;
    close(): void;
    /** Close the owned LeaseManager and IdempotencyStore (when this ledger owns them). */
    closeOwnedResources(): void;
}
export declare function getRunLedgerBundle(): {
    lease: LeaseManager;
    idempotency: IdempotencyStore;
    ledger: RunLedger;
};
export declare function resetRunLedgerBundle(): void;
//# sourceMappingURL=runLedger.d.ts.map