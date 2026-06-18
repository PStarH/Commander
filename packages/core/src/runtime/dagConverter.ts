/**
 * DAG-to-TaskTree converter and topological sort utilities.
 * Extracted from evolutionaryWorkflowEngine.ts to keep modules under 500 lines.
 */

import type { WorkflowNode, WorkflowEdge, WorkflowDAG } from './evolutionaryWorkflowTypes';
import type { TaskTreeNode, ROMARole } from './types';

/**
 * Convert a WorkflowDAG to a TaskTreeNode hierarchy.
 */
export function dagToTaskTree(dag: WorkflowDAG): TaskTreeNode {
  if (dag.nodes.length === 0) {
    return {
      id: 'root',
      goal: 'empty',
      parentId: null,
      role: 'EXECUTOR' as ROMARole,
      isAtomic: true,
      status: 'PENDING' as const,
      subtasks: [],
      dependencies: [],
      context: {
        systemPrompt: '',
        availableTools: [],
        estimatedTokens: 0,
      },
    };
  }

  // Topological sort
  const topoOrder = topologicalSort(dag);

  const buildNode = (workflowNode: WorkflowNode, index: number): TaskTreeNode => ({
    id: workflowNode.id,
    parentId: null,
    goal: workflowNode.goal,
    role: 'EXECUTOR' as ROMARole,
    isAtomic: true,
    status: 'PENDING' as const,
    subtasks: [],
    dependencies: dag.edges.filter((e) => e.to === workflowNode.id).map((e) => e.from),
    context: {
      systemPrompt: `You are a task executor for: ${workflowNode.goal}`,
      availableTools: workflowNode.tools,
      estimatedTokens: 1000,
    },
  });

  // Build tree structure
  const nodes = topoOrder.map((wn, i) => buildNode(wn, i));

  for (const node of nodes) {
    const children = dag.edges
      .filter((e) => e.from === node.id)
      .map((e) => nodes.find((n) => n.id === e.to))
      .filter(Boolean) as TaskTreeNode[];
    node.subtasks = children;
  }

  // Return root
  const roots = nodes.filter((n) => !dag.edges.some((e) => e.to === n.id));

  if (roots.length === 1) return roots[0];

  // Multiple roots — create virtual root
  return {
    id: 'root',
    goal: dag.name,
    parentId: null,
    role: 'EXECUTOR' as ROMARole,
    isAtomic: false,
    status: 'PENDING' as const,
    subtasks: roots,
    dependencies: [],
    context: {
      systemPrompt: `Root orchestrator for: ${dag.name}`,
      availableTools: [],
      estimatedTokens: 1000,
    },
  };
}

/**
 * Topological sort of a DAG's nodes.
 */
function topologicalSort(dag: WorkflowDAG): WorkflowNode[] {
  const visited = new Set<string>();
  const result: WorkflowNode[] = [];
  const nodeMap = new Map(dag.nodes.map((n) => [n.id, n]));

  function visit(nodeId: string, stack: Set<string>) {
    if (visited.has(nodeId)) return;
    if (stack.has(nodeId)) {
      const cyclePath = Array.from(stack).concat(nodeId);
      const named = cyclePath.map((id) => nodeMap.get(id)?.id ?? id).join(' → ');
      throw new Error(
        `dagConverter.topologicalSort: cyclic DAG detected (${named}). Workflow DAGs must be acyclic.`,
      );
    }

    stack.add(nodeId);

    const outgoing = dag.edges.filter((e) => e.from === nodeId);
    for (const edge of outgoing) {
      visit(edge.to, stack);
    }

    stack.delete(nodeId);
    visited.add(nodeId);
    const node = nodeMap.get(nodeId);
    if (node) result.push(node);
  }

  for (const node of dag.nodes) {
    visit(node.id, new Set());
  }

  return result.reverse();
}
