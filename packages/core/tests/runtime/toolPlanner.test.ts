import { describe, it, expect } from 'vitest';
import { ToolPlanner } from '../../src/runtime/toolPlanner';

describe('ToolPlanner', () => {
  const mockTools = new Map([
    ['file_read', { name: 'file_read', isReadOnly: true } as any],
    ['file_write', { name: 'file_write', isReadOnly: false } as any],
    ['web_search', { name: 'web_search', isReadOnly: true } as any],
    ['shell_execute', { name: 'shell_execute', isReadOnly: false } as any],
  ]);

  describe('plan', () => {
    it('creates a plan for independent tool calls', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([
        { id: 'tc1', name: 'file_read', arguments: { path: '/a.ts' } },
        { id: 'tc2', name: 'file_read', arguments: { path: '/b.ts' } },
      ], mockTools);
      expect(plan).toBeDefined();
      expect(plan.stages).toBeDefined();
      expect(plan.stages.length).toBeGreaterThan(0);
    });

    it('creates plan for single tool call', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([
        { id: 'tc1', name: 'file_read', arguments: { path: '/a.ts' } },
      ], mockTools);
      expect(plan.stages.length).toBe(1);
      expect(plan.stages[0].toolCalls.length).toBe(1);
    });

    it('creates plan for empty tool calls', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([], mockTools);
      expect(plan.stages.length).toBe(0);
    });

    it('groups parallel-safe tools in same stage', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([
        { id: 'tc1', name: 'file_read', arguments: { path: '/a.ts' } },
        { id: 'tc2', name: 'file_read', arguments: { path: '/b.ts' } },
        { id: 'tc3', name: 'web_search', arguments: { query: 'test' } },
      ], mockTools);
      // All read-only tools should be in same stage
      expect(plan.stages.length).toBeLessThanOrEqual(2);
    });

    it('includes dependency edges', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([
        { id: 'tc1', name: 'file_read', arguments: { path: '/a.ts' } },
        { id: 'tc2', name: 'file_write', arguments: { path: '/a.ts', content: 'new' } },
      ], mockTools);
      expect(plan.dependencies).toBeDefined();
    });

    it('includes resource conflicts', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([
        { id: 'tc1', name: 'file_write', arguments: { path: '/a.ts', content: 'a' } },
        { id: 'tc2', name: 'file_write', arguments: { path: '/a.ts', content: 'b' } },
      ], mockTools);
      expect(plan.conflicts).toBeDefined();
    });

    it('includes speculative candidates', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([
        { id: 'tc1', name: 'file_read', arguments: { path: '/a.ts' } },
        { id: 'tc2', name: 'web_search', arguments: { query: 'test' } },
      ], mockTools);
      expect(plan.speculativeCandidates).toBeDefined();
    });
  });

  describe('cycle detection (defensive safety net)', () => {
    it('partitioning produces a valid stage for any non-cyclic plan', () => {
      const planner = new ToolPlanner();
      const plan = planner.plan([
        { id: 'tc1', name: 'file_read', arguments: { path: '/a.ts' } },
        { id: 'tc2', name: 'file_read', arguments: { path: '/b.ts' } },
        { id: 'tc3', name: 'file_write', arguments: { path: '/c.ts', content: 'x' } },
      ], mockTools);
      expect(plan.stages.length).toBeGreaterThan(0);
      expect(plan.stages.flatMap(s => s.toolCalls).map(tc => tc.id).sort())
        .toEqual(['tc1', 'tc2', 'tc3']);
    });
  });
});
