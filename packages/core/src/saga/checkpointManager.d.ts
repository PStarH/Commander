import type { SagaStateSnapshot, SagaEvent, RunState, NodeState } from './types';
import type { SagaStore } from './sagaStore';
export interface RecoveredState {
    snapshot: SagaStateSnapshot;
    eventsAfterSnapshot: SagaEvent[];
    allEvents: SagaEvent[];
}
export declare class CheckpointManager {
    private readonly store;
    constructor(store: SagaStore);
    saveSnapshot(snapshot: SagaStateSnapshot): Promise<void>;
    loadSnapshot(runId: string): Promise<SagaStateSnapshot | undefined>;
    appendEvent(event: SagaEvent): Promise<void>;
    loadEvents(runId: string): Promise<SagaEvent[]>;
    recover(runId: string): Promise<RecoveredState | undefined>;
    deleteRun(runId: string): Promise<void>;
    createSnapshot(params: {
        runId: string;
        state: RunState;
        intentHash: string;
        fencingEpoch: number;
        nodeStates: Record<string, NodeState>;
        parentRunId?: string;
        childRunIds?: string[];
        error?: string;
        tenantId?: string;
        previous?: SagaStateSnapshot;
    }): SagaStateSnapshot;
}
export declare class CheckpointError extends Error {
    constructor(message: string);
}
export declare function snapshotFor(runId: string, state: RunState, nodeStates: Record<string, NodeState>): SagaStateSnapshot;
//# sourceMappingURL=checkpointManager.d.ts.map