import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRunTransition } from '@commander/contracts';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import type { KernelRun, NewKernelStep } from './types.js';

const createRun = (steps: NewKernelStep[] = [{ id: 'step-a', kind: 'agent' }]) => ({
  id: 'run-1', tenantId: 'tenant-a', intentHash: 'intent', workGraphHash: 'graph', workGraphVersion: 'v1', policySnapshotId: 'policy-v1', steps,
});

describe('execution kernel semantics', () => {
  it('claims dependency-ready work once and fences stale completion', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(claimed?.state, 'RUNNING');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const stale = await kernel.completeStep({ stepId: 'step-a', tenantId: claimed!.tenantId, lease: { workerId: 'worker-1', token: 'wrong', fencingEpoch: claimed!.lease!.fencingEpoch }, expectedVersion: claimed!.version, actor: 'worker-1' });
    assert.equal(stale, null);
    const complete = await kernel.completeStep({ stepId: 'step-a', tenantId: claimed!.tenantId, lease: claimed!.lease!, expectedVersion: claimed!.version, output: { ok: true }, actor: 'worker-1' });
    assert.equal(complete?.state, 'SUCCEEDED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'SUCCEEDED');
  });

  it('enforces graph dependencies and effect idempotency within a tenant', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'first', kind: 'agent' }, { id: 'second', kind: 'tool', dependencies: ['first'] }]), 'gateway');
    const first = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(first?.id, 'first');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const admitted = await kernel.admitEffect({ id: 'effect-1', runId: 'run-1', stepId: 'first', tenantId: 'tenant-a', type: 'http.write', idempotencyKey: 'key-1', policyDecisionId: 'decision-1', request: { target: 'x' }, lease: first!.lease!, actor: 'worker-1' });
    assert.equal(admitted.admitted, true);
    const replay = await kernel.admitEffect({ id: 'effect-2', runId: 'run-1', stepId: 'first', tenantId: 'tenant-a', type: 'http.write', idempotencyKey: 'key-1', policyDecisionId: 'decision-1', request: { target: 'x' }, lease: first!.lease!, actor: 'worker-1' });
    assert.equal(replay.admitted && replay.replayed, true);
    const conflict = await kernel.admitEffect({ id: 'effect-3', runId: 'run-1', stepId: 'first', tenantId: 'tenant-a', type: 'http.write', idempotencyKey: 'key-1', policyDecisionId: 'decision-1', request: { target: 'different' }, lease: first!.lease!, actor: 'worker-1' });
    assert.equal(conflict.admitted, false);
    if (!conflict.admitted) assert.equal(conflict.reason, 'IDEMPOTENCY_CONFLICT');
    const unknownAdmission = await kernel.admitEffect({ id: 'effect-unknown', runId: 'run-1', stepId: 'first', tenantId: 'tenant-a', type: 'http.write', idempotencyKey: 'key-unknown', policyDecisionId: 'decision-1', request: { target: 'unknown' }, lease: first!.lease!, actor: 'worker-1' });
    assert.equal(unknownAdmission.admitted, true);
    assert.equal((await kernel.markEffectCompletionUnknown({ effectId: 'effect-unknown', tenantId: 'tenant-a', reason: 'network partition after external response', actor: 'reconciler' }))?.state, 'COMPLETION_UNKNOWN');
    assert.equal(await kernel.completeEffect('effect-1', 'tenant-a', { workerId: 'worker-1', token: 'wrong', fencingEpoch: first!.lease!.fencingEpoch }, { ok: true }, 'worker-1'), null);
    assert.ok(await kernel.completeEffect('effect-1', 'tenant-a', first!.lease!, { ok: true }, 'worker-1'));
    await kernel.completeStep({ stepId: 'first', tenantId: first!.tenantId, lease: first!.lease!, expectedVersion: first!.version, actor: 'worker-1' });
    assert.equal((await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }))?.id, 'second');
  });

  it('listEffectsForRun returns ledger rows scoped by runId and tenantId', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    await kernel.createRun({
      ...createRun([{ id: 'step-b', kind: 'agent' }]),
      id: 'run-2',
      tenantId: 'tenant-b',
    }, 'gateway');
    const stepA = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000, tenantId: 'tenant-a' });
    const stepB = await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000, tenantId: 'tenant-b' });
    assert.ok(stepA?.lease);
    assert.ok(stepB?.lease);
    assert.equal((await kernel.admitEffect({
      id: 'eff-run1', runId: 'run-1', stepId: 'step-a', tenantId: 'tenant-a',
      type: 'http.write', idempotencyKey: 'k-a', policyDecisionId: 'pd-a',
      request: { target: 'a' }, lease: stepA.lease, actor: 'worker-1',
    })).admitted, true);
    assert.equal((await kernel.admitEffect({
      id: 'eff-run2', runId: 'run-2', stepId: 'step-b', tenantId: 'tenant-b',
      type: 'http.write', idempotencyKey: 'k-b', policyDecisionId: 'pd-b',
      request: { target: 'b' }, lease: stepB.lease, actor: 'worker-2',
    })).admitted, true);

    const forRun1 = await kernel.listEffectsForRun('run-1', 'tenant-a');
    assert.equal(forRun1.length, 1);
    assert.equal(forRun1[0]?.id, 'eff-run1');
    assert.deepEqual(await kernel.listEffectsForRun('run-1', 'tenant-b'), []);
    assert.deepEqual(await kernel.listEffectsForRun('run-missing', 'tenant-a'), []);
  });

  it('writes an outbox message for lifecycle events', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const messages = await kernel.claimOutbox(10);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.topic, 'commander.run.created');
    assert.equal(await kernel.markOutboxPublished(messages[0]!.id, messages[0]!.claimToken!), true);
    assert.equal((await kernel.claimOutbox(10)).length, 0);
  });

  it('reclaims an expired lease and fails the run after retry budget is exhausted', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 1 });
    const reclaimed = await kernel.reclaimExpiredLeases(new Date(Date.now() + 10));
    assert.equal(reclaimed[0]?.state, 'FAILED');
    assert.equal((await kernel.getRun(claimed!.runId, 'tenant-a'))?.state, 'FAILED');
  });

  it('applies worker capability and tenant-wide concurrency constraints at claim time', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.setTenantConcurrencyLimit('tenant-a', 1);
    await kernel.createRun(createRun([{ id: 'tool-step', kind: 'tool' }, { id: 'agent-step', kind: 'agent' }]), 'gateway');
    const tool = await kernel.claimNextStep({ workerId: 'tool-worker', leaseTtlMs: 60_000, tenantIds: ['tenant-a'], capabilities: ['tool'] });
    assert.equal(tool?.id, 'tool-step');
    assert.equal(await kernel.claimNextStep({ workerId: 'agent-worker', leaseTtlMs: 60_000, tenantIds: ['tenant-a'], capabilities: ['agent'] }), null);
    await kernel.completeStep({ stepId: tool!.id, tenantId: tool!.tenantId, lease: tool!.lease!, expectedVersion: tool!.version, actor: 'tool-worker' });
    assert.equal((await kernel.claimNextStep({ workerId: 'agent-worker', leaseTtlMs: 60_000, tenantIds: ['tenant-a'], capabilities: ['agent'] }))?.id, 'agent-step');
  });

  it('pauses a running run and releases active worker leases', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(claimed?.state, 'RUNNING');
    const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(paused?.state, 'PAUSED');
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RETRY_WAIT');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const events = await kernel.listEvents('run-1', 'tenant-a');
    assert.ok(events.some((event) => event.type === 'run.paused'));
    assert.ok(events.some((event) => event.type === 'step.paused'));
  });

  it('resumes a paused run so steps become claimable again', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    const resumed = await kernel.resumeRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(resumed?.state, 'RUNNING');
    assert.equal(resumed?.pausedAt, undefined);
    const reclaimed = await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 });
    assert.equal(reclaimed?.state, 'RUNNING');
    const events = await kernel.listEvents('run-1', 'tenant-a');
    assert.ok(events.some((event) => event.type === 'run.resumed'));
  });

  it('cancels a run and marks all non-terminal steps cancelled', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'first', kind: 'agent' }, { id: 'second', kind: 'tool', dependencies: ['first'] }]), 'gateway');
    const first = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(first?.id, 'first');
    const cancelled = await kernel.cancelRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(cancelled?.state, 'CANCELLED');
    assert.equal((await kernel.getStep('first', 'tenant-a'))?.state, 'CANCELLED');
    assert.equal((await kernel.getStep('second', 'tenant-a'))?.state, 'CANCELLED');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const events = await kernel.listEvents('run-1', 'tenant-a');
    assert.ok(events.some((event) => event.type === 'run.cancelled'));
    assert.ok(events.some((event) => event.type === 'step.cancelled'));
  });

  it('rejects lifecycle commands on terminal runs', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    await kernel.completeStep({ stepId: 'step-a', tenantId: claimed!.tenantId, lease: claimed!.lease!, expectedVersion: claimed!.version, actor: 'worker-1' });
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'SUCCEEDED');
    assert.equal(await kernel.pauseRun('run-1', 'tenant-a', 'control-plane'), null);
    assert.equal(await kernel.resumeRun('run-1', 'tenant-a', 'control-plane'), null);
    assert.equal(await kernel.cancelRun('run-1', 'tenant-a', 'control-plane'), null);
  });

  it('only performs run state transitions that are valid in @commander/contracts', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    let run: KernelRun | null = await kernel.getRun('run-1', 'tenant-a');
    assert.equal(run?.state, 'PENDING');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(validateRunTransition('PENDING', 'RUNNING').ok, true);
    run = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(run?.state, 'PAUSED');
    assert.equal(validateRunTransition('RUNNING', 'PAUSED').ok, true);
    run = await kernel.resumeRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(run?.state, 'RUNNING');
    assert.equal(validateRunTransition('PAUSED', 'RUNNING').ok, true);
    run = await kernel.cancelRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(run?.state, 'CANCELLED');
    assert.equal(validateRunTransition('RUNNING', 'CANCELLED').ok, true);
    assert.equal(await kernel.pauseRun('run-1', 'tenant-a', 'control-plane'), null);
    assert.equal(validateRunTransition('CANCELLED', 'PAUSED').ok, false);
  });

  it('fences a completion presented with a stale worker generation', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-generation', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', workerGeneration: 7, leaseTtlMs: 60_000 });
    assert.equal(claimed?.lease?.workerGeneration, 7);
    const stale = await kernel.completeStep({
      stepId: 'step-generation',
      tenantId: claimed!.tenantId,
      lease: { ...claimed!.lease!, workerGeneration: 6 },
      expectedVersion: claimed!.version,
      actor: 'worker-1',
    });
    assert.equal(stale, null);
    assert.equal((await kernel.getStep('step-generation', 'tenant-a'))?.state, 'RUNNING');
  });
});
