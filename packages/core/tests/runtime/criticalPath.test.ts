import { describe, it, expect } from 'vitest';
import type { TaskTreeNode } from '../../src/ultimate/types';

/**
 * Replicate the critical path algorithm from SubAgentExecutor
 * for isolated testing. This is the forward/backward pass on a DAG.
 */
function computeCriticalPath(nodes: TaskTreeNode[], dependencyMap: Map<string, string[]>): void {
  if (nodes.length === 0) return;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const est = new Map<string, number>();
  const eft = new Map<string, number>();
  const lft = new Map<string, number>();
  const lst = new Map<string, number>();

  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjList.set(node.id, []);
  }

  for (const [nodeId, deps] of dependencyMap) {
    for (const dep of deps) {
      adjList.get(dep)?.push(nodeId);
      inDegree.set(nodeId, (inDegree.get(nodeId) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
      est.set(nodeId, 0);
      const dur = nodeMap.get(nodeId)?.estimatedDurationMs ?? 10000;
      eft.set(nodeId, dur);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentEft = eft.get(current) ?? 0;

    for (const successor of adjList.get(current) ?? []) {
      const newEst = currentEft;
      const currentEst = est.get(successor) ?? 0;
      if (newEst > currentEst) {
        est.set(successor, newEst);
        const dur = nodeMap.get(successor)?.estimatedDurationMs ?? 10000;
        eft.set(successor, newEst + dur);
      }
      inDegree.set(successor, (inDegree.get(successor) ?? 1) - 1);
      if (inDegree.get(successor) === 0) {
        queue.push(successor);
      }
    }
  }

  let projectFinish = 0;
  for (const [, finish] of eft) {
    projectFinish = Math.max(projectFinish, finish);
  }

  for (const node of nodes) {
    lft.set(node.id, projectFinish);
  }

  const outDegree = new Map<string, number>();
  for (const node of nodes) {
    outDegree.set(node.id, 0);
  }
  for (const [, deps] of dependencyMap) {
    for (const dep of deps) {
      outDegree.set(dep, (outDegree.get(dep) ?? 0) + 1);
    }
  }

  const reverseQueue: string[] = [];
  for (const [nodeId, degree] of outDegree) {
    if (degree === 0) {
      reverseQueue.push(nodeId);
    }
  }

  while (reverseQueue.length > 0) {
    const current = reverseQueue.shift()!;
    const currentLst =
      (lft.get(current) ?? projectFinish) - (nodeMap.get(current)?.estimatedDurationMs ?? 10000);
    lst.set(current, currentLst);

    for (const dep of dependencyMap.get(current) ?? []) {
      const newLft = currentLst;
      const currentLft = lft.get(dep) ?? projectFinish;
      if (newLft < currentLft) {
        lft.set(dep, newLft);
      }
      outDegree.set(dep, (outDegree.get(dep) ?? 1) - 1);
      if (outDegree.get(dep) === 0) {
        reverseQueue.push(dep);
      }
    }
  }

  for (const node of nodes) {
    const nodeEst = est.get(node.id) ?? 0;
    const nodeLst = lst.get(node.id) ?? 0;
    const slack = Math.abs(nodeLst - nodeEst);
    node.isOnCriticalPath = slack < 100;
  }
}

function makeNode(id: string, durationMs: number, deps: string[]): TaskTreeNode {
  return {
    id,
    parentId: null,
    goal: `task ${id}`,
    role: 'EXECUTOR',
    isAtomic: true,
    subtasks: [],
    dependencies: deps,
    context: { systemPrompt: '', availableTools: [], estimatedTokens: 1000 },
    status: 'PENDING',
    estimatedDurationMs: durationMs,
    isOnCriticalPath: false,
  };
}

describe('CriticalPath - linear DAG (A → B → C)', () => {
  const a = makeNode('A', 1000, []);
  const b = makeNode('B', 2000, ['A']);
  const c = makeNode('C', 500, ['B']);
  const nodes = [a, b, c];
  const deps = new Map([
    ['A', []],
    ['B', ['A']],
    ['C', ['B']],
  ]);

  computeCriticalPath(nodes, deps);

  it('all nodes on critical path in linear DAG', () => {
    expect(a.isOnCriticalPath).toBe(true);
    expect(b.isOnCriticalPath).toBe(true);
    expect(c.isOnCriticalPath).toBe(true);
  });
});

describe('CriticalPath - parallel branches', () => {
  const start = makeNode('START', 500, []);
  const long = makeNode('LONG', 10000, ['START']);
  const short = makeNode('SHORT', 100, ['START']);
  const end = makeNode('END', 500, ['LONG', 'SHORT']);
  const nodes = [start, long, short, end];
  const deps = new Map([
    ['START', []],
    ['LONG', ['START']],
    ['SHORT', ['START']],
    ['END', ['LONG', 'SHORT']],
  ]);

  computeCriticalPath(nodes, deps);

  it('long branch is on critical path', () => {
    expect(start.isOnCriticalPath).toBe(true);
    expect(long.isOnCriticalPath).toBe(true);
    expect(end.isOnCriticalPath).toBe(true);
  });

  it('short branch is NOT on critical path (has slack)', () => {
    expect(short.isOnCriticalPath).toBe(false);
  });
});

describe('CriticalPath - diamond DAG', () => {
  const a = makeNode('A', 1000, []);
  const b = makeNode('B', 3000, ['A']);
  const c_diamond = makeNode('C', 2000, ['A']);
  const d = makeNode('D', 500, ['B', 'C']);
  const nodes = [a, b, c_diamond, d];
  const deps = new Map([
    ['A', []],
    ['B', ['A']],
    ['C', ['A']],
    ['D', ['B', 'C']],
  ]);

  computeCriticalPath(nodes, deps);

  it('longer branch is critical', () => {
    expect(a.isOnCriticalPath).toBe(true);
    expect(b.isOnCriticalPath).toBe(true);
    expect(d.isOnCriticalPath).toBe(true);
  });

  it('shorter branch in diamond has slack', () => {
    expect(c_diamond.isOnCriticalPath).toBe(false);
  });
});

describe('CriticalPath - empty and edge cases', () => {
  it('handles empty node list', () => {
    const result = computeCriticalPath([], new Map());
    expect(result).toBeUndefined();
  });

  it('single node is always critical', () => {
    const node = makeNode('X', 1000, []);
    computeCriticalPath([node], new Map([['X', []]]));
    expect(node.isOnCriticalPath).toBe(true);
  });
});
