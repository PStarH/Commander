/**
 * M3 — real task-tree DAG routing and orchestrationGraph scheduling.
 */
import { describe, it, expect } from 'vitest';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import {
  buildTaskDAGFromTree,
  scheduleSubtaskLevels,
  collectRoutingSubtasks,
} from '../../src/ultimate/taskTreeDag';
import type { TaskTreeNode } from '../../src/ultimate/types';

function makeSubtask(
  id: string,
  deps: string[] = [],
  overrides: Partial<TaskTreeNode> = {},
): TaskTreeNode {
  return {
    id,
    parentId: 'root',
    goal: `Goal for ${id}`,
    role: 'EXECUTOR',
    isAtomic: true,
    status: 'PENDING',
    dependencies: deps,
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 1000 },
    subtasks: [],
    ...overrides,
  };
}

function makeRoot(subtasks: TaskTreeNode[]): TaskTreeNode {
  return {
    id: 'root',
    parentId: null,
    goal: 'Root goal',
    role: 'PLANNER',
    isAtomic: false,
    status: 'PENDING',
    dependencies: [],
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 5000 },
    subtasks,
  };
}

describe('taskTreeDag', () => {
  const router = new TopologyRouter(undefined, { epsilon: 0 });

  it('buildTaskDAGFromTree uses real subtask ids and dependencies', () => {
    const tree = makeRoot([makeSubtask('a'), makeSubtask('b', ['a']), makeSubtask('c', ['a'])]);

    const dag = buildTaskDAGFromTree(tree, (nodes, edges) => router.buildDAG(nodes, edges));

    expect(dag.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(dag.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'a', to: 'b' }),
        expect.objectContaining({ from: 'a', to: 'c' }),
      ]),
    );
    expect(dag.metadata?.parallelismWidth).toBe(2);
    expect(dag.metadata?.criticalPathDepth).toBeGreaterThanOrEqual(2);
  });

  it('synthetic deliberation-style ids are not used', () => {
    const tree = makeRoot([
      makeSubtask('real-node-1'),
      makeSubtask('real-node-2', ['real-node-1']),
    ]);
    const dag = buildTaskDAGFromTree(tree, (nodes, edges) => router.buildDAG(nodes, edges));
    expect(dag.nodes.some((n) => n.id.startsWith('dag_node_'))).toBe(false);
  });

  it('scheduleSubtaskLevels matches orchestrationGraph Kahn layering', () => {
    const subtasks = [
      makeSubtask('a'),
      makeSubtask('b', ['a']),
      makeSubtask('c', ['a']),
      makeSubtask('d', ['b', 'c']),
    ];

    const levels = scheduleSubtaskLevels(subtasks);
    expect(levels).toHaveLength(3);
    expect(levels[0].map((n) => n.id)).toEqual(['a']);
    expect(levels[1].map((n) => n.id).sort()).toEqual(['b', 'c']);
    expect(levels[2].map((n) => n.id)).toEqual(['d']);
  });

  it('collectRoutingSubtasks returns root subtasks', () => {
    const tree = makeRoot([makeSubtask('x'), makeSubtask('y')]);
    expect(collectRoutingSubtasks(tree).map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('parallel STEP decomposition yields high parallelism width in DAG metrics', () => {
    const tree = makeRoot([
      makeSubtask('s1'),
      makeSubtask('s2'),
      makeSubtask('s3'),
      makeSubtask('s4'),
    ]);
    const dag = buildTaskDAGFromTree(tree, (nodes, edges) => router.buildDAG(nodes, edges));
    expect(dag.metadata?.parallelismWidth).toBe(4);
    expect(dag.edges).toHaveLength(0);
  });
});
