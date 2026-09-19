import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KernelOpsRuntime } from './opsRuntime.js';

const healthyLoop = () => ({
  start: () => {},
  stop: async () => {},
  isHealthy: () => true,
});

/** A publish tick that fully delivered (or had nothing to deliver). */
const delivered = { published: 1, duplicates: 0, retried: 0, failed: 0 };
const fullyFailed = { published: 0, duplicates: 0, retried: 0, failed: 3 };

describe('kernel ops runtime', () => {
  it('starts and stops reclaim, timer, outbox, and compensation as one runtime', async () => {
    const calls: string[] = [];
    const runtime = new KernelOpsRuntime({
      reclaim: {
        start: () => {
          calls.push('reclaim:start');
        },
        stop: async () => {
          calls.push('reclaim:stop');
        },
        isHealthy: () => true,
      },
      timer: {
        start: () => {
          calls.push('timer:start');
        },
        stop: () => {
          calls.push('timer:stop');
        },
        isHealthy: () => true,
      },
      outbox: {
        publish: async () => {
          calls.push('outbox:publish');
          return delivered;
        },
      },
      compensation: {
        start: () => {
          calls.push('compensation:start');
        },
        stop: async () => {
          calls.push('compensation:stop');
        },
        isHealthy: () => true,
      },
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    runtime.start();
    assert.deepEqual(runtime.runningComponents(), ['reclaim', 'timer', 'outbox', 'compensation']);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isReady(), true);
    await runtime.stop();
    assert.deepEqual(runtime.runningComponents(), []);
    assert.equal(calls.includes('reclaim:start'), true);
    assert.equal(calls.includes('timer:start'), true);
    assert.equal(calls.includes('compensation:start'), true);
    assert.equal(calls.includes('outbox:publish'), true);
    assert.equal(calls.includes('compensation:stop'), true);
  });

  it('isReady fails closed when any loop is stale', async () => {
    const runtime = new KernelOpsRuntime({
      reclaim: { ...healthyLoop(), isHealthy: () => false },
      timer: healthyLoop(),
      outbox: { publish: async () => delivered },
      compensation: healthyLoop(),
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });
    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isReady(), false);
    await runtime.stop();
  });

  it('contains an outbox tick failure so shutdown remains clean', async () => {
    const runtime = new KernelOpsRuntime({
      reclaim: healthyLoop(),
      timer: healthyLoop(),
      outbox: {
        publish: async () => {
          throw new Error('temporary database failure');
        },
      },
      compensation: healthyLoop(),
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isReady(), false);
    await assert.doesNotReject(runtime.stop());
  });

  it('requires a fresh outbox success after restart', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishes = 0;
    const runtime = new KernelOpsRuntime({
      reclaim: healthyLoop(),
      timer: healthyLoop(),
      outbox: {
        publish: async () => {
          publishes += 1;
          if (publishes > 1) await blocked;
          return delivered;
        },
      },
      compensation: healthyLoop(),
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isReady(), true);
    await runtime.stop();

    runtime.start();
    // Second start clears lastOutboxOkAt and blocks the new publish.
    assert.equal(runtime.isReady(), false);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isReady(), true);
    await runtime.stop();
  });

  it('does not become ready from an outbox publish that spanned stop()', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishes = 0;
    const runtime = new KernelOpsRuntime({
      reclaim: healthyLoop(),
      timer: healthyLoop(),
      outbox: {
        publish: async () => {
          publishes += 1;
          if (publishes === 1) await blocked;
          return delivered;
        },
      },
      compensation: healthyLoop(),
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    runtime.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(publishes, 1);
    assert.equal(runtime.isReady(), false);
    const stopping = runtime.stop();
    assert.equal(runtime.isReady(), false);
    release();
    await stopping;
    assert.equal(runtime.isReady(), false);
    assert.equal(publishes, 1);
  });

  it('overlapping stop then start does not wipe a fresh outbox success', async () => {
    let releaseReclaimStop!: () => void;
    const reclaimStopBlocked = new Promise<void>((resolve) => {
      releaseReclaimStop = resolve;
    });
    let reclaimStopCount = 0;
    const runtime = new KernelOpsRuntime({
      reclaim: {
        start: () => {},
        stop: async () => {
          reclaimStopCount += 1;
          if (reclaimStopCount === 1) await reclaimStopBlocked;
        },
        isHealthy: () => true,
      },
      timer: healthyLoop(),
      outbox: { publish: async () => delivered },
      compensation: healthyLoop(),
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    try {
      runtime.start();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runtime.isReady(), true);

      const stopping = runtime.stop();
      runtime.start();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runtime.isReady(), true);

      releaseReclaimStop();
      await stopping;
      // stop()'s trailing clear must not erase the new epoch's outbox stamp.
      assert.equal(runtime.isReady(), true);
    } finally {
      releaseReclaimStop();
      await runtime.stop();
    }
  });

  it('does not report ready while every claimed outbox message fails to publish', async () => {
    const runtime = new KernelOpsRuntime({
      reclaim: healthyLoop(),
      timer: healthyLoop(),
      outbox: { publish: async () => fullyFailed },
      compensation: healthyLoop(),
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    runtime.start();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        runtime.isReady(),
        false,
        'a publish tick that delivered none of its claimed messages must not stamp readiness',
      );
    } finally {
      await runtime.stop();
    }
  });

  it('recovers readiness on the first outbox tick that fully delivers', async () => {
    let tick = 0;
    const runtime = new KernelOpsRuntime({
      reclaim: healthyLoop(),
      timer: healthyLoop(),
      outbox: {
        publish: async () => {
          tick += 1;
          return tick === 1 ? fullyFailed : delivered;
        },
      },
      compensation: healthyLoop(),
      outboxIntervalMs: 60_000,
      outboxBatchSize: 10,
    });

    let readyAfterFailedTick = true;
    runtime.start();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      readyAfterFailedTick = runtime.isReady();
    } finally {
      await runtime.stop();
    }

    // A later tick that delivers must be able to clear the failure.
    runtime.start();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(readyAfterFailedTick, false, 'a failed tick must not stamp readiness');
      assert.equal(runtime.isReady(), true, 'a delivering tick must restore readiness');
    } finally {
      await runtime.stop();
    }
  });
});
