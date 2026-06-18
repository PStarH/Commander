/**
 * ExecutionScheduler — the single ATR entry point.
 *
 * Owns: run lease, idempotency, checkpoint version, saga state machine.
 * Composes: LeaseManager + IdempotencyStore + RunLedger + CompensationBridge + StateCheckpointer.
 *
 * Every state-mutating call is lease-validated. A zombie process that resumes
 * a run gets its writes rejected at the boundary, not at the side effect.
 *
 * State machine (from RunLedger):
 *   PENDING → EXECUTING → VERIFYING → COMMITTED
 *                         \→ ABORTED → COMPENSATED
 *
 * The scheduler is a stateless facade: the run state lives in the ledger.
 * `beginRun / resumeRun` return a RunHandle — a snapshot of the lease
 * credentials + state at call time. Pass them back to every subsequent
 * schedule/commit/abort call. The scheduler does NOT cache them.
 */
import type { CheckpointState } from '../runtime/stateCheckpointer';
import { StateCheckpointer } from '../runtime/stateCheckpointer';
import type { CompensableAction } from '../runtime/compensationRegistry';
import type { CompensationHandler } from '../runtime/compensationRegistry';
import type { RunState, RunTransaction } from './types';
import { LeaseManager } from './leaseManager';
import { IdempotencyStore } from './idempotencyStore';
import { RunLedger, type CompensationOutcome } from './runLedger';
import { CompensationBridge } from './compensationBridge';
export interface BeginRunInput {
    runId?: string;
    goal: string;
    intent?: string;
    intentHash?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    ttlSeconds?: number;
    holder?: string;
}
export interface RunHandle {
    runId: string;
    state: RunState;
    leaseToken: string;
    fencingEpoch: number;
    intentHash: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
    resumed: boolean;
    acquired: boolean;
}
export interface ScheduleActionInput {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    toolName: string;
    externalSystem: string;
    args: Record<string, unknown>;
    idempotencyKey: string;
    compensable: boolean;
    tags?: string[];
    description?: string;
    tenantId?: string;
}
export interface ScheduleActionResult {
    replayed: boolean;
    actionId: string;
    cachedResult?: string;
    cachedError?: string;
}
export interface CommitResult {
    committed: boolean;
    reason?: 'fenced' | 'not_found';
}
export interface AbortResult {
    aborted: boolean;
    reason?: 'fenced' | 'not_found';
    outcome: CompensationOutcome;
}
export interface KillResult {
    killed: boolean;
    reason?: 'fenced' | 'not_found';
}
export interface SchedulerCheckpointInput {
    state: CheckpointState;
    tenantId?: string;
}
export interface ExecutionSchedulerOptions {
    lease: LeaseManager;
    idempotency: IdempotencyStore;
    ledger: RunLedger;
    bridge: CompensationBridge;
    checkpointer?: StateCheckpointer;
}
export declare class ExecutionScheduler {
    private lease;
    private idempotency;
    private ledger;
    private bridge;
    private checkpointer?;
    constructor(opts: ExecutionSchedulerOptions);
    beginRun(input: BeginRunInput): RunHandle;
    scheduleAction(input: ScheduleActionInput): ScheduleActionResult | null;
    recordResult(input: {
        runId: string;
        leaseToken: string;
        fencingEpoch: number;
        actionId: string;
        result: string;
        tenantId?: string;
    }): void;
    recordError(input: {
        runId: string;
        leaseToken: string;
        fencingEpoch: number;
        actionId: string;
        error: string;
        tenantId?: string;
    }): void;
    commitRun(input: {
        runId: string;
        leaseToken: string;
        fencingEpoch: number;
        tenantId?: string;
    }): CommitResult;
    abortRun(input: {
        runId: string;
        leaseToken: string;
        fencingEpoch: number;
        reason: string;
        tenantId?: string;
        maxAttempts?: number;
    }): Promise<AbortResult>;
    resumeRun(input: {
        runId: string;
        tenantId?: string;
    }): RunHandle | null;
    getRun(input: {
        runId: string;
        tenantId?: string;
    }): RunTransaction | null;
    listActions(input: {
        runId: string;
        tenantId?: string;
        limit?: number;
    }): CompensableAction[];
    killRun(input: {
        runId: string;
        leaseToken: string;
        fencingEpoch: number;
        tenantId?: string;
    }): KillResult;
    heartbeat(input: {
        runId: string;
        leaseToken: string;
        tenantId?: string;
        ttlSeconds?: number;
    }): boolean;
    checkpoint(input: SchedulerCheckpointInput): boolean;
    listRuns(input?: {
        state?: RunState;
        tenantId?: string;
    }): RunTransaction[];
    registerCompensation(toolName: string, handler: CompensationHandler): void;
    registerDefaultCompensations(): void;
}
export declare function getExecutionScheduler(): ExecutionScheduler;
export declare function resetExecutionScheduler(): void;
//# sourceMappingURL=scheduler.d.ts.map