import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '../testing/inMemoryRepository.js';
import { ReclaimDaemon } from './reclaimDaemon.js';

describe('reclaim daemon', () => {
  it('reclaims an expired lease and reports released work', async () => {
    const repository = new InMemoryKernelRepository();
    await repository.createRun({
      id: 'run-a', tenantId: 'tenant-a', intentHash: 'intent', workGraphHash: 'graph',
      workGraphVersion: 'v1', policySnapshotId: 'policy',
      steps: [{
        id: 'step-a', kind: 'agent', maxAttempts: 2,
        scheduledAt: '2026-07-15T00:00:00.000Z',
      }],
    }, 'gateway');
    await repository.claimNextStep({
      tenantId: 'tenant-a', workerId: 'worker-a', leaseTtlMs: 1,
      now: new Date('2026-07-15T00:00:00.000Z'),
    });
    const daemon = new ReclaimDaemon(repository, { batchSize: 10 });

    const stats = await daemon.tick(new Date('2026-07-15T00:00:01.000Z'));

    assert.equal(stats.cycles, 1);
    assert.equal(stats.reclaimed, 1);
    assert.equal(stats.requeued, 1);
    assert.equal(stats.failed, 0);
    assert.equal((await repository.getStep('step-a', 'tenant-a'))?.state, 'RETRY_WAIT');
  });

  it('does not overlap ticks', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const repository = {
      reclaimExpiredLeases: async () => { calls++; await blocked; return []; },
    } as unknown as InMemoryKernelRepository;
    const daemon = new ReclaimDaemon(repository);
    const first = daemon.tick();
    const second = daemon.tick();
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
  });

  it('durably requests compensation after terminal reclaim of a completed effect', async () => {
    const repository = new InMemoryKernelRepository();
    const base = new Date();
    await repository.createRun({
      id: 'run-a', tenantId: 'tenant-a', intentHash: 'intent', workGraphHash: 'graph',
      workGraphVersion: 'v1', policySnapshotId: 'policy',
      steps: [{
        id: 'step-a', kind: 'agent', maxAttempts: 1,
        scheduledAt: new Date(base.getTime() - 1_000).toISOString(),
      }],
    }, 'gateway');
    const claimed = await repository.claimNextStep({
      tenantId: 'tenant-a', workerId: 'worker-a', leaseTtlMs: 1_000,
      now: base,
    });
    assert.ok(claimed?.lease);
    const admitted = await repository.admitEffect({
      id: 'effect-a', runId: 'run-a', stepId: 'step-a', tenantId: 'tenant-a',
      type: 'tool', idempotencyKey: 'effect-key', request: { tool: 'write' },
      policyDecisionId: 'decision-a', lease: claimed.lease, actor: 'worker-a',
    });
    assert.equal(admitted.admitted, true);
    assert.ok(await repository.completeEffect(
      'effect-a', 'tenant-a', claimed.lease, { ok: true }, 'worker-a',
    ));

    await new ReclaimDaemon(repository).tick(new Date(base.getTime() + 2_000));

    assert.equal((await repository.getRun('run-a', 'tenant-a'))?.state, 'COMPENSATING');
    const messages = await repository.claimOutbox(100, new Date(base.getTime() + 3_000));
    const compensation = messages.filter(
      (message) => message.topic === 'commander.kernel.compensation.requested',
    );
    assert.equal(compensation.length, 1);
    assert.equal(compensation[0]?.payload.effectIds instanceof Array, true);
    assert.equal(compensation[0]?.key, 'tenant-a/run-a/1');
    const events = await repository.listEvents('run-a', 'tenant-a');
    assert.equal(events.some((event) => event.type === 'run.compensating'), true);
  });

  it('marks an admitted effect completion unknown when its lease expires', async () => {
    const repository = new InMemoryKernelRepository();
    const base = new Date();
    await repository.createRun({
      id: 'run-a', tenantId: 'tenant-a', intentHash: 'intent', workGraphHash: 'graph',
      workGraphVersion: 'v1', policySnapshotId: 'policy',
      steps: [{
        id: 'step-a', kind: 'agent', maxAttempts: 2,
        scheduledAt: new Date(base.getTime() - 1_000).toISOString(),
      }],
    }, 'gateway');
    const claimed = await repository.claimNextStep({
      tenantId: 'tenant-a', workerId: 'worker-a', leaseTtlMs: 1_000, now: base,
    });
    assert.ok(claimed?.lease);
    assert.equal((await repository.admitEffect({
      id: 'effect-a', runId: 'run-a', stepId: 'step-a', tenantId: 'tenant-a',
      type: 'tool', idempotencyKey: 'effect-key', request: { tool: 'write' },
      policyDecisionId: 'decision-a', lease: claimed.lease, actor: 'worker-a',
    })).admitted, true);

    await new ReclaimDaemon(repository).tick(new Date(base.getTime() + 2_000));

    const events = await repository.listEvents('run-a', 'tenant-a');
    assert.equal(events.some((event) => event.type === 'effect.completion_unknown'), true);
  });
});
