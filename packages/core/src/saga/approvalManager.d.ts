export interface ApprovalRequest {
    runId: string;
    nodeId: string;
    approver: string;
    payload: unknown;
    contextSummary?: string;
    requestedAt: string;
    expiresAt?: string;
    sagaName?: string;
    tenantId?: string;
}
export type ApprovalDecision = 'approve' | 'reject';
export interface ApprovalResult {
    decision: ApprovalDecision;
    decidedAt: string;
    decidedBy: string;
    reason?: string;
}
export interface ApprovalStore {
    create(request: ApprovalRequest): Promise<void>;
    get(runId: string, nodeId: string): Promise<ApprovalRequest | undefined>;
    record(request: ApprovalRequest, result: ApprovalResult): Promise<void>;
    outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined>;
    listPending(approver: string): Promise<ApprovalRequest[]>;
    delete(runId: string, nodeId: string): Promise<void>;
}
export declare class InMemoryApprovalStore implements ApprovalStore {
    private readonly records;
    private key;
    create(request: ApprovalRequest): Promise<void>;
    get(runId: string, nodeId: string): Promise<ApprovalRequest | undefined>;
    record(request: ApprovalRequest, result: ApprovalResult): Promise<void>;
    outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined>;
    listPending(approver: string): Promise<ApprovalRequest[]>;
    delete(runId: string, nodeId: string): Promise<void>;
}
export interface FileApprovalStoreOptions {
    baseDir: string;
}
export declare class FileApprovalStore implements ApprovalStore {
    private readonly options;
    constructor(options: FileApprovalStoreOptions);
    private pathFor;
    private ensureDir;
    create(request: ApprovalRequest): Promise<void>;
    get(runId: string, nodeId: string): Promise<ApprovalRequest | undefined>;
    record(request: ApprovalRequest, result: ApprovalResult): Promise<void>;
    outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined>;
    listPending(approver: string): Promise<ApprovalRequest[]>;
    delete(runId: string, nodeId: string): Promise<void>;
    private readRecord;
    private exists;
}
export interface ApprovalManagerOptions {
    store: ApprovalStore;
}
export interface ApprovalWaitOptions {
    pollIntervalMs?: number;
    signal?: AbortSignal;
}
export declare class ApprovalManager {
    private readonly options;
    constructor(options: ApprovalManagerOptions);
    request(req: ApprovalRequest): Promise<void>;
    decide(runId: string, nodeId: string, result: ApprovalResult): Promise<void>;
    outcome(runId: string, nodeId: string): Promise<ApprovalResult | undefined>;
    waitForDecision(runId: string, nodeId: string, options?: ApprovalWaitOptions): Promise<ApprovalResult>;
    listPending(approver: string): Promise<ApprovalRequest[]>;
    cancel(runId: string, nodeId: string): Promise<void>;
    private sleep;
}
export declare class ApprovalError extends Error {
    constructor(message: string);
}
export declare class ApprovalStoreError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=approvalManager.d.ts.map