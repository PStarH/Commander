import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ExecutionGraph, ExecutionGraphError } from '../../src/saga/executionGraph';
import type { SagaGraph, SagaContext } from '../../src/saga/types';

function makeStep(id: string, name: string): SagaGraph {
  return {
    name: 'test',
    rootId: id,
    nodes: [
      {
        kind: 'step',
        id,
        name,
        fn: async () => null,
        compensable: false,
        compensateOrder: 'lifo',
        tags: [],
      },
    ],
  };
}

function makeSequence(...ids: string[]): SagaGraph {
  return {
    name: 'test',
    rootId: ids[0],
    nodes: ids.map((id) => ({
      kind: 'step' as const,
      id,
      name: id,
      fn: async () => null,
      compensable: false,
      compensateOrder: 'lifo' as const,
      tags: [],
    })),
  };
}

describe('ExecutionGraph', () => {
  it('builds index for a single step', () => {
    const g = makeStep('a', 'stepA');
    const eg = new ExecutionGraph(g);
    assert.strictEqual(eg.size, 1);
    assert.strictEqual(eg.rootId, 'a');
    assert.ok(eg.hasNode('a'));
  });

  it('builds index for a sequence of steps', () => {
    const g = makeSequence('a', 'b', 'c');
    const eg = new ExecutionGraph(g);
    assert.strictEqual(eg.size, 3);
    assert.strictEqual(eg.nextSiblingOf('a')?.id, 'b');
    assert.strictEqual(eg.nextSiblingOf('b')?.id, 'c');
    assert.strictEqual(eg.nextSiblingOf('c'), undefined);
  });

  it('throws on empty graph', () => {
    const g: SagaGraph = { name: 'empty', rootId: 'x', nodes: [] };
    assert.throws(() => new ExecutionGraph(g), ExecutionGraphError);
  });

  it('throws on duplicate node id', () => {
    const g: SagaGraph = {
      name: 'dup',
      rootId: 'a',
      nodes: [
        {
          kind: 'step',
          id: 'a',
          name: 'a',
          fn: async () => null,
          compensable: false,
          compensateOrder: 'lifo',
          tags: [],
        },
        {
          kind: 'step',
          id: 'a',
          name: 'a-dup',
          fn: async () => null,
          compensable: false,
          compensateOrder: 'lifo',
          tags: [],
        },
      ],
    };
    assert.throws(() => new ExecutionGraph(g), /Duplicate node id/);
  });

  it('throws on missing root', () => {
    const g: SagaGraph = {
      name: 'no-root',
      rootId: 'missing',
      nodes: [
        {
          kind: 'step',
          id: 'a',
          name: 'a',
          fn: async () => null,
          compensable: false,
          compensateOrder: 'lifo',
          tags: [],
        },
      ],
    };
    assert.throws(() => new ExecutionGraph(g), /Root node/);
  });

  it('throws on empty nested graph', () => {
    const g: SagaGraph = {
      name: 'empty-nested',
      rootId: 'a',
      nodes: [
        {
          kind: 'nested',
          id: 'a',
          name: 'a',
          compensateOrder: 'lifo',
          child: { name: 'empty', rootId: 'x', nodes: [] },
        },
      ],
    };
    assert.throws(() => new ExecutionGraph(g), /empty child graph/);
  });

  it('walks tree in pre-order', () => {
    const g: SagaGraph = {
      name: 'tree',
      rootId: 'a',
      nodes: [
        {
          kind: 'parallel',
          id: 'a',
          name: 'parallel',
          branches: [
            {
              kind: 'nested',
              id: 'b',
              name: 'b',
              compensateOrder: 'lifo',
              child: {
                name: 'sub1',
                rootId: 'b1',
                nodes: [
                  {
                    kind: 'step',
                    id: 'b1',
                    name: 'b1',
                    fn: async () => null,
                    compensable: false,
                    compensateOrder: 'lifo',
                    tags: [],
                  },
                ],
              },
            },
            {
              kind: 'step',
              id: 'c',
              name: 'c',
              fn: async () => null,
              compensable: false,
              compensateOrder: 'lifo',
              tags: [],
            },
          ],
          failFast: true,
        },
      ],
    };
    const eg = new ExecutionGraph(g);
    const visited: string[] = [];
    eg.walk((n) => visited.push(n.id));
    assert.deepStrictEqual(visited, ['a', 'b', 'b1', 'c']);
  });

  it('returns ancestors in order', () => {
    const g: SagaGraph = {
      name: 'nested-tree',
      rootId: 'a',
      nodes: [
        {
          kind: 'parallel',
          id: 'a',
          name: 'parallel',
          branches: [
            {
              kind: 'nested',
              id: 'b',
              name: 'b',
              compensateOrder: 'lifo',
              child: {
                name: 'sub1',
                rootId: 'b1',
                nodes: [
                  {
                    kind: 'step',
                    id: 'b1',
                    name: 'b1',
                    fn: async () => null,
                    compensable: false,
                    compensateOrder: 'lifo',
                    tags: [],
                  },
                ],
              },
            },
          ],
          failFast: true,
        },
      ],
    };
    const eg = new ExecutionGraph(g);
    const ancestors = eg.ancestorsOf('b1');
    assert.strictEqual(ancestors.length, 2);
    assert.strictEqual(ancestors[0].id, 'b');
    assert.strictEqual(ancestors[1].id, 'a');
  });

  it('identifies node kinds', () => {
    const g: SagaGraph = {
      name: 'kinds',
      rootId: 'a',
      nodes: [
        {
          kind: 'step',
          id: 'a',
          name: 'a',
          fn: async () => null,
          compensable: false,
          compensateOrder: 'lifo',
          tags: [],
        },
        {
          kind: 'approval',
          id: 'b',
          name: 'human',
          approver: 'alice',
          onTimeout: 'reject',
        },
      ],
    };
    const eg = new ExecutionGraph(g);
    assert.strictEqual(eg.isStep('a'), true);
    assert.strictEqual(eg.isApproval('b'), true);
    assert.strictEqual(eg.isParallel('a'), false);
    assert.strictEqual(eg.isNested('a'), false);
  });

  it('finds branch of a parallel child', () => {
    const g: SagaGraph = {
      name: 'branch',
      rootId: 'a',
      nodes: [
        {
          kind: 'parallel',
          id: 'a',
          name: 'parallel',
          branches: [
            {
              kind: 'nested',
              id: 'b',
              name: 'b',
              compensateOrder: 'lifo',
              child: {
                name: 'b-sub',
                rootId: 'b1',
                nodes: [
                  {
                    kind: 'step',
                    id: 'b1',
                    name: 'b1',
                    fn: async () => null,
                    compensable: false,
                    compensateOrder: 'lifo',
                    tags: [],
                  },
                ],
              },
            },
            {
              kind: 'nested',
              id: 'c',
              name: 'c',
              compensateOrder: 'lifo',
              child: {
                name: 'c-sub',
                rootId: 'c1',
                nodes: [
                  {
                    kind: 'step',
                    id: 'c1',
                    name: 'c1',
                    fn: async () => null,
                    compensable: false,
                    compensateOrder: 'lifo',
                    tags: [],
                  },
                ],
              },
            },
          ],
          failFast: true,
        },
      ],
    };
    const eg = new ExecutionGraph(g);
    const bBranch = eg.branchOf('b1');
    assert.deepStrictEqual(bBranch, { parallelId: 'a', index: 0 });
    const cBranch = eg.branchOf('c1');
    assert.deepStrictEqual(cBranch, { parallelId: 'a', index: 1 });
  });

  it('childrenOf returns branches for parallel, nodes for nested', () => {
    const g: SagaGraph = {
      name: 'children',
      rootId: 'p',
      nodes: [
        {
          kind: 'parallel',
          id: 'p',
          name: 'parallel',
          branches: [
            {
              kind: 'step',
              id: 'b1',
              name: 'b1',
              fn: async () => null,
              compensable: false,
              compensateOrder: 'lifo',
              tags: [],
            },
          ],
          failFast: true,
        },
      ],
    };
    const eg = new ExecutionGraph(g);
    const children = eg.childrenOf('p');
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].id, 'b1');
  });

  it('parentOf returns undefined for top-level', () => {
    const g = makeSequence('a', 'b');
    const eg = new ExecutionGraph(g);
    assert.strictEqual(eg.parentOf('a'), undefined);
    assert.strictEqual(eg.parentOf('b'), undefined);
  });

  it('filters step nodes', () => {
    const g: SagaGraph = {
      name: 'mixed',
      rootId: 'a',
      nodes: [
        {
          kind: 'step',
          id: 'a',
          name: 'a',
          fn: async () => null,
          compensable: false,
          compensateOrder: 'lifo',
          tags: [],
        },
        {
          kind: 'approval',
          id: 'b',
          name: 'human',
          approver: 'alice',
          onTimeout: 'reject',
        },
      ],
    };
    const eg = new ExecutionGraph(g);
    assert.strictEqual(eg.stepNodes().length, 1);
    assert.strictEqual(eg.approvalNodes().length, 1);
  });
});
