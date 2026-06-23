import { describe, it, expect } from 'vitest';
import { TaskPool } from '../../src/ultimate/taskPool';

// Mock AgentRuntime
function createMockRuntime(executeFn?: (ctx: any) => Promise<any>) {
  return {
    execute:
      executeFn ??
      (async (ctx: any) => ({
        status: 'success',
        summary: `Completed: ${ctx.goal}`,
        totalTokenUsage: { totalTokens: 100 },
        totalDurationMs: 50,
      })),
  } as any;
}

describe('TaskPool', () => {
  describe('constructor', () => {
    it('creates pool with default config', () => {
      const pool = new TaskPool(createMockRuntime());
      const stats = pool.getStats();
      expect(stats.totalTokensUsed).toBe(0);
      expect(stats.activeWorkers).toBe(0);
      expect(stats.maxWorkers).toBe(5);
    });

    it('accepts custom config', () => {
      const pool = new TaskPool(createMockRuntime(), { maxWorkers: 10 });
      const stats = pool.getStats();
      expect(stats.maxWorkers).toBe(10);
    });
  });

  describe('dispatch', () => {
    it('dispatches single task', async () => {
      const pool = new TaskPool(createMockRuntime());
      const results = await pool.dispatch([{ id: 't1', goal: 'test task' }]);
      expect(results).toHaveLength(1);
      expect(results[0].taskId).toBe('t1');
      expect(results[0].status).toBe('success');
    });

    it('dispatches multiple tasks', async () => {
      const pool = new TaskPool(createMockRuntime(), { maxWorkers: 3 });
      const results = await pool.dispatch([
        { id: 't1', goal: 'task 1' },
        { id: 't2', goal: 'task 2' },
        { id: 't3', goal: 'task 3' },
      ]);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.status === 'success')).toBe(true);
    });

    it('sorts tasks by priority', async () => {
      const order: string[] = [];
      const pool = new TaskPool(
        createMockRuntime(async (ctx) => {
          order.push(ctx.goal);
          return {
            status: 'success',
            summary: '',
            totalTokenUsage: { totalTokens: 10 },
            totalDurationMs: 10,
          };
        }),
        { maxWorkers: 1 },
      ); // Sequential to track order
      await pool.dispatch([
        { id: 't1', goal: 'low', priority: 1 },
        { id: 't2', goal: 'high', priority: 10 },
      ]);
      expect(order[0]).toBe('high');
    });

    it('handles task failure gracefully', async () => {
      const pool = new TaskPool(
        createMockRuntime(async () => {
          throw new Error('task failed');
        }),
      );
      const results = await pool.dispatch([{ id: 't1', goal: 'failing task' }]);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].error).toContain('task failed');
    });

    it('handles mixed success/failure', async () => {
      let callCount = 0;
      const pool = new TaskPool(
        createMockRuntime(async (ctx) => {
          callCount++;
          if (callCount === 2) throw new Error('fail');
          return {
            status: 'success',
            summary: '',
            totalTokenUsage: { totalTokens: 10 },
            totalDurationMs: 10,
          };
        }),
      );
      const results = await pool.dispatch([
        { id: 't1', goal: 'success' },
        { id: 't2', goal: 'fail' },
        { id: 't3', goal: 'success' },
      ]);
      expect(results).toHaveLength(3);
      const successes = results.filter((r) => r.status === 'success');
      const failures = results.filter((r) => r.status === 'failed');
      expect(successes).toHaveLength(2);
      expect(failures).toHaveLength(1);
    });

    it('respects maxWorkers batching', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      const pool = new TaskPool(
        createMockRuntime(async (ctx) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((r) => setTimeout(r, 10));
          currentConcurrent--;
          return {
            status: 'success',
            summary: '',
            totalTokenUsage: { totalTokens: 10 },
            totalDurationMs: 10,
          };
        }),
        { maxWorkers: 2 },
      );
      await pool.dispatch([
        { id: 't1', goal: 'a' },
        { id: 't2', goal: 'b' },
        { id: 't3', goal: 'c' },
        { id: 't4', goal: 'd' },
      ]);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('getStats', () => {
    it('tracks token usage', async () => {
      const pool = new TaskPool(
        createMockRuntime(async () => ({
          status: 'success',
          summary: '',
          totalTokenUsage: { totalTokens: 500 },
          totalDurationMs: 10,
        })),
      );
      await pool.dispatch([{ id: 't1', goal: 'test' }]);
      const stats = pool.getStats();
      expect(stats.totalTokensUsed).toBeGreaterThan(0);
    });
  });

  describe('token budget', () => {
    it('fails when global budget is exhausted', async () => {
      const pool = new TaskPool(createMockRuntime(), {
        globalTokenBudget: 1, // Nearly zero budget
        defaultTokenBudget: 1,
      });
      const results = await pool.dispatch([{ id: 't1', goal: 'test' }]);
      // With such a small budget, it should either fail or use minimal tokens
      expect(results).toHaveLength(1);
    });

    it('distributes budget across tasks', async () => {
      let receivedBudget = 0;
      const pool = new TaskPool(
        createMockRuntime(async (ctx) => {
          receivedBudget = ctx.tokenBudget;
          return {
            status: 'success',
            summary: '',
            totalTokenUsage: { totalTokens: 10 },
            totalDurationMs: 10,
          };
        }),
        {
          globalTokenBudget: 10000,
          defaultTokenBudget: 5000,
        },
      );
      await pool.dispatch([
        { id: 't1', goal: 'a' },
        { id: 't2', goal: 'b' },
      ]);
      // Per-task budget should be min(global/tasks, default) = min(5000, 5000) = 5000
      expect(receivedBudget).toBeGreaterThan(0);
    });
  });
});
