import { describe, it, expect } from 'vitest';
import {
  ExecutionContext,
  ExecuteConcurrencyError,
  taskTypeToCategory,
} from '../../src/runtime/executionContext';
import type { PlannedToolCall } from '../../src/compensation/rollbackPlanner';

describe('ExecutionContext', () => {
  it('enter() resets scratch state and marks active', () => {
    const ctx = new ExecutionContext();
    ctx.enter(50_000, 'code');
    expect(ctx.isActive).toBe(true);
    expect(ctx.governor.getState().totalBudget).toBe(50_000);
    expect(ctx.promotedTools.size).toBe(0);
    expect(ctx.executedMutations).toHaveLength(0);
  });

  it('enter() throws when already active (concurrency guard)', () => {
    const ctx = new ExecutionContext();
    ctx.enter(10_000, 'general');
    expect(() => ctx.enter(20_000, 'search')).toThrow(ExecuteConcurrencyError);
  });

  it('exit() clears run handle and allows a new enter()', () => {
    const ctx = new ExecutionContext();
    ctx.enter(10_000, 'general');
    ctx.setRunHandle({ runId: 'r1', leaseToken: 't', fencingEpoch: 1 } as never);
    ctx.exit();
    expect(ctx.isActive).toBe(false);
    expect(ctx.runHandle).toBeNull();
    expect(() => ctx.enter(15_000, 'analysis')).not.toThrow();
  });

  it('isolates promoted tools and executed mutations between runs', () => {
    const ctx = new ExecutionContext();
    ctx.enter(10_000, 'general');
    ctx.markPromoted('tool_a');
    ctx.recordMutation({ toolName: 'write', arguments: {}, toolCallId: 'c1' } as PlannedToolCall);

    ctx.exit();
    ctx.enter(10_000, 'general');
    expect(ctx.promotedTools.size).toBe(0);
    expect(ctx.executedMutations).toHaveLength(0);
  });

  it('taskTypeToCategory maps known task types', () => {
    expect(taskTypeToCategory('code')).toBe('code');
    expect(taskTypeToCategory('search')).toBe('search');
    expect(taskTypeToCategory('unknown')).toBe('general');
  });
});
