import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRunTransition } from '@commander/contracts';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import type { KernelRun, NewKernelStep } from './types.js';

const createRun = (steps: NewKernelStep[] = [{ id: 'step-a', kind: 'agent' }]) => ({
  id: 'run-1',
  tenantId: 'tenant-a',
  intentHash: 'intent',
  workGraphHash: 'graph',
  workGraphVersion: 'v1',
  policySnapshotId: 'policy-v1',
  steps,
});

describe('execution kernel semantics', () => {
  it('claims dependency-ready work once and fences stale completion', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(claimed?.state, 'RUNNING');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const stale = await kernel.completeStep({
      stepId: 'step-a',
      tenantId: claimed!.tenantId,
      lease: { workerId: 'worker-1', token: 'wrong', fencingEpoch: claimed!.lease!.fencingEpoch },
      expectedVersion: claimed!.version,
      actor: 'worker-1',
    });
    assert.equal(stale, null);
    const complete = await kernel.completeStep({
      stepId: 'step-a',
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { ok: true },
      actor: 'worker-1',
    });
    assert.equal(complete?.state, 'SUCCEEDED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'SUCCEEDED');
  });

  it('enforces graph dependencies and effect idempotency within a tenant', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      createRun([
        { id: 'first', kind: 'agent' },
        { id: 'second', kind: 'tool', dependencies: ['first'] },
      ]),
      'gateway',
    );
    const first = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.equal(first?.id, 'first');
    assert.equal(await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }), null);
    const admitted = await kernel.admitEffect({
      id: 'effect-1',
      runId: 'run-1',
      stepId: 'first',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'key-1',
      policyDecisionId: 'decision-1',
      request: { target: 'x' },
      lease: first!.lease!,
      actor: 'worker-1',
    });
    assert.equal(admitted.admitted, true);
    const replay = await kernel.admitEffect({
      id: 'effect-2',
      runId: 'run-1',
      stepId: 'first',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'key-1',
      policyDecisionId: 'decision-1',
      request: { target: 'x' },
      lease: first!.lease!,
      actor: 'worker-1',
    });
    assert.equal(replay.admitted && replay.replayed, true);
    const conflict = await kernel.admitEffect({
      id: 'effect-3',
      runId: 'run-1',
      stepId: 'first',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'key-1',
      policyDecisionId: 'decision-1',
      request: { target: 'different' },
      lease: first!.lease!,
      actor: 'worker-1',
    });
    assert.equal(conflict.admitted, false);
    if (!conflict.admitted) assert.equal(conflict.reason, 'IDEMPOTENCY_CONFLICT');
    const unknownAdmission = await kernel.admitEffect({
      id: 'effect-unknown',
      runId: 'run-1',
      stepId: 'first',
      tenantId: 'tenant-a',
      type: 'http.write',
      idempotencyKey: 'key-unknown',
      policyDecisionId: 'decision-1',
      request: { target: 'unknown' },
      lease: first!.lease!,
      actor: 'worker-1',
    });
    assert.equal(unknownAdmission.admitted, true);
    assert.equal(
      (
        await kernel.markEffectCompletionUnknown({
          effectId: 'effect-unknown',
          tenantId: 'tenant-a',
          reason: 'network partition after external response',
          actor: 'reconciler',
        })
      )?.state,
      'COMPLETION_UNKNOWN',
    );
    assert.equal(
      await kernel.completeEffect(
        'effect-1',
        'tenant-a',
        { workerId: 'worker-1', token: 'wrong', fencingEpoch: first!.lease!.fencingEpoch },
        { ok: true },
        'worker-1',
      ),
      null,
    );
    assert.ok(
      await kernel.completeEffect('effect-1', 'tenant-a', first!.lease!, { ok: true }, 'worker-1'),
    );
    await kernel.completeStep({
      stepId: 'first',
      tenantId: first!.tenantId,
      lease: first!.lease!,
      expectedVersion: first!.version,
      actor: 'worker-1',
    });
    assert.equal(
      (await kernel.claimNextStep({ workerId: 'worker-2', leaseTtlMs: 60_000 }))?.id,
      'second',
    );
  });

  it('listEffectsForRun returns ledger rows scoped by runId and tenantId', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    await kernel.createRun(
      {
        ...createRun([{ id: 'step-b', kind: 'agent' }]),
        id: 'run-2',
        tenantId: 'tenant-b',
      },
      'gateway',
    );
    const stepA = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 60_000,
      tenantId: 'tenant-a',
    });
    const stepB = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 60_000,
      tenantId: 'tenant-b',
    });
    assert.ok(stepA?.lease);
    assert.ok(stepB?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'eff-run1',
          runId: 'run-1',
          stepId: 'step-a',
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'k-a',
          policyDecisionId: 'pd-a',
          request: { target: 'a' },
          lease: stepA.lease,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'eff-run2',
          runId: 'run-2',
          stepId: 'step-b',
          tenantId: 'tenant-b',
          type: 'http.write',
          idempotencyKey: 'k-b',
          policyDecisionId: 'pd-b',
          request: { target: 'b' },
          lease: stepB.lease,
          actor: 'worker-2',
        })
      ).admitted,
      true,
    );

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
    await kernel.createRun(
      createRun([
        { id: 'tool-step', kind: 'tool' },
        { id: 'agent-step', kind: 'agent' },
      ]),
      'gateway',
    );
    const tool = await kernel.claimNextStep({
      workerId: 'tool-worker',
      leaseTtlMs: 60_000,
      tenantIds: ['tenant-a'],
      capabilities: ['tool'],
    });
    assert.equal(tool?.id, 'tool-step');
    assert.equal(
      await kernel.claimNextStep({
        workerId: 'agent-worker',
        leaseTtlMs: 60_000,
        tenantIds: ['tenant-a'],
        capabilities: ['agent'],
      }),
      null,
    );
    await kernel.completeStep({
      stepId: tool!.id,
      tenantId: tool!.tenantId,
      lease: tool!.lease!,
      expectedVersion: tool!.version,
      actor: 'tool-worker',
    });
    assert.equal(
      (
        await kernel.claimNextStep({
          workerId: 'agent-worker',
          leaseTtlMs: 60_000,
          tenantIds: ['tenant-a'],
          capabilities: ['agent'],
        })
      )?.id,
      'agent-step',
    );
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
    await kernel.createRun(
      createRun([
        { id: 'first', kind: 'agent' },
        { id: 'second', kind: 'tool', dependencies: ['first'] },
      ]),
      'gateway',
    );
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
    await kernel.completeStep({
      stepId: 'step-a',
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      actor: 'worker-1',
    });
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
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      workerGeneration: 7,
      leaseTtlMs: 60_000,
    });
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

  it('rejects completeStep, failStep, and heartbeatStep with a mismatched tenantId', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);

    assert.equal(
      await kernel.completeStep({
        stepId: claimed!.id,
        tenantId: 'tenant-b',
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        output: { hacked: true },
        actor: 'attacker',
      }),
      null,
    );
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RUNNING');

    assert.equal(
      await kernel.failStep({
        stepId: claimed!.id,
        tenantId: 'tenant-b',
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        error: { code: 'TEST', message: 'cross-tenant fail', retryable: false },
        actor: 'attacker',
      }),
      null,
    );
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RUNNING');

    assert.equal(
      await kernel.heartbeatStep(claimed!.id, 'tenant-b', claimed!.lease!, 60_000),
      null,
    );
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'RUNNING');
  });

  it('L3-08a reconcileEffect advances COMPLETION_UNKNOWN only (CAS)', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    const admitted = await kernel.admitEffect({
      id: 'effect-recon',
      runId: 'run-1',
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      type: 'ticket.create',
      idempotencyKey: 'idem-recon',
      policyDecisionId: 'decision-1',
      request: { title: 't' },
      lease: claimed!.lease!,
      actor: 'worker-1',
    });
    assert.equal(admitted.admitted, true);
    assert.equal(
      (
        await kernel.markEffectCompletionUnknown({
          effectId: 'effect-recon',
          tenantId: 'tenant-a',
          reason: 'timeout',
          actor: 'worker-1',
        })
      )?.state,
      'COMPLETION_UNKNOWN',
    );
    assert.equal(
      await kernel.reconcileEffect({
        effectId: 'effect-recon',
        tenantId: 'tenant-b',
        state: 'COMPLETED',
        response: { ok: true },
        actor: 'reconciler',
      }),
      null,
      'cross-tenant reconcile must fail',
    );
    assert.equal(
      (
        await kernel.reconcileEffect({
          effectId: 'effect-recon',
          tenantId: 'tenant-a',
          state: 'COMPLETED',
          response: { ticketId: 'T-1' },
          actor: 'reconciler',
        })
      )?.state,
      'COMPLETED',
    );
    assert.equal(
      await kernel.reconcileEffect({
        effectId: 'effect-recon',
        tenantId: 'tenant-a',
        state: 'FAILED',
        response: { retry: true },
        actor: 'reconciler',
      }),
      null,
      'second reconcile must be rejected (no longer UNKNOWN)',
    );
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when failStep ends the step', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-orphan',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'orphan-key',
          policyDecisionId: 'decision-1',
          request: { target: 'x' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    const failed = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'WORKER_CRASH', message: 'died after admit', retryable: false },
      actor: 'worker-1',
    });
    assert.equal(failed?.state, 'FAILED');
    assert.equal(
      (await kernel.getEffect('effect-orphan', 'tenant-a'))?.state,
      'COMPLETION_UNKNOWN',
    );
  });

  it('rejects createInteraction when step is not bound to the given tenant/run', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    await assert.rejects(
      () =>
        kernel.createInteraction(
          { runId: 'run-1', stepId: 'step-a', tenantId: 'tenant-b', prompt: 'cross-tenant?' },
          'attacker',
        ),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'STEP_NOT_FOUND',
    );
    await assert.rejects(
      () =>
        kernel.createInteraction(
          { runId: 'run-missing', stepId: 'step-a', tenantId: 'tenant-a', prompt: 'wrong run?' },
          'attacker',
        ),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'STEP_NOT_FOUND',
    );
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when cancelRun ends open steps', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun(), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-cancel-orphan',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'cancel-orphan-key',
          policyDecisionId: 'decision-1',
          request: { target: 'z' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    const cancelled = await kernel.cancelRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(cancelled?.state, 'CANCELLED');
    assert.equal((await kernel.getStep('step-a', 'tenant-a'))?.state, 'CANCELLED');
    assert.equal(
      (await kernel.getEffect('effect-cancel-orphan', 'tenant-a'))?.state,
      'COMPLETION_UNKNOWN',
    );
  });

  it('requests compensation on terminal failStep when completed effects exist', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-done',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'done-key',
          policyDecisionId: 'decision-1',
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await kernel.completeEffect(
        'effect-done',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
    );

    const failed = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: 'tenant-a',
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'DOWNSTREAM_FAILED', message: 'post-effect failure', retryable: false },
      actor: 'worker-1',
    });
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'COMPENSATING');

    const messages = await kernel.claimOutbox(100);
    const compensation = messages.filter(
      (message) => message.topic === 'commander.kernel.compensation.requested',
    );
    assert.equal(compensation.length, 1);
    assert.deepEqual(compensation[0]?.payload.effectIds, ['effect-done']);
    assert.equal(
      (await kernel.listEvents('run-1', 'tenant-a')).some(
        (event) => event.type === 'run.compensating',
      ),
      true,
    );
  });

  it('requests compensation on failStepByTimer when completed effects exist', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-deadline',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'deadline-key',
          policyDecisionId: 'decision-1',
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await kernel.completeEffect(
        'effect-deadline',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
    );

    const failed = await kernel.failStepByTimer(
      claimed!.id,
      'tenant-a',
      { code: 'STEP_DEADLINE_EXCEEDED', message: 'deadline', retryable: false },
      'kernel.timer',
    );
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'COMPENSATING');
    const messages = await kernel.claimOutbox(100);
    assert.equal(
      messages.some((message) => message.topic === 'commander.kernel.compensation.requested'),
      true,
    );
  });

  it('requests compensation on failStepByTimer when run is PAUSED with completed effects', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent', maxAttempts: 1 }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-paused',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'paused-key',
          policyDecisionId: 'decision-1',
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.ok(
      await kernel.completeEffect(
        'effect-paused',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
    );

    const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(paused?.state, 'PAUSED');
    // pauseRun parks RUNNING steps into RETRY_WAIT; timer may still fail them.
    assert.equal((await kernel.getStep(claimed!.id, 'tenant-a'))?.state, 'RETRY_WAIT');

    const failed = await kernel.failStepByTimer(
      claimed!.id,
      'tenant-a',
      { code: 'STEP_DEADLINE_EXCEEDED', message: 'deadline while paused', retryable: false },
      'kernel.timer',
    );
    assert.equal(failed?.state, 'FAILED');
    assert.equal((await kernel.getRun('run-1', 'tenant-a'))?.state, 'COMPENSATING');
    assert.equal(validateRunTransition('PAUSED', 'COMPENSATING').ok, true);

    const messages = await kernel.claimOutbox(100);
    const compensation = messages.filter(
      (message) => message.topic === 'commander.kernel.compensation.requested',
    );
    assert.equal(compensation.length, 1);
    assert.deepEqual(compensation[0]?.payload.effectIds, ['effect-paused']);
    assert.equal(
      (await kernel.listEvents('run-1', 'tenant-a')).some(
        (event) => event.type === 'run.compensating',
      ),
      true,
    );
  });

  it('prefers higher effective priority after aging instead of clamping all steps to 1000', async () => {
    const kernel = new InMemoryKernelRepository();
    const base = new Date('2026-01-01T00:00:00.000Z');
    await kernel.createRun(
      {
        ...createRun([
          {
            id: 'low-old',
            kind: 'agent',
            priority: 0,
            scheduledAt: new Date(base.getTime() - 10 * 60_000).toISOString(),
          },
          {
            id: 'high-new',
            kind: 'agent',
            priority: 100,
            scheduledAt: base.toISOString(),
          },
        ]),
      },
      'gateway',
    );

    const first = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 60_000,
      now: base,
    });
    assert.equal(first?.id, 'high-new');

    const second = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 60_000,
      now: base,
    });
    assert.equal(second?.id, 'low-old');
  });

  it('does not let GREATEST clamp hide a higher-priority fresh step behind an older low-priority peer', async () => {
    // Contrast case for GREATEST(...,1000) false-green:
    // - high-fresh: priority 200 @ base → LEAST=200, GREATEST=1000, newer scheduled_at
    // - low-aged: priority 0 aged 5m → LEAST=5, GREATEST=1000, older scheduled_at
    // LEAST picks high-fresh (200>5). GREATEST ties both at 1000 then scheduled_at ASC
    // picks low-aged — so this assertion fails under the GREATEST regression.
    const kernel = new InMemoryKernelRepository();
    const base = new Date('2026-01-01T00:00:00.000Z');
    await kernel.createRun(
      {
        ...createRun([
          {
            id: 'low-aged',
            kind: 'agent',
            priority: 0,
            scheduledAt: new Date(base.getTime() - 5 * 60_000).toISOString(),
          },
          {
            id: 'high-fresh',
            kind: 'agent',
            priority: 200,
            scheduledAt: base.toISOString(),
          },
        ]),
      },
      'gateway',
    );

    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 60_000,
      now: base,
    });
    assert.equal(claimed?.id, 'high-fresh');
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when pauseRun revokes the lease', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-pause',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'pause-key',
          policyDecisionId: 'decision-1',
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );
    assert.equal((await kernel.getEffect('effect-pause', 'tenant-a'))?.state, 'ADMITTED');

    const paused = await kernel.pauseRun('run-1', 'tenant-a', 'control-plane');
    assert.equal(paused?.state, 'PAUSED');
    assert.equal((await kernel.getStep(claimed!.id, 'tenant-a'))?.state, 'RETRY_WAIT');
    assert.equal((await kernel.getEffect('effect-pause', 'tenant-a'))?.state, 'COMPLETION_UNKNOWN');
    // Stale lease must not complete a parked effect after pause.
    assert.equal(
      await kernel.completeEffect('effect-pause', 'tenant-a', claimed!.lease!, { ok: true }, 'worker-1'),
      null,
    );
  });

  it('parks ADMITTED effects as COMPLETION_UNKNOWN when pauseTenant revokes leases', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(createRun([{ id: 'step-a', kind: 'agent' }]), 'gateway');
    const claimed = await kernel.claimNextStep({ workerId: 'worker-1', leaseTtlMs: 60_000 });
    assert.ok(claimed?.lease);
    assert.equal(
      (
        await kernel.admitEffect({
          id: 'effect-tenant-pause',
          runId: 'run-1',
          stepId: claimed!.id,
          tenantId: 'tenant-a',
          type: 'http.write',
          idempotencyKey: 'tenant-pause-key',
          policyDecisionId: 'decision-1',
          request: { target: 'crm' },
          lease: claimed!.lease!,
          actor: 'worker-1',
        })
      ).admitted,
      true,
    );

    await kernel.pauseTenant('tenant-a', 'operator', 'maintenance');
    assert.equal((await kernel.getStep(claimed!.id, 'tenant-a'))?.state, 'RETRY_WAIT');
    assert.equal((await kernel.getEffect('effect-tenant-pause', 'tenant-a'))?.state, 'COMPLETION_UNKNOWN');
    assert.equal(
      await kernel.completeEffect(
        'effect-tenant-pause',
        'tenant-a',
        claimed!.lease!,
        { ok: true },
        'worker-1',
      ),
      null,
    );
  });

  // NOTE: compensation *request* ≠ drain. packages/kernel ops compensation remains
  // probe-only unless a drain owner lands; this PR closes fail→request honesty only.
});
