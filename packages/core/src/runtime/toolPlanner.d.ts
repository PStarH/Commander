/**
 * Tool Planner — Dependency-Aware Scheduling
 *
 * Surpasses OpenClaw's buildToolPlan by implementing:
 * 1. DAG-based dependency resolution between tool calls
 * 2. Automatic parallel/sequential partitioning
 * 3. Critical path analysis for optimal ordering
 * 4. Resource conflict detection (e.g., two writes to same file)
 * 5. Speculative execution hints for read-only tools
 *
 * The planner analyzes a set of tool calls and produces an optimal
 * execution schedule that respects dependencies while maximizing parallelism.
 */
import type { ToolCall, Tool } from './types';
export interface DependencyEdge {
    /** Tool call that must complete first */
    from: string;
    /** Tool call that depends on the first */
    to: string;
    /** Why this dependency exists */
    reason: string;
}
export interface ResourceConflict {
    /** The conflicting resource (e.g., file path, URL) */
    resource: string;
    /** Tool calls that access this resource */
    toolCallIds: string[];
    /** Whether this is a write-write conflict (must serialize) */
    isWriteWrite: boolean;
}
export interface ExecutionStage {
    /** Stage index (0 = first to execute) */
    index: number;
    /** Tool calls in this stage (can run in parallel) */
    toolCalls: ToolCall[];
    /** Estimated duration in ms (max of all tools in stage) */
    estimatedDurationMs: number;
}
export interface ExecutionPlan {
    /** Ordered execution stages */
    stages: ExecutionStage[];
    /** Dependencies that were detected */
    dependencies: DependencyEdge[];
    /** Resource conflicts that required serialization */
    conflicts: ResourceConflict[];
    /** Total estimated duration in ms */
    estimatedDurationMs: number;
    /** Whether any parallelism was found */
    hasParallelism: boolean;
    /** Tool calls that can be speculatively pre-executed */
    speculativeCandidates: string[];
}
export declare class ToolPlanner {
    /**
     * Analyze a set of tool calls and produce an optimal execution plan.
     */
    plan(toolCalls: ToolCall[], tools: Map<string, Tool>): ExecutionPlan;
    /**
     * Detect implicit dependencies between tool calls.
     * Heuristics:
     * - Write→Read on same resource: read depends on write
     * - Write→Write on same resource: serialize
     * - Tool output used as input to another: dependency
     */
    private detectDependencies;
    /**
     * Detect resource conflicts between tool calls.
     */
    private detectConflicts;
    /**
     * Build execution stages using topological sort.
     * Each stage contains tool calls that can run in parallel.
     */
    private buildStages;
    /**
     * Find tool calls that are good candidates for speculative pre-execution.
     * These are read-only tools with no incoming dependencies.
     */
    private findSpeculativeCandidates;
    /**
     * Check if a tool call is read-only (no side effects).
     */
    private isReadOnly;
    /**
     * Check if a tool call is safe for speculative execution.
     * Must be read-only AND not expensive.
     */
    private isSpeculativelySafe;
    /**
     * Find a shared resource between two tool calls.
     */
    private findSharedResource;
    /**
     * Extract resource identifiers from a tool call's arguments.
     */
    private extractResources;
    /**
     * Check if tool call b has a data dependency on tool call a.
     * Heuristic: if b's arguments reference a's name or output format.
     */
    private hasDataDependency;
    /**
     * Estimate execution duration for a tool call.
     */
    private estimateDuration;
}
//# sourceMappingURL=toolPlanner.d.ts.map