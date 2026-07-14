/**
 * V2 Fault Recovery Tests — Architecture V2 zombie worker recovery.
 *
 * These tests prove the kernel's fault recovery mechanism works:
 *   1. Worker claims step → crashes (simulated by never completing)
 *   2. Lease expires
 *   3. reclaimExpiredLeases() requeues the step
 *   4. New worker claims and completes the step
 *
 * Additionally tests:
 *   - Fencing tokens prevent zombie workers from completing stale steps
 *   - Multi-attempt retry with eventual terminal failure
 *
 * These tests are CI-blocking architecture invariants: they prove the system
 * can survive worker crashes without losing or duplicating work.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import type { KernelRepository } from '../../../kernel/src/repository.js';
import type { KernelEvent, KernelStep } from '../../../kernel/src/types.js';

interface ClaimedStep {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  version: number;
  attempt: number;
  input: Record<string, unknown>;
  lease: { workerId: string; token: string; fencingEpoch: number; expiresAt: string };
}

interface StepExecutor {
  execute(
    step: ClaimedStep,
    context: { signal: AbortSignal; worker: { id: string; kind: string; capabilities: string[] } },
  ): Promise<Record<string, unknown> | undefined>;
}

class MockStepExecutor implements StepExecutor {
  readonly executions: ClaimedStep[] = [];
  private results = new Map<string, Record<string, unknown>>();
  private failureMode: { match?: (step: ClaimedStep) => boolean; error: Error } | null = null;

  setResult(stepKind: string, output: Record<string, unknown>): void {
    this.results.set(stepKind, output);
  }

  setFailure(match: (step: ClaimedStep) => boolean, error: Error): void {
    this.failureMode = { match, error };
  }

  async execute(
    step: ClaimedStep,
    _context: { signal: AbortSignal; worker: { id: string; kind: string; capabilities: string[] } },
  ): Promise<Record<string, unknown> | undefined> {
    this.executions.push(step);
    if (this.failureMode?.match?.(step)) throw this.failureMode.error;
    return (
      this.results.get(step.kind) ?? {
        status: 'success',
        summary: `Executed ${step.kind}`,
        runId: step.runId,
      }
    );
  }
}

async function executeStep(
  kernel: KernelRepository,
  workerId: string,
  executor: StepExecutor,
  leaseTtlMs = 30_000,
): Promise<{
  step: ClaimedStep | null;
  completed: boolean;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}> {
  const claimed = await kernel.claimNextStep({
    workerId,
    leaseTtlMs,
    tenantIds: [],
    capabilities: [],
  });
  if (!claimed) return { step: null, completed: false };

  const step: ClaimedStep = {
    id: claimed.id,
    runId: claimed.runId,
    tenantId: claimed.tenantId,
    kind: claimed.kind,
    version: claimed.version,
    attempt: claimed.attempt,
    input: claimed.input,
    lease: claimed.lease!,
  };

  const controller = new AbortController();
  try {
    const output = await executor.execute(step, {
      signal: controller.signal,
      worker: { id: workerId, kind: 'agent', capabilities: [] },
    });
    await kernel.completeStep({
      stepId: step.id,
      tenantId: step.tenantId,
      lease: step.lease,
      expectedVersion: step.version,
      output,
      actor: workerId,
    });
    return { step, completed: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = message.includes('timeout') || message.includes('temporary');
    await kernel.failStep({
      stepId: step.id,
      tenantId: step.tenantId,
      lease: step.lease,
      expectedVersion: step.version,
      error: { code: 'EXECUTOR_FAILED', message, retryable },
      actor: workerId,
    });
    return { step, completed: false, error: { code: 'EXECUTOR_FAILED', message, retryable } };
  }
}

function createRunCommand(
  tenantId: string,
  steps: Array<{
    kind: string;
    input?: Record<string, unknown>;
    dependencies?: string[];
    maxAttempts?: number;
  }>,
) {
  const runId = randomUUID();
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    input: s.input ?? { goal: `Execute ${s.kind}`, agentId: 'test-agent' },
    dependencies: s.dependencies,
    maxAttempts: s.maxAttempts,
  }));
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(JSON.stringify(stepDefs)).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'test-policy',
    steps: stepDefs,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('V2 Fault Recovery — Zombie Worker & Lease Expiry', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-recovery';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('should requeue step when worker lease expires (simulated crash)', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Survive crash', agentId: 'agent' }, maxAttempts: 3 },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimed, 'Worker-1 should claim the step');
    assert.equal(claimed!.attempt, 1, 'First attempt');

    // Worker-1 "crashes" — wait for lease to expire
    await sleep(80);

    // Reclaim expired leases (use real now — lease has actually expired)
    const reclaimed = await kernel.reclaimExpiredLeases(new Date(), 100);

    assert.equal(reclaimed.length, 1, 'One step should be reclaimed');
    assert.equal(reclaimed[0].state, 'RETRY_WAIT', 'Step should be in RETRY_WAIT');

    // Worker-2 claims and completes the requeued step
    const executor = new MockStepExecutor();
    executor.setResult('agent', { status: 'success', summary: 'Recovered', runId: run.id });

    const result = await executeStep(kernel, 'worker-2', executor);

    assert.ok(result.step, 'Worker-2 should claim the requeued step');
    assert.equal(result.completed, true, 'Worker-2 should complete the step');
    assert.equal(result.step!.attempt, 2, 'Second attempt');

    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');

    const events = await kernel.listEvents(run.id, tenantId);
    const eventTypes = events.map((e: KernelEvent) => e.type);
    assert.ok(
      eventTypes.includes('step.lease_expired_requeued'),
      'Should have lease_expired_requeued event',
    );
    assert.ok(eventTypes.includes('step.succeeded'), 'Should have step.succeeded event');
  });

  it('should prevent zombie worker from completing after lease expires (fencing)', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Fencing test', agentId: 'agent' }, maxAttempts: 3 },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimed);
    const staleLease = claimed!.lease!;
    const staleVersion = claimed!.version;

    // Wait for lease to expire, then reclaim
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Worker-2 claims the step (gets new lease with higher fencing epoch)
    const reclaimed = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(reclaimed);
    assert.ok(
      reclaimed!.lease!.fencingEpoch > staleLease.fencingEpoch,
      'New lease should have higher fencing epoch',
    );

    // Zombie Worker-1 tries to complete with stale lease — must fail
    const zombieComplete = await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: staleLease,
      expectedVersion: staleVersion,
      output: { status: 'success', summary: 'Zombie write', runId: run.id },
      actor: 'worker-1',
    });
    assert.equal(zombieComplete, null, 'Zombie worker must not be able to complete step');

    // Worker-2 completes with valid lease
    const validComplete = await kernel.completeStep({
      stepId: reclaimed!.id,
      tenantId: reclaimed!.tenantId,
      lease: reclaimed!.lease!,
      expectedVersion: reclaimed!.version,
      output: { status: 'success', summary: 'Valid completion', runId: run.id },
      actor: 'worker-2',
    });
    assert.ok(validComplete, 'Worker-2 should complete the step');

    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');
  });

  it('should prevent zombie worker from failing after lease expires (fencing on failStep)', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Fencing fail test', agentId: 'agent' }, maxAttempts: 3 },
    ]);
    await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const claimed = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimed);

    // Wait for lease to expire, then reclaim
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Zombie Worker-1 tries to fail the step — must be rejected
    const zombieFail = await kernel.failStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'ZOMBIE', message: 'Zombie fail attempt', retryable: false },
      actor: 'worker-1',
    });
    assert.equal(zombieFail, null, 'Zombie worker must not be able to fail step');

    // Step should still be claimable by a new worker
    const reclaimed = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(reclaimed, 'Step should be claimable by new worker after zombie rejection');
  });

  it('should terminally fail step after max attempts exhausted', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Exhaust retries', agentId: 'agent' }, maxAttempts: 2 },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    // Attempt 1: claim → crash → reclaim
    const claim1 = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claim1);
    assert.equal(claim1!.attempt, 1);
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Attempt 2: claim → crash → reclaim (maxAttempts=2, so this should terminally fail)
    const claim2 = await kernel.claimNextStep({
      workerId: 'w2',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claim2);
    assert.equal(claim2!.attempt, 2);
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Step should now be FAILED (not RETRY_WAIT)
    const step = await kernel.getStep(command.steps[0].id, tenantId);
    assert.equal(step!.state, 'FAILED', 'Step should be FAILED after exhausting max attempts');

    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'FAILED');

    // No more steps should be claimable
    const claim3 = await kernel.claimNextStep({
      workerId: 'w3',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(claim3, null, 'No steps should be claimable after terminal failure');
  });

  it('should handle pause and resume of a run', async () => {
    const step0Id = randomUUID();
    const step1Id = randomUUID();
    const runId = randomUUID();

    await kernel.createRun(
      {
        id: runId,
        tenantId,
        intentHash: createHash('sha256').update(runId).digest('hex'),
        workGraphHash: createHash('sha256').update(runId).digest('hex'),
        workGraphVersion: 'v1',
        policySnapshotId: 'test-policy',
        steps: [
          { id: step0Id, kind: 'agent', input: { goal: 'Pause test', agentId: 'agent' } },
          {
            id: step1Id,
            kind: 'agent',
            input: { goal: 'Second task', agentId: 'agent' },
            dependencies: [step0Id],
          },
        ],
      },
      'gateway',
    );

    // Claim and start step 0
    const claimed = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimed);
    assert.equal(claimed!.id, step0Id);

    // Pause the run
    const pausedRun = await kernel.pauseRun(runId, tenantId, 'user-1');
    assert.ok(pausedRun);
    assert.equal(pausedRun!.state, 'PAUSED');

    // Step 0 should be requeued (lease released)
    const step0 = await kernel.getStep(step0Id, tenantId);
    assert.equal(step0!.state, 'RETRY_WAIT', 'Step should be requeued on pause');

    // No steps should be claimable while paused
    const claimWhilePaused = await kernel.claimNextStep({
      workerId: 'w2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(claimWhilePaused, null, 'No steps claimable while run is paused');

    // Resume the run
    const resumedRun = await kernel.resumeRun(runId, tenantId, 'user-1');
    assert.ok(resumedRun);
    assert.equal(resumedRun!.state, 'RUNNING');

    // Step should be claimable again
    const claimAfterResume = await kernel.claimNextStep({
      workerId: 'w3',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimAfterResume, 'Step should be claimable after resume');
  });

  it('should support cancel with cleanup of in-flight steps', async () => {
    const runId = randomUUID();
    const stepId = randomUUID();

    await kernel.createRun(
      {
        id: runId,
        tenantId,
        intentHash: createHash('sha256').update(runId).digest('hex'),
        workGraphHash: createHash('sha256').update(runId).digest('hex'),
        workGraphVersion: 'v1',
        policySnapshotId: 'test-policy',
        steps: [{ id: stepId, kind: 'agent', input: { goal: 'Cancel test', agentId: 'agent' } }],
      },
      'gateway',
    );

    // Claim step
    const claimed = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimed);

    // Cancel the run
    const cancelledRun = await kernel.cancelRun(runId, tenantId, 'user-1');
    assert.ok(cancelledRun);
    assert.equal(cancelledRun!.state, 'CANCELLED');

    // Step should be CANCELLED
    const step = await kernel.getStep(stepId, tenantId);
    assert.equal(step!.state, 'CANCELLED');

    // No steps should be claimable
    const claimAfterCancel = await kernel.claimNextStep({
      workerId: 'w2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(claimAfterCancel, null);
  });
});
