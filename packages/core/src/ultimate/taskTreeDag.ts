/**
 * Task-tree ↔ DAG bridge (M3 orchestration unification).
 *
 * Converts decomposed `TaskTreeNode` subtasks into `TaskDAG` metrics for
 * topology routing and reuses `orchestrationGraph` Kahn layering for execution.
 */
import type { GraphNode } from '../orchestrationGraph';
import { topologicalLayers, validateGraph } from '../orchestrationGraph';
import type { TaskTreeNode, TaskDAG, TaskDAGNode, TaskDAGEdge } from './types';

/** Immediate subtasks used for routing-level DAG analysis. */
export function collectRoutingSubtasks(root: TaskTreeNode): TaskTreeNode[] {
  if (root.subtasks.length > 0) {
    return root.subtasks;
  }
  if (root.isAtomic) {
    return [root];
  }
  return [];
}

/**
 * Build a `TaskDAG` from real task-tree dependencies (not deliberation estimates).
 */
export function buildTaskDAGFromTree(
  root: TaskTreeNode,
  buildDAG: (nodes: TaskDAGNode[], edges: TaskDAGEdge[]) => TaskDAG,
): TaskDAG {
  const subtasks = collectRoutingSubtasks(root);
  const nodes: TaskDAGNode[] = subtasks.map((sub) => ({
    id: sub.id,
    label: sub.goal.slice(0, 120) || sub.id,
    estimatedComplexity: Math.max(1, Math.ceil((sub.context.estimatedTokens || 1000) / 1000)),
    estimatedTokens: sub.context.estimatedTokens || 1000,
    requiredCapabilities: sub.context.availableTools ?? [],
    atomic: sub.isAtomic,
  }));

  const idSet = new Set(subtasks.map((s) => s.id));
  const edges: TaskDAGEdge[] = [];
  for (const sub of subtasks) {
    for (const depId of sub.dependencies) {
      if (!idSet.has(depId)) continue;
      edges.push({
        from: depId,
        to: sub.id,
        type: 'SEQUENTIAL',
        dataDependency: true,
      });
    }
  }

  if (nodes.length === 0) {
    nodes.push({
      id: root.id,
      label: root.goal.slice(0, 120) || root.id,
      estimatedComplexity: 1,
      estimatedTokens: root.context.estimatedTokens || 1000,
      requiredCapabilities: root.context.availableTools ?? [],
      atomic: root.isAtomic,
    });
  }

  return buildDAG(nodes, edges);
}

/** Map task subtasks to orchestrationGraph nodes. */
export function taskSubtasksToGraphNodes(subtasks: TaskTreeNode[]): GraphNode[] {
  return subtasks.map((sub) => ({
    id: sub.id,
    name: sub.id,
    agentId: sub.id,
    objective: sub.goal,
    dependencies: [...sub.dependencies],
  }));
}

/**
 * Schedule subtasks into parallelizable levels using orchestrationGraph's Kahn layering.
 * Falls back to a single batch when the dependency graph is invalid/cyclic.
 */
export function scheduleSubtaskLevels(subtasks: TaskTreeNode[]): TaskTreeNode[][] {
  if (subtasks.length === 0) return [];
  if (subtasks.length === 1) return [subtasks];

  const graphNodes = taskSubtasksToGraphNodes(subtasks);
  try {
    validateGraph(graphNodes);
    const layers = topologicalLayers(graphNodes);
    const nodeMap = new Map(subtasks.map((s) => [s.id, s]));
    return layers.map((layer) =>
      layer.map((gn) => nodeMap.get(gn.id)).filter((n): n is TaskTreeNode => n !== undefined),
    );
  } catch {
    return [subtasks];
  }
}
