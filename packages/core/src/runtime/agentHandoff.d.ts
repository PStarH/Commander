import type { AgentInbox } from './agentInbox';
import type { StateCheckpointer } from './stateCheckpointer';
export type HandoffStatus = 'requested' | 'accepted' | 'rejected' | 'completed' | 'failed';
/**
 * Typed work order — replaces free-form message passing with a structured schema.
 * Every handoff includes { goal, completedSteps, remainingTasks, artifacts, constraints }
 * so the receiving agent has a clear, unambiguous mandate.
 */
export interface WorkOrder {
    /** The overarching goal of this handoff */
    goal: string;
    /** Steps already completed by the sending agent */
    completedSteps: string[];
    /** Steps remaining for the receiving agent */
    remainingTasks: string[];
    /** Artifacts produced so far (file paths, data references) */
    artifacts: Array<{
        name: string;
        type: string;
        reference: string;
    }>;
    /** Constraints or guardrails the receiving agent must respect */
    constraints: string[];
}
/**
 * Context summary — a compressed ≤500-token summary of the sending agent's
 * execution history, replacing the full message array.
 */
export interface ContextSummary {
    /** Brief description of what was done */
    executedPlan: string;
    /** Key findings or intermediate results */
    findings: string[];
    /** Decisions made that affect downstream work */
    decisions: string[];
    /** Current environment state */
    environmentSnapshot: string;
    /** Remaining open questions */
    openQuestions: string[];
}
export interface HandoffRequest {
    handoffId: string;
    fromAgent: string;
    toAgent: string;
    goal: string;
    context: {
        missionId?: string;
        runId?: string;
        /** Typed work order — the structured mandate */
        workOrder: WorkOrder;
        /** Compressed summary (≤500 tokens) — replaces full message history */
        contextSummary: ContextSummary;
        /** Full messages — OPTIONAL, only included when explicitly requested or when summary is insufficient */
        messages?: Array<{
            role: string;
            content: string;
        }>;
        intermediateResults?: string[];
        availableTools: string[];
        tokenBudget: number;
        checkpointId?: string;
    };
    status: HandoffStatus;
    createdAt: string;
    resolvedAt?: string;
    response?: string;
}
export declare class AgentHandoff {
    private inbox;
    private checkpointer?;
    private handoffs;
    private readonly UNRESOLVED_TTL_MS;
    private pruneTimer;
    constructor(inbox: AgentInbox, checkpointer?: StateCheckpointer);
    /** Prune handoffs that have been in a non-terminal state for too long */
    private pruneUnresolved;
    /** Agent A initiates a handoff to Agent B */
    request(handoff: Omit<HandoffRequest, 'status' | 'createdAt'>): Promise<HandoffRequest>;
    /** Agent B accepts a handoff — returns the context needed to continue */
    accept(handoffId: string, response?: string): Promise<HandoffRequest | null>;
    /** Agent B rejects a handoff */
    reject(handoffId: string, reason: string): Promise<HandoffRequest | null>;
    /** Mark a handoff as completed */
    complete(handoffId: string): void;
    /** Remove resolved handoffs older than 10 minutes to prevent unbounded growth */
    pruneResolved(maxAgeMs?: number): number;
    /** Get handoff details */
    getHandoff(handoffId: string): HandoffRequest | undefined;
    /** List handoffs for an agent */
    listForAgent(agentId: string): HandoffRequest[];
    /**
     * Build a structured WorkOrder from execution context.
     * Replaces free-form message passing with a typed schema.
     */
    static buildWorkOrder(params: {
        goal: string;
        completedSteps?: string[];
        remainingTasks?: string[];
        artifacts?: Array<{
            name: string;
            type: string;
            reference: string;
        }>;
        constraints?: string[];
    }): WorkOrder;
    /**
     * Generate a compressed ≤500-token ContextSummary from messages.
     * Extracts key phases, findings, decisions, and environment state
     * without passing the full message history.
     */
    static generateSummary(messages: Array<{
        role: string;
        content: string;
    }>): ContextSummary;
    /**
     * Truncate a ContextSummary so its JSON representation is ≤ maxTokens.
     * Reduces field lengths proportionally, never deletes fields entirely.
     */
    private static capSummaryToTokens;
    /**
     * Shorthand: build both work order and context summary in one call.
     */
    static createHandoffContext(params: {
        goal: string;
        completedSteps?: string[];
        remainingTasks?: string[];
        artifacts?: Array<{
            name: string;
            type: string;
            reference: string;
        }>;
        constraints?: string[];
        messages?: Array<{
            role: string;
            content: string;
        }>;
        includeFullMessages?: boolean;
    }): Pick<HandoffRequest['context'], 'workOrder' | 'contextSummary' | 'messages'>;
    dispose(): void;
}
//# sourceMappingURL=agentHandoff.d.ts.map