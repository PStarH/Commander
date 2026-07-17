import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KernelOpsRuntime } from './opsRuntime.js';

describe('kernel ops runtime', () => {
  it('starts and stops reclaim, timer, outbox, and compensation as one runtime', async () => {
    const calls: string[] = [];
    const runtime = new KernelOpsRuntime({
      reclaim: { start: () => { calls.push('reclaim:start'); }, stop: async () => { calls.push('reclaim:stop'); } },
      timer: { start: () => { calls.push('timer:start'); }, stop: () => { calls.push('timer:stop'); } },
      outbox: { publish: async () => { calls.push('outbox:publish'); } },
      compensation: {
        start: () => { calls.push('compensation:start'); },
        stop: async () => { calls.push('compensation:stop'); },
      },
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    runtime.start();
    assert.deepEqual(runtime.runningComponents(), ['reclaim', 'timer', 'outbox', 'compensation']);
    await runtime.stop();
    assert.deepEqual(runtime.runningComponents(), []);
    assert.equal(calls.includes('reclaim:start'), true);
    assert.equal(calls.includes('timer:start'), true);
    assert.equal(calls.includes('compensation:start'), true);
    assert.equal(calls.includes('outbox:publish'), true);
    assert.equal(calls.includes('compensation:stop'), true);
  });

  it('contains an outbox tick failure so shutdown remains clean', async () => {
    const runtime = new KernelOpsRuntime({
      reclaim: { start: () => {}, stop: async () => {} },
      timer: { start: () => {}, stop: () => {} },
      outbox: { publish: async () => { throw new Error('temporary database failure'); } },
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.doesNotReject(runtime.stop());
  });
});
