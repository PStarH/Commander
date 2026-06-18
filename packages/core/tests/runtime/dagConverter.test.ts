import { describe, it, expect } from 'vitest';
import { dagToTaskTree } from '../../src/runtime/dagConverter';
import type { WorkflowDAG } from '../../src/runtime/evolutionaryWorkflowTypes';

function makeNode(id: string, goal = id) {
  return {
    id,
    goal,
    type: 'atomic' as const,
    tools: [],
    estimatedComplexity: 1,
    estimatedTokens: 100,
  };
}

function makeEdge(from: string, to: string) {
  return { from, to, condition: null, weight: 1 };
}

describe('dagConverter', () => {
  describe('dagToTaskTree', () => {
    it('handles empty DAG by returning a root placeholder', () => {
      const dag: WorkflowDAG = { name: 'empty', nodes: [], edges: [] };
      const tree = dagToTaskTree(dag);
      expect(tree.id).toBe('root');
      expect(tree.subtasks).toEqual([]);
      expect(tree.isAtomic).toBe(true);
    });

    it('converts a linear chain a→b→c preserving order', () => {
      const dag: WorkflowDAG = {
        name: 'chain',
        nodes: [makeNode('a', 'alpha'), makeNode('b', 'bravo'), makeNode('c', 'charlie')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c')],
      };
      const tree = dagToTaskTree(dag);
      expect(tree.goal).toBe('alpha');
      const b = tree.subtasks[0]!;
      const c = b.subtasks[0]!;
      expect(b.goal).toBe('bravo');
      expect(c.goal).toBe('charlie');
    });

    it('returns a virtual root for multiple independent roots', () => {
      const dag: WorkflowDAG = {
        name: 'forest',
        nodes: [makeNode('a', 'alpha'), makeNode('b', 'bravo')],
        edges: [],
      };
      const tree = dagToTaskTree(dag);
      expect(tree.id).toBe('root');
      expect(tree.goal).toBe('forest');
      expect(tree.isAtomic).toBe(false);
      expect(tree.subtasks.map((n) => n.goal).sort()).toEqual(['alpha', 'bravo']);
    });
  });

  describe('cycle detection (C1)', () => {
    it('throws on a 2-cycle (A→B→A)', () => {
      const dag: WorkflowDAG = {
        name: 'cycle2',
        nodes: [makeNode('a', 'alpha'), makeNode('b', 'bravo')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'a')],
      };
      expect(() => dagToTaskTree(dag)).toThrow(/cyclic/);
    });

    it('throws on a 3-cycle (A→B→C→A)', () => {
      const dag: WorkflowDAG = {
        name: 'cycle3',
        nodes: [makeNode('a', 'alpha'), makeNode('b', 'bravo'), makeNode('c', 'charlie')],
        edges: [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a')],
      };
      expect(() => dagToTaskTree(dag)).toThrow(/cyclic/);
    });

    it('throws on a self-loop (A→A)', () => {
      const dag: WorkflowDAG = {
        name: 'selfloop',
        nodes: [makeNode('a', 'alpha')],
        edges: [makeEdge('a', 'a')],
      };
      expect(() => dagToTaskTree(dag)).toThrow(/cyclic/);
    });

    it('does NOT throw on a diamond DAG (acyclic)', () => {
      const dag: WorkflowDAG = {
        name: 'diamond',
        nodes: [
          makeNode('a', 'alpha'),
          makeNode('b', 'bravo'),
          makeNode('c', 'charlie'),
          makeNode('d', 'delta'),
        ],
        edges: [makeEdge('a', 'b'), makeEdge('a', 'c'), makeEdge('b', 'd'), makeEdge('c', 'd')],
      };
      expect(() => dagToTaskTree(dag)).not.toThrow();
    });
  });
});
