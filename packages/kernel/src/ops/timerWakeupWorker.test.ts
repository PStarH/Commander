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
