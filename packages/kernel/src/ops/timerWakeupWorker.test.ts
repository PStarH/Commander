import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '../testing/inMemoryRepository.js';
import type { KernelRepository } from '../repository.js';
import { TimerWakeupWorker } from './timerWakeupWorker.js';

describe('timer wakeup durability', () => {
  it('returns a claimed timer to pending when its lifecycle action fails', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun({
      id: 'run-a', tenantId: 'tenant-a', intentHash: 'intent', workGraphHash: 'graph',
      workGraphVersion: 'v1', policySnapshotId: 'policy',
      steps: [{ id: 'step-a', kind: 'agent' }],
    }, 'gateway');
    await repository.createTimer({
      runId: 'run-a', stepId: 'step-a', tenantId: 'tenant-a',
      firesAt: new Date(Date.now() - 1_000), timerType: 'STEP_DEADLINE',
    }, 'kernel');
    repository.failStepByTimer = async () => { throw new Error('temporary database failure'); };
    const worker = new TimerWakeupWorker(repository);

    await worker.tick();

    const reclaimed = await repository.claimExpiredTimers(new Date(), 10);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.state, 'PROCESSING');
    assert.equal(worker.getStats().errors, 1);
  });

  it('is unhealthy before the first successful tick', async () => {
    const repository = new InMemoryKernelRepository();
    const worker = new TimerWakeupWorker(repository, { pollIntervalMs: 60_000 });
    assert.equal(worker.isHealthy(), false);
    worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.isHealthy(), true);
    await worker.stop();
    assert.equal(worker.isHealthy(), false);
  });

  it('does not treat a pre-start tick as healthy after start until a new tick succeeds', async () => {
    const repository = new InMemoryKernelRepository();
    const worker = new TimerWakeupWorker(repository, { pollIntervalMs: 60_000 });
    await worker.tick();
    assert.equal(worker.isHealthy(), false);
    worker.start();
    assert.equal(worker.isHealthy(), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.isHealthy(), true);
    await worker.stop();
  });

  it('ignores an in-flight pre-start tick when stamping health after start', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const repository = {
      claimExpiredTimers: async () => { calls += 1; await blocked; return []; },
      expireStaleInteractions: async () => [],
      sweepOutboxDlq: async () => ({ movedToDlq: 0, backoffApplied: 0 }),
    } as unknown as KernelRepository;
    const worker = new TimerWakeupWorker(repository, { pollIntervalMs: 60_000 });
    const pending = worker.tick();
    await Promise.resolve();
    worker.start();
    assert.equal(worker.isHealthy(), false);
    release();
    await pending;
    assert.equal(worker.isHealthy(), false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.isHealthy(), true);
    assert.equal(calls, 2);
    await worker.stop();
  });

  it('awaits the original slow tick even after another interval elapses', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const repository = {
      claimExpiredTimers: async () => { await blocked; return []; },
      expireStaleInteractions: async () => [],
      sweepOutboxDlq: async () => ({ movedToDlq: 0, backoffApplied: 0 }),
    } as unknown as KernelRepository;
    const worker = new TimerWakeupWorker(repository, { pollIntervalMs: 1 });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    release();
    await stopping;
    assert.equal(stopped, true);
  });
});
