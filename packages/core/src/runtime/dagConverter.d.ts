/**
 * DAG-to-TaskTree converter and topological sort utilities.
 * Extracted from evolutionaryWorkflowEngine.ts to keep modules under 500 lines.
 */
import type { WorkflowDAG } from './evolutionaryWorkflowTypes';
import type { TaskTreeNode } from './types';
/**
 * Convert a WorkflowDAG to a TaskTreeNode hierarchy.
 */
export declare function dagToTaskTree(dag: WorkflowDAG): TaskTreeNode;
//# sourceMappingURL=dagConverter.d.ts.map