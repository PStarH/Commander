/**
 * Tool Orchestrator — Approval → Sandbox → Execute → Retry
 *
 * Surpasses Codex's orchestrator pattern by adding:
 * 1. Approval gate integration (uses existing ToolApproval)
 * 2. Sandbox selection based on tool risk profile
 * 3. Retry with escalation (retry same → retry with modified args → skip)
 * 4. Timeout cascade (per-tool → per-batch → per-turn)
 * 5. Circuit breaker per tool (stop retrying a broken tool)
 *
 * This is the single entry point for all tool execution in the runtime.
 */
import type { ToolCall, ToolResult, Tool } from './types';
import type { ToolApproval } from './toolApproval';
import { CircuitBreakerRegistry } from './circuitBreakerRegistry';
export interface OrchestratorConfig {
    /** Enable orchestration (default: true) */
    enabled: boolean;
    /** Per-tool timeout in ms (default: 30000) */
    defaultToolTimeoutMs: number;
    /** Per-turn timeout in ms (default: 120000) */
    turnTimeoutMs: number;
    /** Max retries per tool call (default: 1) */
    maxRetries: number;
    /** Whether to use approval gate (default: false) */
    useApproval: boolean;
    /** Circuit breaker: consecutive failures before disabling tool (default: 3) */
    circuitBreakerThreshold: number;
    /** Circuit breaker: cooldown in ms (default: 60000) */
    circuitBreakerCooldownMs: number;
    /** Per-tool timeout overrides */
    toolTimeouts: Record<string, number>;
}
export interface ToolExecutionContext {
    runId: string;
    agentId: string;
    stepNumber: number;
    tenantId?: string;
}
export interface ToolExecutionPlan {
    /** Tools to execute concurrently (no side effects) */
    concurrent: ToolCall[];
    /** Tools to execute serially (side effects) */
    serial: ToolCall[];
    /** Tools skipped due to approval rejection */
    skipped: Array<{
        toolCall: ToolCall;
        reason: string;
    }>;
    /** Tools skipped due to circuit breaker */
    circuitBroken: Array<{
        toolCall: ToolCall;
        toolName: string;
    }>;
}
export interface OrchestratedResult {
    results: ToolResult[];
    plan: ToolExecutionPlan;
    totalDurationMs: number;
    retriedCount: number;
    approvalRejectedCount: number;
}
export declare class ToolOrchestrator {
    private config;
    private approval?;
    private breakerRegistry;
    constructor(config?: Partial<OrchestratorConfig>, approval?: ToolApproval);
    /**
     * Build an execution plan: partition tools into concurrent/serial,
     * check approvals, check circuit breakers.
     */
    planExecution(toolCalls: ToolCall[], tools: Map<string, Tool>): Promise<ToolExecutionPlan>;
    /**
     * Execute a batch of tool calls according to the plan.
     * Handles timeouts, retries, and circuit breaker updates.
     */
    execute(plan: ToolExecutionPlan, tools: Map<string, Tool>, context: ToolExecutionContext): Promise<OrchestratedResult>;
    /**
     * Execute a single tool call with retry logic and circuit breaker.
     */
    private executeSingleWithRetry;
    private computeIdempotencyKey;
    /**
     * Format a structured error message for the model.
     */
    private formatError;
    private isCircuitOpen;
    private recordSuccess;
    private recordFailure;
    getCircuitState(toolName: string): {
        isOpen: boolean;
        failures: number;
    };
    resetCircuit(toolName: string): void;
    resetAllCircuits(): void;
    getBreakerRegistry(): CircuitBreakerRegistry;
    /**
     * Check the current approval mode against a tool name.
     * Returns 'denied' when the mode blocks this tool type, 'approved' otherwise.
     */
    private checkApprovalMode;
}
//# sourceMappingURL=toolOrchestrator.d.ts.map