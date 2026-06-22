import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { TaskQueue } from '../../src/atr/taskQueue';
import { resetMessageBus } from '../../src/runtime/messageBus';
import { resetWebhookDispatcher } from '../../src/runtime/webhookDispatcher';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    resetMessageBus();
    resetWebhookDispatcher();
  });

  afterEach(() => {
    if (queue) {
      queue.dispose();
    }
    resetMessageBus();
    resetWebhookDispatcher();
  });

  it('submits a task and returns jobId with pending status', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });

    const result = queue.submit({ goal: 'test task' });

    assert.ok(result.jobId.startsWith('task_'));
    assert.strictEqual(result.status, 'pending');
  });

  it('get returns null for nonexistent jobId', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });

    const record = queue.get('nonexistent-id');
    assert.strictEqual(record, null);
  });

  it('get returns correct record after submit', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });
    const { jobId } = queue.submit({ goal: 'hello world' });

    const record = queue.get(jobId);

    assert.ok(record !== null);
    assert.strictEqual(record.jobId, jobId);
    assert.strictEqual(record.goal, 'hello world');
    assert.strictEqual(record.status, 'pending');
    assert.ok(record.createdAt);
  });

  it('stores optional fields', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });
    const { jobId } = queue.submit({
      goal: 'task with options',
      provider: 'anthropic',
      model: 'claude-3',
      tenantId: 'tenant-1',
      callbackUrl: 'https://example.com/cb',
      metadata: { source: 'test' },
    });

    const record = queue.get(jobId);

    assert.strictEqual(record?.provider, 'anthropic');
    assert.strictEqual(record?.model, 'claude-3');
    assert.strictEqual(record?.tenantId, 'tenant-1');
    assert.strictEqual(record?.callbackUrl, 'https://example.com/cb');
    assert.deepStrictEqual(record?.metadata, { source: 'test' });
  });

  it('list returns tasks filtered by status', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });
    queue.submit({ goal: 'task 1' });
    queue.submit({ goal: 'task 2' });

    const pendingTasks = queue.list('pending');
    assert.strictEqual(pendingTasks.length, 2);

    const completedTasks = queue.list('completed');
    assert.strictEqual(completedTasks.length, 0);
  });

  it('list with no status returns all tasks sorted by created_at desc', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });
    queue.submit({ goal: 'first' });
    queue.submit({ goal: 'second' });

    const all = queue.list();
    assert.strictEqual(all.length, 2);
    assert.ok(new Date(all[0].createdAt).getTime() >= new Date(all[1].createdAt).getTime());
  });

  it('list respects limit parameter', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });
    queue.submit({ goal: 'task 1' });
    queue.submit({ goal: 'task 2' });
    queue.submit({ goal: 'task 3' });

    const limited = queue.list('pending', 2);
    assert.strictEqual(limited.length, 2);
  });

  it('cleanup leaves pending tasks untouched', () => {
    queue = new TaskQueue({
      dbPath: ':memory:',
      maxWorkers: 0,
      retentionTtlMs: 10,
    });

    const { jobId: pendingJob } = queue.submit({ goal: 'pending task' });

    const removed = queue.cleanup();
    assert.strictEqual(removed, 0);

    const stillThere = queue.get(pendingJob);
    assert.ok(stillThere !== null);
  });

  it('getStats returns correct counts', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });
    queue.submit({ goal: 'pending 1' });
    queue.submit({ goal: 'pending 2' });

    const stats = queue.getStats();

    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.pending, 2);
    assert.strictEqual(stats.running, 0);
    assert.strictEqual(stats.completed, 0);
    assert.strictEqual(stats.failed, 0);
  });

  it('can start and stop the worker pool', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 1, pollIntervalMs: 500 });
    queue.start();
    queue.stop();
    const stats = queue.getStats();
    assert.strictEqual(stats.total, 0);
  });

  it('submit without start does not start workers', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 1 });
    queue.submit({ goal: 'should stay pending' });

    const record = queue.get(queue.list('pending')[0].jobId);
    assert.strictEqual(record?.status, 'pending');
  });

  it('is idempotent on double dispose', () => {
    queue = new TaskQueue({ dbPath: ':memory:', maxWorkers: 0 });
    queue.dispose();
    queue.dispose();
  });
});
