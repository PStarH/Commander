import { ExecPolicyEngine } from './execPolicy';
export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto' | 'read-only' | 'plan';
export type ApprovalCategory = 'sandbox_escape' | 'network' | 'file_write' | 'file_read' | 'shell_exec' | 'destructive' | 'mcp';
export interface ApprovalGate {
    category: ApprovalCategory;
    action: string;
    reason?: string;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
}
export interface ApprovalRequest {
    id: string;
    timestamp: number;
    gate: ApprovalGate;
    toolName: string;
    toolArgs: Record<string, unknown>;
    agentId: string;
    runId: string;
}
export type ApprovalDecision = 'approved' | 'denied' | 'approved_once' | 'approved_session' | 'denied_forever';
export interface ApprovalCallback {
    (request: ApprovalRequest): Promise<ApprovalDecision>;
}
export declare class ApprovalSystem {
    private mode;
    private callback;
    private sessionApprovals;
    private deniedForever;
    private static readonly MAX_CACHE_SIZE;
    private execPolicy;
    private static readonly DENIED_THRESHOLD;
    private persistFile;
    constructor(execPolicy?: ExecPolicyEngine, persistDir?: string);
    setMode(mode: ApprovalMode): void;
    getMode(): ApprovalMode;
    private persistMode;
    private loadMode;
    setCallback(cb: ApprovalCallback): void;
    clearSessionApprovals(): void;
    evaluate(req: ApprovalRequest): Promise<{
        decision: ApprovalDecision;
        reason: string;
    }>;
    private evaluatePolicy;
    private evaluateMode;
}
export declare function getApprovalSystem(): ApprovalSystem;
export declare function resetApprovalSystem(): void;
//# sourceMappingURL=approval.d.ts.map