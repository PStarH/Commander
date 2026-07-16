import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import type { CreateKernelRun } from './types.js';

function run(tenantId: string, runId: string, stepId: string): CreateKernelRun {
  return {
    id: runId,
    tenantId,
    intentHash: `intent-${runId}`,
    workGraphHash: `graph-${runId}`,
    workGraphVersion: 'v1',
    policySnapshotId: 'policy-v1',
    steps: [{ id: stepId, kind: 'agent', maxAttempts: 2 }],
  };
}

describe('tenant execution pause', () => {
  it('revokes all active leases for one tenant and blocks only that tenant', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(run('tenant-a', 'run-a', 'step-a'), 'gateway');
    await kernel.createRun(run('tenant-b', 'run-b', 'step-b'), 'gateway');
    const stepA = await kernel.claimNextStep({
      tenantId: 'tenant-a', workerId: 'worker-a', leaseTtlMs: 60_000,
    });
    const stepB = await kernel.claimNextStep({
      tenantId: 'tenant-b', workerId: 'worker-b', leaseTtlMs: 60_000,
    });
    assert.ok(stepA?.lease);
    assert.ok(stepB?.lease);

    const control = await kernel.pauseTenant('tenant-a', 'operator', 'incident');

    assert.equal(control.paused, true);
    assert.equal(control.reason, 'incident');
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RETRY_WAIT');
    assert.equal(await kernel.heartbeatStep('step-a', 'tenant-a', stepA.lease, 60_000), null);
    assert.notEqual(await kernel.heartbeatStep('step-b', 'tenant-b', stepB.lease, 60_000), null);
    assert.equal(await kernel.claimNextStep({
      tenantId: 'tenant-a', workerId: 'worker-a', leaseTtlMs: 60_000,
    }), null);
  });

  it('resumes the tenant gate without resuming individually paused runs', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(run('tenant-a', 'run-a', 'step-a'), 'gateway');
    await kernel.pauseRun('run-a', 'tenant-a', 'operator');
    await kernel.pauseTenant('tenant-a', 'operator');

    const control = await kernel.resumeTenant('tenant-a', 'operator');

    assert.equal(control.paused, false);
    assert.equal((await kernel.getRun('run-a', 'tenant-a'))?.state, 'PAUSED');
    assert.equal(await kernel.claimNextStep({
      tenantId: 'tenant-a', workerId: 'worker-a', leaseTtlMs: 60_000,
    }), null);
  });
});
