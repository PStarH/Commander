import { describe, it, expect } from 'vitest';
import { CompensationRegistry } from '../../src/runtime/compensationRegistry';

describe('CompensationRegistry', () => {
  it('registers and retrieves pending actions', () => {
    const registry = new CompensationRegistry();
    expect(registry.getPendingCount()).toBe(0);

    registry.recordAction({
      actionId: 'a1',
      toolName: 'file_write',
      args: { path: '/tmp/test.txt' },
      description: 'write test file',
      tags: ['file'],
    });

    expect(registry.getPendingCount()).toBe(1);
  });

  it('compensates a single action via handler', async () => {
    const registry = new CompensationRegistry();
    let compensated = false;

    registry.register('file_write', async (action) => {
      compensated = true;
      expect(action.toolName).toBe('file_write');
      return { success: true };
    });

    registry.recordAction({
      actionId: 'a1',
      toolName: 'file_write',
      args: {},
      description: 'test',
      tags: [],
    });

    const result = await registry.compensate('a1');
    expect(result.success).toBe(true);
    expect(compensated).toBe(true);
    expect(registry.getPendingCount()).toBe(0);
    expect(registry.getCompensatedCount()).toBe(1);
  });

  it('returns success for unknown actionId', async () => {
    const registry = new CompensationRegistry();
    const result = await registry.compensate('nonexistent');
    expect(result.success).toBe(true);
  });

  it('returns success when no handler registered', async () => {
    const registry = new CompensationRegistry();
    registry.recordAction({
      actionId: 'a1',
      toolName: 'unknown_tool',
      args: {},
      description: 'test',
      tags: [],
    });

    const result = await registry.compensate('a1');
    expect(result.success).toBe(true);
    expect(registry.getPendingCount()).toBe(0);
    expect(registry.getCompensatedCount()).toBe(1);
  });

  it('catches handler errors gracefully', async () => {
    const registry = new CompensationRegistry();
    registry.register('failing_tool', async () => {
      throw new Error('handler crashed');
    });

    registry.recordAction({
      actionId: 'a1',
      toolName: 'failing_tool',
      args: {},
      description: 'test',
      tags: [],
    });

    const result = await registry.compensate('a1');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(registry.getPendingCount()).toBe(1); // still pending
  });

  it('compensates all actions in reverse order', async () => {
    const registry = new CompensationRegistry();
    const order: string[] = [];

    registry.register('tool', async (action) => {
      order.push(action.actionId);
      return { success: true };
    });

    registry.recordAction({ actionId: 'a1', toolName: 'tool', args: {}, description: 'first', tags: [] });
    registry.recordAction({ actionId: 'a2', toolName: 'tool', args: {}, description: 'second', tags: [] });
    registry.recordAction({ actionId: 'a3', toolName: 'tool', args: {}, description: 'third', tags: [] });

    const result = await registry.compensateAll();
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(order).toEqual(['a3', 'a2', 'a1']); // LIFO
    expect(registry.getPendingCount()).toBe(0);
  });

  it('clears all state', () => {
    const registry = new CompensationRegistry();
    registry.recordAction({ actionId: 'a1', toolName: 't', args: {}, description: 'test', tags: [] });
    registry.recordAction({ actionId: 'a2', toolName: 't', args: {}, description: 'test', tags: [] });

    expect(registry.getPendingCount()).toBe(2);
    registry.clear();
    expect(registry.getPendingCount()).toBe(0);
    expect(registry.getCompensatedCount()).toBe(0);
  });

  it('compensateAll returns partial failure counts', async () => {
    const registry = new CompensationRegistry();
    let callCount = 0;

    registry.register('tool', async () => {
      callCount++;
      if (callCount === 2) throw new Error('fail');
      return { success: true };
    });

    registry.recordAction({ actionId: 'a1', toolName: 'tool', args: {}, description: 'ok', tags: [] });
    registry.recordAction({ actionId: 'a2', toolName: 'tool', args: {}, description: 'fail', tags: [] });
    registry.recordAction({ actionId: 'a3', toolName: 'tool', args: {}, description: 'ok', tags: [] });

    const result = await registry.compensateAll();
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
  });
});
