/**
 * V2 Cross-Node Fencing Tests — Fencing token behavior across lease transfers.
 *
 * These tests prove the kernel's fencing token mechanism prevents zombie workers
 * from corrupting state after their lease has been transferred to a new worker:
 *
 *   1. Fencing epochs strictly increase across crash→reclaim cycles
 *   2. Zombie workers cannot complete, heartbeat, admit effects, or fail steps
 *      after their lease has been revoked
 *   3. Pause→resume cycles correctly bump fencing epochs
 *   4. Fencing epochs are tracked per-step, not per-run
 *   5. Concurrent claim races produce exactly one winner
 *   6. Stale version checks reject duplicate completions (complementary to fencing)
 *   7. Effect idempotency keys survive lease transfers (replay vs. conflict)
 *
 * These tests are CI-blocking architecture invariants: they prove the system
 * maintains exactly-once execution semantics even when workers crash mid-flight.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';

function createRunCommand(
  tenantId: string,
  steps: Array<{
    kind: string;
    input?: Record<string, unknown>;
    maxAttempts?: number;
    dependsOn?: number[];
  }>,
) {
  const runId = randomUUID();
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    input: s.input ?? { goal: `Execute ${s.kind}`, agentId: 'test-agent' },
    maxAttempts: s.maxAttempts ?? 3,
    dependencies: s.dependsOn?.map((idx) => `${runId}-step-${idx}`),
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

describe('V2 Cross-Node Fencing — Lease Transfer & Zombie Rejection', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-fencing';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  // ─── 1. Epoch strictly increases across 3 consecutive crash→reclaim cycles ───

  it('should strictly increase fencing epoch across 3 consecutive crash→reclaim cycles', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 5 }]);
    await kernel.createRun(command, 'gateway');
    const stepId = command.steps[0].id;

    // Cycle 1: Worker-1 claims → crash → reclaim
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1, 'Worker-1 should claim the step');
    const epoch1 = c1!.lease!.fencingEpoch;
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Cycle 2: Worker-2 claims → crash → reclaim
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2, 'Worker-2 should claim the requeued step');
    const epoch2 = c2!.lease!.fencingEpoch;
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Cycle 3: Worker-3 claims → crash → reclaim
    const c3 = await kernel.claimNextStep({
      workerId: 'worker-3',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c3, 'Worker-3 should claim the requeued step');
    const epoch3 = c3!.lease!.fencingEpoch;
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Each successive fencing epoch must be strictly greater than the previous
    assert.ok(epoch2 > epoch1, `Epoch 2 (${epoch2}) should be strictly > epoch 1 (${epoch1})`);
    assert.ok(epoch3 > epoch2, `Epoch 3 (${epoch3}) should be strictly > epoch 2 (${epoch2})`);

    // Step should still be in RETRY_WAIT after 3 cycles (attempt=3, maxAttempts=5)
    const step = await kernel.getStep(stepId, tenantId);
    assert.equal(
      step!.state,
      'RETRY_WAIT',
      'Step should still be RETRY_WAIT after 3 crash→reclaim cycles',
    );
    assert.equal(step!.attempt, 3, 'Step should be on attempt 3');
  });

  // ─── 2. Zombie worker cannot complete after 2nd reclaim (double fencing) ───

  it('should reject zombie worker completeStep after double reclaim (two stale leases)', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 5 }]);
    const run = await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    const lease1 = c1!.lease!;
    const version1 = c1!.version;

    // Crash → reclaim (1st reclaim)
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Worker-2 claims (gets new lease with higher epoch)
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2);
    const lease2 = c2!.lease!;
    const version2 = c2!.version;

    // Crash → reclaim (2nd reclaim)
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Zombie Worker-1 tries completeStep with original stale lease → null
    const zombie1 = await kernel.completeStep({
      stepId: c1!.id,
      tenantId: c1!.tenantId,
      lease: lease1,
      expectedVersion: version1,
      output: { status: 'zombie', summary: 'Worker-1 zombie write' },
      actor: 'worker-1',
    });
    assert.equal(zombie1, null, 'Zombie worker-1 must not complete after 1st reclaim');

    // Zombie Worker-2 tries completeStep with its now-stale lease → null
    const zombie2 = await kernel.completeStep({
      stepId: c2!.id,
      tenantId: c2!.tenantId,
      lease: lease2,
      expectedVersion: version2,
      output: { status: 'zombie', summary: 'Worker-2 zombie write' },
      actor: 'worker-2',
    });
    assert.equal(zombie2, null, 'Zombie worker-2 must not complete after 2nd reclaim');

    // Worker-3 claims and completes successfully with valid lease
    const c3 = await kernel.claimNextStep({
      workerId: 'worker-3',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c3, 'Worker-3 should claim the requeued step');
    assert.ok(
      c3!.lease!.fencingEpoch > lease2.fencingEpoch,
      'Worker-3 should have higher fencing epoch than worker-2',
    );

    const completed = await kernel.completeStep({
      stepId: c3!.id,
      tenantId: c3!.tenantId,
      lease: c3!.lease!,
      expectedVersion: c3!.version,
      output: { status: 'success', summary: 'Valid completion by worker-3' },
      actor: 'worker-3',
    });
    assert.ok(completed, 'Worker-3 should complete the step with a valid lease');

    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');
  });

  // ─── 3. Zombie worker cannot call heartbeatStep after lease expired ───

  it('should reject zombie worker heartbeatStep after lease expired', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(command, 'gateway');
    const stepId = command.steps[0].id;

    // Worker-1 claims with 50ms lease
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    const staleLease = c1!.lease!;

    // Wait for lease to expire, then reclaim
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Zombie Worker-1 tries heartbeatStep with stale lease → null
    const heartbeatResult = await kernel.heartbeatStep(stepId, tenantId, staleLease, 30_000);
    assert.equal(
      heartbeatResult,
      null,
      'Zombie worker must not be able to heartbeat step after lease expired',
    );

    // Worker-2 claims and heartbeatStep succeeds with valid lease
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2, 'Worker-2 should claim the requeued step');

    const heartbeat2 = await kernel.heartbeatStep(c2!.id, c2!.tenantId, c2!.lease!, 30_000);
    assert.ok(heartbeat2, 'Worker-2 heartbeatStep should succeed with a valid lease');
  });

  // ─── 4. Zombie worker cannot call admitEffect after lease expired ───

  it('should reject zombie worker admitEffect after lease expired', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    const run = await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    const staleLease = c1!.lease!;

    // Wait for lease to expire, then reclaim
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Worker-2 claims (gets new lease with higher epoch)
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2, 'Worker-2 should claim the requeued step');
    assert.ok(
      c2!.lease!.fencingEpoch > staleLease.fencingEpoch,
      'Worker-2 should have a higher fencing epoch than worker-1',
    );

    // Zombie Worker-1 tries admitEffect with stale lease → rejected with LEASE_LOST
    const result = await kernel.admitEffect({
      id: randomUUID(),
      runId: run.id,
      stepId: c1!.id,
      tenantId,
      type: 'notification',
      idempotencyKey: 'effect-stale',
      policyDecisionId: 'policy-1',
      request: { action: 'send_email', to: 'test@test.com' },
      lease: staleLease,
      actor: 'worker-1',
    });
    assert.equal(result.admitted, false, 'Zombie admitEffect should be rejected');
    if (!result.admitted) {
      assert.equal(result.reason, 'LEASE_LOST', 'Reject reason should be LEASE_LOST');
    }
  });

  // ─── 5. Zombie worker cannot call failStep after lease expired and new worker claimed ───

  it('should reject zombie worker failStep after lease expired and new worker claimed', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    const staleLease = c1!.lease!;
    const staleVersion = c1!.version;

    // Wait for lease to expire, then reclaim
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Worker-2 claims the step (new lease, higher epoch)
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2, 'Worker-2 should claim the requeued step');

    // Zombie Worker-1 tries failStep with stale lease → null
    const zombieFail = await kernel.failStep({
      stepId: c1!.id,
      tenantId: c1!.tenantId,
      lease: staleLease,
      expectedVersion: staleVersion,
      error: { code: 'ZOMBIE', message: 'Zombie fail attempt', retryable: true },
      actor: 'worker-1',
    });
    assert.equal(
      zombieFail,
      null,
      'Zombie worker must not be able to fail step after lease expired',
    );
  });

  // ─── 6. Pause→resume→zombie rejection ───

  it('should reject zombie worker after pause→resume→reclaim cycle', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 5 }]);
    const run = await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    const staleLease = c1!.lease!;
    const staleVersion = c1!.version;

    // Pause the run (releases lease, stores fencing epoch in lastFencingEpoch)
    const paused = await kernel.pauseRun(run.id, tenantId, 'user-1');
    assert.ok(paused);
    assert.equal(paused!.state, 'PAUSED');

    // Resume the run
    const resumed = await kernel.resumeRun(run.id, tenantId, 'user-1');
    assert.ok(resumed);
    assert.equal(resumed!.state, 'RUNNING');

    // Sleep 80ms (50ms lease has expired), reclaim (no-op since pause already released the lease)
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Worker-2 claims (gets new lease with higher fencing epoch)
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2, 'Worker-2 should claim the step after resume');
    assert.ok(
      c2!.lease!.fencingEpoch > staleLease.fencingEpoch,
      'Worker-2 should have a higher fencing epoch after pause→resume cycle',
    );

    // Zombie Worker-1 tries completeStep with pre-pause stale lease → null
    const zombieComplete = await kernel.completeStep({
      stepId: c1!.id,
      tenantId: c1!.tenantId,
      lease: staleLease,
      expectedVersion: staleVersion,
      output: { status: 'zombie', summary: 'Pre-pause zombie write' },
      actor: 'worker-1',
    });
    assert.equal(
      zombieComplete,
      null,
      'Zombie worker must not complete after pause→resume→reclaim',
    );
  });

  // ─── 7. Multiple steps in same run: fencing epoch is per-step, not per-run ───

  it('should track fencing epoch per-step, not per-run (independent step leases)', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'task-a', maxAttempts: 3 },
      { kind: 'task-b', maxAttempts: 3 },
      { kind: 'task-c', maxAttempts: 3 },
    ]);
    await kernel.createRun(command, 'gateway');

    // Worker-1 claims step-0 with 50ms lease (epoch=1)
    const c0 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c0);
    assert.equal(c0!.id, command.steps[0].id, 'Worker-1 should claim step-0');
    assert.equal(c0!.lease!.fencingEpoch, 1, 'Step-0 first claim should have fencing epoch 1');

    // Worker-2 claims step-1 with 30s lease (epoch=1, independent of step-0)
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    assert.equal(c1!.id, command.steps[1].id, 'Worker-2 should claim step-1');
    assert.equal(
      c1!.lease!.fencingEpoch,
      1,
      'Step-1 first claim should have fencing epoch 1 (per-step)',
    );

    // Claim step-2 as well so it does not interfere with the reclaim→reclaim cycle below
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2);
    assert.equal(c2!.id, command.steps[2].id, 'Worker-2 should claim step-2');

    // Sleep 80ms, reclaim — only step-0 should be reclaimed (step-1 and step-2 have 30s leases)
    await sleep(80);
    const reclaimed = await kernel.reclaimExpiredLeases(new Date(), 100);
    assert.equal(reclaimed.length, 1, 'Only step-0 should be reclaimed');
    assert.equal(reclaimed[0].id, command.steps[0].id, 'Reclaimed step should be step-0');

    // Worker-3 claims step-0 → gets fencingEpoch=2 (step-0 was previously claimed with epoch=1)
    const c0b = await kernel.claimNextStep({
      workerId: 'worker-3',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c0b, 'Worker-3 should claim the requeued step-0');
    assert.equal(c0b!.id, command.steps[0].id, 'Worker-3 should claim step-0');
    assert.equal(c0b!.lease!.fencingEpoch, 2, 'Step-0 re-claim should have fencing epoch 2');

    // Worker-2 still holds step-1 with fencingEpoch=1 (unaffected by step-0 reclaim)
    const step1State = await kernel.getStep(command.steps[1].id, tenantId);
    assert.equal(step1State!.state, 'RUNNING', 'Step-1 should still be RUNNING');
    assert.equal(
      step1State!.lease!.fencingEpoch,
      1,
      'Step-1 should still have fencing epoch 1 (per-step isolation)',
    );

    // Complete step-0 with worker-3's valid lease
    const completed0 = await kernel.completeStep({
      stepId: c0b!.id,
      tenantId: c0b!.tenantId,
      lease: c0b!.lease!,
      expectedVersion: c0b!.version,
      output: { status: 'success', summary: 'Step-0 completed by worker-3' },
      actor: 'worker-3',
    });
    assert.ok(completed0, 'Worker-3 should complete step-0');

    // Complete step-1 with worker-2's original valid lease
    const completed1 = await kernel.completeStep({
      stepId: c1!.id,
      tenantId: c1!.tenantId,
      lease: c1!.lease!,
      expectedVersion: c1!.version,
      output: { status: 'success', summary: 'Step-1 completed by worker-2' },
      actor: 'worker-2',
    });
    assert.ok(completed1, 'Worker-2 should complete step-1');
  });

  // ─── 8. Concurrent claim race: two workers call claimNextStep simultaneously ───

  it('should allow only one winner when two workers race to claim the same step', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(command, 'gateway');

    // Two workers race to claim the only available step
    const [claim1, claim2] = await Promise.all([
      kernel.claimNextStep({
        workerId: 'worker-a',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: [],
      }),
      kernel.claimNextStep({
        workerId: 'worker-b',
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: [],
      }),
    ]);

    // Exactly one should win, the other should get null
    const winners = [claim1, claim2].filter((c) => c !== null);
    assert.equal(winners.length, 1, 'Exactly one worker should win the concurrent claim race');
    assert.ok(claim1 === null || claim2 === null, 'At least one claim should be null');
  });

  // ─── 9. Stale version also rejected (version check complementary to fencing) ───

  it('should reject duplicate completeStep with stale version (version check, not fencing)', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(command, 'gateway');

    // Worker-1 claims → gets version N
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    const originalVersion = c1!.version;
    const lease = c1!.lease!;

    // Worker-1 completes successfully (step becomes SUCCEEDED, version increments to N+1, lease cleared)
    const completed = await kernel.completeStep({
      stepId: c1!.id,
      tenantId: c1!.tenantId,
      lease,
      expectedVersion: originalVersion,
      output: { status: 'success', summary: 'First completion' },
      actor: 'worker-1',
    });
    assert.ok(completed, 'First completion should succeed');

    // Worker-1 tries to complete AGAIN with the old version N → null
    // After completion, the step is SUCCEEDED with no lease and an incremented version,
    // so the version check, state check, and lease check all reject the duplicate.
    const duplicate = await kernel.completeStep({
      stepId: c1!.id,
      tenantId: c1!.tenantId,
      lease,
      expectedVersion: originalVersion,
      output: { status: 'success', summary: 'Duplicate completion attempt' },
      actor: 'worker-1',
    });
    assert.equal(duplicate, null, 'Duplicate completion with stale version must be rejected');
  });

  // ─── 10. Effect idempotency with fencing: same effect key replayed after lease transfer ───

  it('should reject zombie admitEffect but allow idempotent replay by new lease holder', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    const run = await kernel.createRun(command, 'gateway');

    // Worker-1 claims with 50ms lease
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    const lease1 = c1!.lease!;

    const effectRequest = { action: 'send_email', to: 'test@test.com' };

    // Worker-1 admits an effect with idempotencyKey 'effect-1' → admitted, not replayed
    const admitted1 = await kernel.admitEffect({
      id: randomUUID(),
      runId: run.id,
      stepId: c1!.id,
      tenantId,
      type: 'notification',
      idempotencyKey: 'effect-1',
      policyDecisionId: 'policy-1',
      request: effectRequest,
      lease: lease1,
      actor: 'worker-1',
    });
    assert.equal(admitted1.admitted, true, 'Worker-1 should admit the effect');
    if (admitted1.admitted) {
      assert.equal(admitted1.replayed, false, 'First admission should not be a replay');
    }

    // Sleep 80ms, reclaim (lease expires)
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Worker-2 claims (gets new lease)
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2, 'Worker-2 should claim the requeued step');

    // Zombie Worker-1 tries admitEffect with stale lease for same idempotencyKey → LEASE_LOST
    const zombieAdmit = await kernel.admitEffect({
      id: randomUUID(),
      runId: run.id,
      stepId: c1!.id,
      tenantId,
      type: 'notification',
      idempotencyKey: 'effect-1',
      policyDecisionId: 'policy-1',
      request: effectRequest,
      lease: lease1,
      actor: 'worker-1',
    });
    assert.equal(zombieAdmit.admitted, false, 'Zombie admitEffect should be rejected');
    if (!zombieAdmit.admitted) {
      assert.equal(zombieAdmit.reason, 'LEASE_LOST', 'Zombie reject reason should be LEASE_LOST');
    }

    // Worker-2 tries admitEffect with valid lease for same idempotencyKey → idempotent replay
    const replay = await kernel.admitEffect({
      id: randomUUID(),
      runId: run.id,
      stepId: c2!.id,
      tenantId,
      type: 'notification',
      idempotencyKey: 'effect-1',
      policyDecisionId: 'policy-1',
      request: effectRequest,
      lease: c2!.lease!,
      actor: 'worker-2',
    });
    assert.equal(replay.admitted, true, 'Worker-2 should successfully admit (replay) the effect');
    if (replay.admitted) {
      assert.equal(
        replay.replayed,
        true,
        'Second admission with same idempotencyKey should be an idempotent replay',
      );
    }
  });

  // ─── 11. Cross-worker lease handoff: worker A completes, worker B picks next step ───

  it('should support cross-worker handoff: worker A completes step-0, worker B picks step-1', async () => {
    const command = createRunCommand(tenantId, [
      { kind: 'agent', maxAttempts: 3 },
      { kind: 'agent', maxAttempts: 3, dependsOn: [0] },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    // Worker-A claims step-0 (epoch=1, first claim for this step)
    const step0 = await kernel.claimNextStep({
      workerId: 'worker-a',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(step0);
    assert.equal(step0!.id, command.steps[0].id, 'Worker-A should claim step-0');
    assert.equal(step0!.lease!.fencingEpoch, 1, 'Step-0 first claim should have fencing epoch 1');

    // Worker-A completes step-0
    const completed0 = await kernel.completeStep({
      stepId: step0!.id,
      tenantId: step0!.tenantId,
      lease: step0!.lease!,
      expectedVersion: step0!.version,
      output: { status: 'success', summary: 'Step-0 done by worker-A' },
      actor: 'worker-a',
    });
    assert.ok(completed0, 'Worker-A should complete step-0');

    // Worker-B claims step-1 (dependency on step-0 is now satisfied)
    const step1 = await kernel.claimNextStep({
      workerId: 'worker-b',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(step1);
    assert.equal(
      step1!.id,
      command.steps[1].id,
      'Worker-B should claim step-1 after dependency resolved',
    );
    assert.equal(
      step1!.lease!.fencingEpoch,
      1,
      'Step-1 first claim should also have fencing epoch 1 (per-step, not per-run)',
    );

    // Worker-B completes step-1
    const completed1 = await kernel.completeStep({
      stepId: step1!.id,
      tenantId: step1!.tenantId,
      lease: step1!.lease!,
      expectedVersion: step1!.version,
      output: { status: 'success', summary: 'Step-1 done by worker-B' },
      actor: 'worker-b',
    });
    assert.ok(completed1, 'Worker-B should complete step-1');

    // Run should be SUCCEEDED (all steps completed)
    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');
  });

  // ─── 12. Fencing epoch never resets to 0 after multiple operations on same step ───

  it('should never reset fencing epoch to 0 after multiple claim/reclaim cycles (verified via events)', async () => {
    const command = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 5 }]);
    const run = await kernel.createRun(command, 'gateway');

    // Cycle 1: Worker-1 claims (epoch=1), crash, reclaim
    const c1 = await kernel.claimNextStep({
      workerId: 'worker-1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c1);
    assert.equal(c1!.lease!.fencingEpoch, 1, 'First claim should have fencing epoch 1');
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Cycle 2: Worker-2 claims (epoch=2), crash, reclaim
    const c2 = await kernel.claimNextStep({
      workerId: 'worker-2',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2);
    assert.equal(c2!.lease!.fencingEpoch, 2, 'Second claim should have fencing epoch 2');
    await sleep(80);
    await kernel.reclaimExpiredLeases(new Date(), 100);

    // Cycle 3: Worker-3 claims (epoch=3) and completes successfully
    const c3 = await kernel.claimNextStep({
      workerId: 'worker-3',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c3);
    assert.equal(c3!.lease!.fencingEpoch, 3, 'Third claim should have fencing epoch 3');

    const completed = await kernel.completeStep({
      stepId: c3!.id,
      tenantId: c3!.tenantId,
      lease: c3!.lease!,
      expectedVersion: c3!.version,
      output: { status: 'success', summary: 'Completed after 3 cycles' },
      actor: 'worker-3',
    });
    assert.ok(completed, 'Worker-3 should complete the step with fencing epoch 3');

    // Verify via events: step.claimed events should record strictly increasing fencingEpoch
    const events = await kernel.listEvents(run.id, tenantId);
    const claimedEvents = events.filter((e) => e.type === 'step.claimed');
    assert.equal(claimedEvents.length, 3, 'Should have exactly 3 step.claimed events');

    const epochs = claimedEvents.map((e) => e.payload.fencingEpoch as number);
    assert.deepEqual(
      epochs,
      [1, 2, 3],
      'Fencing epochs in step.claimed events should be [1, 2, 3]',
    );
    assert.ok(
      epochs.every((e) => e > 0),
      'No fencing epoch should ever be 0 — epoch must always start at 1 and monotonically increase',
    );
  });
});
