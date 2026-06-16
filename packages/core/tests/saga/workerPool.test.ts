import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WorkerPool, InProcessWorkerPool, WorkerPoolError } from '../../src/saga/workerPool';

describe('WorkerPool', () => {
  it('throws on maxConcurrency < 1', () => {
    assert.throws(() => new WorkerPool({ maxConcurrency: 0 }), WorkerPoolError);
  });

  it('runs a single task', async () => {
    const pool = new InProcessWorkerPool(2);
    const result = await pool.run('t1', async () => 42);
    assert.strictEqual(result, 42);
  });

  it('runs multiple tasks', async () => {
    const pool = new InProcessWorkerPool(4);
    const results = await Promise.all([
      pool.run('a', async () => 1),
      pool.run('b', async () => 2),
      pool.run('c', async () => 3),
    ]);
    assert.deepStrictEqual(results, [1, 2, 3]);
  });

  it('limits concurrent execution', async () => {
    const pool = new InProcessWorkerPool(2);
    let active = 0;
    let maxActive = 0;

    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };

    await Promise.all([
      pool.run('a', task),
      pool.run('b', task),
      pool.run('c', task),
      pool.run('d', task),
      pool.run('e', task),
    ]);
    assert.ok(maxActive <= 2, `maxActive ${maxActive} > 2`);
    assert.ok(maxActive >= 2, 'should reach concurrency limit');
  });

  it('propagates errors', async () => {
    const pool = new InProcessWorkerPool(2);
    await assert.rejects(
      pool.run('bad', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
  });

  it('rejects after close', async () => {
    const pool = new InProcessWorkerPool(2);
    await pool.close();
    await assert.rejects(
      pool.run('x', async () => 1),
      /Pool is closed/,
    );
  });

  it('rejects queued tasks on close', async () => {
    const pool = new InProcessWorkerPool(1);
    const slow = pool.run('a', async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 1;
    });
    const queued = pool.run('b', async () => 2);
    await pool.close();
    await assert.rejects(queued, /Pool closed/);
    await slow;
  });

  it('reports active count', async () => {
    const pool = new InProcessWorkerPool(4);
    assert.strictEqual(pool.activeCount, 0);
    const promise = pool.run('a', async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 1;
    });
    assert.strictEqual(pool.activeCount, 1);
    await promise;
    assert.strictEqual(pool.activeCount, 0);
  });
});
