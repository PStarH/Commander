import type { WorkQueueStore } from './workQueueStore';
export type WorkStatus = 'PENDING' | 'CLAIMED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REASSIGNED';
export interface WorkItem {
    id: string;
    runId: string;
    parentNodeId: string;
    goal: string;
    tools: string[];
    dependsOn: string[];
    status: WorkStatus;
    claimedBy?: string;
    claimedAt?: string;
    completedAt?: string;
    failedAt?: string;
    attempts: number;
    maxAttempts: number;
    lastError?: string;
    tokenBudget: number;
    priority: number;
    createdAt: string;
    leaseToken?: string;
    fencingEpoch?: number;
}
export type WorkEvent = {
    type: 'enqueued';
    item: WorkItem;
} | {
    type: 'claimed';
    item: WorkItem;
    agentId: string;
} | {
    type: 'started';
    item: WorkItem;
    agentId: string;
} | {
    type: 'completed';
    item: WorkItem;
    agentId: string;
} | {
    type: 'failed';
    item: WorkItem;
    agentId: string;
    error: string;
} | {
    type: 'reassigned';
    item: WorkItem;
    fromAgent: string;
    reason: string;
} | {
    type: 'terminal';
    item: WorkItem;
    agentId: string;
    error: string;
};
export type WorkEventHandler = (event: WorkEvent) => void;
export interface EnqueueInput {
    runId: string;
    parentNodeId: string;
    goal: string;
    tools: string[];
    dependsOn?: string[];
    maxAttempts?: number;
    tokenBudget?: number;
    priority?: number;
}
export interface ClaimFilter {
    tools?: string[];
    runId?: string;
    agentId?: string;
    parentNodeId?: string;
}
export interface TeamStatus {
    runId: string;
    total: number;
    pending: number;
    claimed: number;
    running: number;
    completed: number;
    failed: number;
    reassigned: number;
    byAgent: Record<string, {
        claimed: number;
        running: number;
        completed: number;
        failed: number;
    }>;
    pendingByAgent: Record<string, number>;
}
export interface WorkCoordinatorConfig {
    store?: WorkQueueStore;
}
export declare class WorkCoordinator {
    private items;
    private handlers;
    private counter;
    private store;
    constructor(config?: WorkCoordinatorConfig);
    private recover;
    enqueue(input: EnqueueInput | EnqueueInput[]): WorkItem[];
    claim(agentId: string, filter?: ClaimFilter): WorkItem | null;
    start(workId: string, agentId: string): boolean;
    complete(workId: string, agentId: string, result?: unknown): boolean;
    fail(workId: string, agentId: string, error: string): WorkItem | null;
    reassign(workId: string, reason: string): WorkItem | null;
    list(filter?: {
        runId?: string;
        status?: WorkStatus;
        agentId?: string;
    }): WorkItem[];
    getTeamStatus(runId: string): TeamStatus;
    subscribe(handler: WorkEventHandler): () => void;
    clear(runId?: string): number;
    private dependenciesMet;
    private hasCycle;
    private reassignInternal;
    private emit;
    private publishBus;
    private enforceRetention;
    private generateId;
}
export declare function getWorkCoordinator(config?: WorkCoordinatorConfig): WorkCoordinator;
export declare function resetWorkCoordinator(): void;
//# sourceMappingURL=workCoordinator.d.ts.map