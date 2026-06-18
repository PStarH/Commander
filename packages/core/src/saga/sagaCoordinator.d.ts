import type { SagaGraph, SagaContext, SagaResult, SagaRunOptions, SagaRunHandle, SagaStateSnapshot, NodeState, RunState } from './types';
import { ExecutionGraph } from './executionGraph';
import { CheckpointManager } from './checkpointManager';
import { CompensationScheduler, type DeadLetterSink } from './compensationScheduler';
import { ApprovalManager } from './approvalManager';
import { WorkerPool } from './workerPool';
export interface SagaCoordinatorOptions {
    checkpoint: CheckpointManager;
    approval: ApprovalManager;
    compensation?: CompensationScheduler;
    workerPool?: WorkerPool;
    deadLetter?: DeadLetterSink;
    clock?: () => Date;
    idGenerator?: () => string;
}
export declare class SagaCoordinator {
    private readonly graphValue;
    private readonly ctx;
    private readonly checkpointMgr;
    private readonly approvalMgr;
    private readonly graph;
    private readonly nodeStates;
    private readonly childRunIds;
    private sagaState;
    private fencingEpoch;
    private error?;
    private intentHash;
    private checkpointVersion;
    private createdAt;
    private updatedAt;
    private tenantId?;
    private parentRunId?;
    private cancelController;
    private compensation;
    private workerPool;
    private clock;
    private idGenerator;
    private results;
    constructor(graphValue: ExecutionGraph, ctx: SagaContext, checkpointMgr: CheckpointManager, approvalMgr: ApprovalManager, options: SagaCoordinatorOptions);
    get state(): RunState;
    getNodeState(id: string): NodeState | undefined;
    get snapshot(): SagaStateSnapshot;
    cancel(): void;
    run(options?: SagaRunOptions): Promise<SagaResult>;
    private executeSequence;
    private executeNode;
    private executeStep;
    private executeParallel;
    private executeNested;
    private executeApproval;
    private handleFailure;
    private collectCompensablePath;
    private makeResult;
    private persist;
    private serializeNodeStates;
    private appendEvent;
    private eventFor;
    private runWithTimeout;
    private computeBackoff;
    private sleep;
    private combineSignals;
}
export declare class SagaAbortedError extends Error {
    constructor(message: string);
}
export declare class SagaNodeError extends Error {
    readonly nodeId: string;
    readonly nodeName: string;
    readonly cause: Error;
    constructor(nodeId: string, nodeName: string, cause: Error);
}
export declare class SagaCoordinatorError extends Error {
    constructor(message: string);
}
export declare function runSaga(graph: SagaGraph, context: SagaContext, checkpoint: CheckpointManager, approval: ApprovalManager, options?: Partial<SagaCoordinatorOptions>): Promise<SagaResult>;
export interface RunningSaga {
    result: Promise<SagaResult>;
    cancel(): void;
    snapshot(): SagaStateSnapshot;
    getNodeState(id: string): NodeState | undefined;
}
export declare function startSaga(graph: SagaGraph, context: SagaContext, checkpoint: CheckpointManager, approval: ApprovalManager, options?: Partial<SagaCoordinatorOptions>): RunningSaga;
export declare function attachSagaHandle(runId: string, coord: SagaCoordinator): SagaRunHandle;
//# sourceMappingURL=sagaCoordinator.d.ts.map