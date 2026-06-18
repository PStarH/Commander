import type { HumanApprovalGate, NodeRiskLevel } from './types';
export type ApprovalDecision = 'approve' | 'reject' | 'modify';
export interface ApprovalRequest {
    approvalId: string;
    runId: string;
    nodeId: string;
    nodeGoal: string;
    gate: HumanApprovalGate;
    riskLevel: NodeRiskLevel;
    requesterId: string;
    requestedAt: string;
}
export interface ApprovalResolution {
    approvalId: string;
    decision: ApprovalDecision;
    approverId: string;
    note?: string;
    resolvedAt: string;
    timedOut: boolean;
}
export type ApprovalListener = (resolution: ApprovalResolution) => void;
export declare class HumanApprovalManager {
    private pending;
    private responses;
    private readonly DEFAULT_DECISION_ON_TIMEOUT;
    request(request: Omit<ApprovalRequest, 'approvalId' | 'requestedAt'>): ApprovalRequest;
    /**
     * Wait for an approval request to resolve. Resolves with the
     * resolution (decision + metadata) or with the timeout decision.
     */
    awaitResolution(approvalId: string): Promise<ApprovalResolution>;
    /**
     * Record a human response. The first response wins; subsequent
     * responses for the same approvalId are ignored.
     */
    respond(approvalId: string, approverId: string, decision: ApprovalDecision, note?: string): ApprovalResolution | null;
    /** Inspect a pending request without resolving it. */
    getPending(approvalId: string): ApprovalRequest | null;
    /** List all currently pending approval IDs. */
    listPending(runId?: string): string[];
    /** Cancel all pending approvals for a run. Used when an execution is aborted. */
    cancelAllForRun(runId: string, reason?: string): number;
    /** Drop resolved entries older than the given age in ms. Default 1 hour. */
    pruneResolved(maxAgeMs?: number): number;
}
export declare function getHumanApprovalManager(): HumanApprovalManager;
export declare function resetHumanApprovalManager(): void;
//# sourceMappingURL=humanApprovalManager.d.ts.map