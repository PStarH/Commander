/**
 * SOP (Standard Operating Procedure) Template Export
 *
 * Takes a successful multi-agent execution trace and extracts a structured
 * template that can be reused as few-shot context for future runs.
 *
 * The SOP template captures:
 *   - Task decomposition: how the original goal was split into sub-tasks
 *   - Tool call chains: which tools were called in what order, with what args
 *   - Agent handoffs: how sub-agents were delegated and results synthesized
 *   - Key decisions: critical branching points and their reasoning
 *   - I/O contracts: input/output schemas for each phase
 *
 * Output: structured JSON + Markdown template suitable for few-shot injection.
 */
import type { ExecutionTrace, AgentExecutionResult } from './types';
export interface SOPPhase {
    /** Phase name (e.g. 'analysis', 'implementation', 'verification') */
    name: string;
    /** Phase description */
    description: string;
    /** Tools used during this phase */
    toolsUsed: string[];
    /** Key decisions made */
    decisions: SOPDecision[];
    /** Outcome of this phase */
    outcome: string;
    /** Agent role that executed this phase */
    agentRole?: string;
}
export interface SOPDecision {
    description: string;
    toolName?: string;
    inputSummary?: string;
    outputSummary?: string;
}
export interface SOPTemplate {
    /** SOP schema version */
    schemaVersion: number;
    /** Original goal that produced this SOP */
    goal: string;
    /** When the original execution ran */
    executedAt: string;
    /** Source execution run ID */
    sourceRunId: string;
    /** Number of steps in the original run */
    totalSteps: number;
    /** Total tokens consumed */
    totalTokens: number;
    /** Total duration in ms */
    totalDurationMs: number;
    /** Model used */
    modelUsed: string;
    /** Topology used (if multi-agent) */
    topology?: string;
    /** Phases of execution */
    phases: SOPPhase[];
    /** Full tool call chain (chronological) */
    toolCallChain: SOPToolCall[];
    /** Index of key files read/written */
    files: SOPFileAccess[];
    /** Summary of what this SOP accomplishes */
    summary: string;
    /** Tags for retrieval */
    tags: string[];
}
export interface SOPToolCall {
    stepNumber: number;
    toolName: string;
    phase: string;
    args: Record<string, unknown>;
    resultSnippet: string;
    durationMs: number;
    hadError: boolean;
}
export interface SOPFileAccess {
    path: string;
    action: 'read' | 'write' | 'edit';
    summary: string;
}
/**
 * Generate an SOP template from an execution trace.
 * Returns null if the trace has insufficient data.
 */
export declare function exportSOPFromTrace(trace: ExecutionTrace): SOPTemplate | null;
/**
 * Generate an SOP template from an AgentExecutionResult (runtime output).
 */
export declare function exportSOPFromResult(result: AgentExecutionResult): SOPTemplate | null;
/**
 * Format an SOP template as a markdown string suitable for few-shot injection.
 */
export declare function formatSOPAsMarkdown(sop: SOPTemplate): string;
/**
 * Format an SOP template as a structured JSON object (for reuse in memory/context).
 */
export declare function formatSOPAsContext(sop: SOPTemplate): Record<string, unknown>;
//# sourceMappingURL=sopExport.d.ts.map