import type { SlimMissionCard, CommanderRunContextV2 } from './types';
/**
 * Task complexity metrics for decomposition decisions.
 * Based on ACONIC framework: constraint graph properties (treewidth + graph size).
 */
export interface TaskComplexity {
    /** Intrinsic complexity - higher means harder to solve directly */
    treewidth: number;
    /** Size of the constraint graph (number of constraints/dependencies) */
    graphSize: number;
    /** Maximum depth of task dependencies */
    dependencyDepth: number;
    /** Estimated number of subtasks if decomposed */
    estimatedSubtasks: number;
    /** Complexity classification */
    level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}
/**
 * Task dependency edge for building dependency graph.
 */
export interface TaskDependency {
    from: string;
    to: string;
    type: 'SEQUENTIAL' | 'PARALLEL' | 'CONDITIONAL';
    strength: 'WEAK' | 'MEDIUM' | 'STRONG';
}
/**
 * Task node for complexity analysis.
 */
export interface TaskNode {
    id: string;
    /** Number of input constraints/requirements */
    inputCount: number;
    /** Number of output constraints/deliverables */
    outputCount: number;
    /** Estimated cognitive load (1-10) */
    cognitiveLoad: number;
    /** Whether task requires external resources */
    requiresExternalResources: boolean;
    /** Dependencies on other tasks */
    dependencies: string[];
}
/**
 * Options for complexity measurement.
 */
export interface TaskComplexityOptions {
    /** Maximum dependency depth before forcing decomposition */
    maxDependencyDepth?: number;
    /** Threshold for treewidth to trigger decomposition */
    treewidthThreshold?: number;
    /** Maximum estimated subtasks before overengineering warning */
    maxSubtasks?: number;
}
/**
 * Measure task complexity based on dependency graph.
 */
export declare function measureTaskComplexity(task: TaskNode, allTasks: TaskNode[], options?: TaskComplexityOptions): TaskComplexity;
/**
 * Decision: Should this task be decomposed into subtasks?
 */
export declare function shouldDecompose(complexity: TaskComplexity, options?: TaskComplexityOptions): {
    decompose: boolean;
    reason: string;
};
/**
 * Get decomposition recommendation for a mission based on current run context.
 */
export declare function getMissionDecompositionRecommendation(mission: SlimMissionCard, context: CommanderRunContextV2): {
    decompose: boolean;
    complexity: TaskComplexity;
    reason: string;
};
//# sourceMappingURL=taskComplexity.d.ts.map