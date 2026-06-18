/**
 * Recursive Atomizer - ROMA-inspired task decomposition.
 *
 * ROMA (Recursive Open Meta-Agents) decomposes goals into dependency-aware
 * subtask trees that can be executed in parallel. The Atomizer determines
 * whether a task should be decomposed (non-atomic) or executed directly (atomic).
 */
import type { TaskTreeNode, DeliberationPlan } from './types';
export declare class RecursiveAtomizer {
    private maxDepth;
    private maxSubtasks;
    private nodeCounter;
    constructor(maxDepth?: number, maxSubtasks?: number);
    decompose(goal: string, deliberation: DeliberationPlan, parentId?: string | null, depth?: number, availableTools?: string[]): TaskTreeNode;
    private shouldBeAtomic;
    private generateSubtasks;
    private decomposeByAspect;
    private decomposeByStep;
    private decomposeRecursive;
    /**
     * Split text at semantic boundaries (paragraphs, sentences) instead of
     * arbitrary character positions. This preserves meaning and avoids
     * mid-sentence splits that confuse sub-agents.
     */
    private splitAtSemanticBoundaries;
    /**
     * Group items into chunks that respect a target size, joining with the separator.
     */
    private groupBySize;
    private buildSystemPrompt;
    private getTaskTypeGuidance;
}
//# sourceMappingURL=atomizer.d.ts.map