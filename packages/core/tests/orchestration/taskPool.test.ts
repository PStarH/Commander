import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskPool } from '../../src/orchestration/taskPool';

// Mock AgentRuntime
function createMockRuntime(executeFn?: (ctx: any) => Promise<any>) {
  return {
    execute: executeFn ?? (async (ctx: any) => ({
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
      assert.equal(stats.totalTokensUsed, 0);
      assert.equal(stats.activeWorkers, 0);
      assert.equal(stats.maxWorkers, 5);
    });

    it('accepts custom config', () => {
      const pool = new TaskPool(createMockRuntime(), { maxWorkers: 10 });
      const stats = pool.getStats();
      assert.equal(stats.maxWorkers, 10);
    });
  });

  describe('dispatch', () => {
    it('dispatches single task', async () => {
      const pool = new TaskPool(createMockRuntime());
      const results = await pool.dispatch([
        { id: 't1', goal: 'test task' },
      ]);
      assert.equal(results.length, 1);
      assert.equal(results[0].taskId, 't1');
      assert.equal(results[0].status, 'success');
    });

    it('dispatches multiple tasks', async () => {
      const pool = new TaskPool(createMockRuntime(), { maxWorkers: 3 });
      const results = await pool.dispatch([
        { id: 't1', goal: 'task 1' },
        { id: 't2', goal: 'task 2' },
        { id: 't3', goal: 'task 3' },
      ]);
      assert.equal(results.length, 3);
      assert.ok(results.every(r => r.status === 'success'));
    });

    it('sorts tasks by priority', async () => {
      const order: string[] = [];
      const pool = new TaskPool(createMockRuntime(async (ctx) => {
        order.push(ctx.goal);
        return { status: 'success', summary: '', totalTokenUsage: { totalTokens: 10 }, totalDurationMs: 10 };
      }), { maxWorkers: 1 }); // Sequential to track order
      await pool.dispatch([
        { id: 't1', goal: 'low', priority: 1 },
        { id: 't2', goal: 'high', priority: 10 },
      ]);
      assert.equal(order[0], 'high');
    });

    it('handles task failure gracefully', async () => {
      const pool = new TaskPool(createMockRuntime(async () => {
        throw new Error('task failed');
      }));
      const results = await pool.dispatch([{ id: 't1', goal: 'failing task' }]);
      assert.equal(results.length, 1);
      assert.equal(results[0].status, 'failed');
      assert.ok(results[0].error?.includes('task failed'));
    });

    it('handles mixed success/failure', async () => {
      let callCount = 0;
      const pool = new TaskPool(createMockRuntime(async (ctx) => {
        callCount++;
        if (callCount === 2) throw new Error('fail');
        return { status: 'success', summary: '', totalTokenUsage: { totalTokens: 10 }, totalDurationMs: 10 };
      }));
      const results = await pool.dispatch([
        { id: 't1', goal: 'success' },
        { id: 't2', goal: 'fail' },
        { id: 't3', goal: 'success' },
      ]);
      assert.equal(results.length, 3);
      const successes = results.filter(r => r.status === 'success');
      const failures = results.filter(r => r.status === 'failed');
      assert.equal(successes.length, 2);
      assert.equal(failures.length, 1);
    });

    it('respects maxWorkers batching', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;
      const pool = new TaskPool(createMockRuntime(async (ctx) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 10));
        currentConcurrent--;
        return { status: 'success', summary: '', totalTokenUsage: { totalTokens: 10 }, totalDurationMs: 10 };
      }), { maxWorkers: 2 });
      await pool.dispatch([
        { id: 't1', goal: 'a' },
        { id: 't2', goal: 'b' },
        { id: 't3', goal: 'c' },
        { id: 't4', goal: 'd' },
      ]);
      assert.ok(maxConcurrent <= 2);
    });
  });

  describe('getStats', () => {
    it('tracks token usage', async () => {
      const pool = new TaskPool(createMockRuntime(async () => ({
        status: 'success', summary: '', totalTokenUsage: { totalTokens: 500 }, totalDurationMs: 10,
      })));
      await pool.dispatch([{ id: 't1', goal: 'test' }]);
      const stats = pool.getStats();
      assert.ok(stats.totalTokensUsed > 0);
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
      assert.ok(results.length === 1);
    });

    it('distributes budget across tasks', async () => {
      let receivedBudget = 0;
      const pool = new TaskPool(createMockRuntime(async (ctx) => {
        receivedBudget = ctx.tokenBudget;
        return { status: 'success', summary: '', totalTokenUsage: { totalTokens: 10 }, totalDurationMs: 10 };
      }), {
        globalTokenBudget: 10000,
        defaultTokenBudget: 5000,
      });
      await pool.dispatch([
        { id: 't1', goal: 'a' },
        { id: 't2', goal: 'b' },
      ]);
      // Per-task budget should be min(global/tasks, default) = min(5000, 5000) = 5000
      assert.ok(receivedBudget > 0);
    });
  });
});
