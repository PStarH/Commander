/**
 * RunRecovery — load a checkpoint and resume execution.
 *
 * Closes the "automatic resume from checkpoint" gap from the reversibility audit.
 * Without this, a crashed run has to be manually restarted from scratch, losing
 * all completed tool results and wasting tokens re-executing them.
 *
 * Recovery flow:
 *   1. Load latest checkpoint via checkpointer.loadCheckpoint()
 *   2. Validate lease (checkpointer enforces fencing internally)
 *   3. Reconstruct completed-tool-call set from steps
 *   4. Return resume state for AgentRuntime to continue from
 */
import { StateCheckpointer, type CheckpointState } from './stateCheckpointer';
import type { LeaseManager } from '../atr/leaseManager';
export type RecoveryStatus = 'recovered' | 'fenced' | 'not_found' | 'lease_lost';
export interface RunRecoveryResult {
    status: RecoveryStatus;
    resumeFromStep?: number;
    completedToolCallIds: Set<string>;
    state?: CheckpointState;
    errorMessage?: string;
}
export interface RunRecoveryOptions {
    tenantId?: string;
    maxLeaseAgeMs?: number;
}
export declare class RunRecovery {
    private checkpointer;
    private leaseManager;
    constructor(checkpointer: StateCheckpointer, leaseManager: LeaseManager);
    attempt(runId: string, options?: RunRecoveryOptions): Promise<RunRecoveryResult>;
    listRecoverableRuns(): Array<{
        runId: string;
        phase: string;
        timestamp: string;
    }>;
}
//# sourceMappingURL=runRecovery.d.ts.map