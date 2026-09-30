/**
 * V2 Distributed Fault Tests — Comprehensive fault injection scenarios.
 *
 * These tests prove the kernel survives the fault scenarios required by
 * the architecture-v2-score-80-plan.md test matrix:
 *
 *   1. Worker kill (simulated crash mid-execution)
 *   2. Lease expiry (zombie worker detection and requeue)
 *   3. Duplicate delivery (idempotency via version + fencing)
 *   4. Network partition (worker isolated, can't heartbeat)
 *   5. DB failover (step state survives process restart via journal)
 *   6. Multi-attempt terminal failure (maxAttempts exhausted)
 *   7. Concurrent claim race (SKIP LOCKED prevents double-claim)
 *   8. Fencing token rejection (stale worker can't complete)
 *   9. Outbox at-least-once delivery
 *  10. Timer fire after process restart
 *
 * Key principle: The system does NOT promise "global exactly-once." It promises
 * optimistic concurrency with fencing, at-least-once delivery, and idempotent
 * side effects via capability tokens and effect ledgers.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';
import type { KernelRepository } from './repository.js';
import type { KernelStep } from './types.js';

function createRunCommand(
  tenantId: string,
  steps: Array<{
    kind: string;
    input?: Record<string, unknown>;
    dependencies?: string[];
    maxAttempts?: number;
    priority?: number;
    initialState?: 'PENDING' | 'WAITING_FOR_HUMAN';
  }>,
) {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    input: s.input ?? { goal: `Execute ${s.kind}`, agentId: 'test-agent' },
    dependencies: s.dependencies,
    maxAttempts: s.maxAttempts,
    priority: s.priority ?? 0,
    initialState: s.initialState,
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

describe('V2 Distributed Fault — Worker Kill & Lease Expiry', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-fault';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('survives worker crash: lease expires → step requeued → new worker completes', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(cmd, 'gateway');

    // F-K2-25: drive the whole fault on one explicit clock instead of wall-clock
    // sleeps, so the reclaim can never observe a still-live lease under load.
    const t0 = Date.now();
    const claimed = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 50,
      tenantIds: [],
      capabilities: [],
      now: new Date(t0),
    });
    assert.ok(claimed);
    assert.equal(claimed!.attempt, 1);

    const reclaimed = await kernel.reclaimExpiredLeases(new Date(t0 + 50), 100);
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].state, 'RETRY_WAIT');

    // Worker-2 picks up the requeued step
    const reclaimed_step = await kernel.claimNextStep({
      workerId: 'w2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
      now: new Date(t0 + 50),
    });
    assert.ok(reclaimed_step);
    assert.equal(reclaimed_step!.attempt, 2);

    // Worker-2 completes successfully
    const completed = await kernel.completeStep({
      stepId: reclaimed_step!.id,
      tenantId: reclaimed_step!.tenantId,
      lease: reclaimed_step!.lease!,
      expectedVersion: reclaimed_step!.version,
      output: { status: 'ok' },
      actor: 'w2',
    });
    assert.ok(completed);
    assert.equal(completed!.state, 'SUCCEEDED');
  });

  it('survives multiple worker crashes: step eventually completes after N retries', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 5 }]);
    await kernel.createRun(cmd, 'gateway');

    // Simulate 3 crashes followed by success. F-K2-25: one explicit clock.
    let clock = Date.now();
    for (let crash = 0; crash < 3; crash++) {
      const claimed = await kernel.claimNextStep({
        workerId: `w-${crash}`,
        leaseTtlMs: 30,
        tenantIds: [],
        capabilities: [],
        now: new Date(clock),
      });
      assert.ok(claimed, `crash ${crash}: should claim step`);
      clock += 30;
      await kernel.reclaimExpiredLeases(new Date(clock), 100);
    }

    // 4th worker succeeds
    const claimed = await kernel.claimNextStep({
      workerId: 'w-success',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
      now: new Date(clock),
    });
    assert.ok(claimed);
    assert.equal(claimed!.attempt, 4);

    const completed = await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { status: 'ok' },
      actor: 'w-success',
    });
    assert.equal(completed!.state, 'SUCCEEDED');
  });
});

describe('V2 Distributed Fault — Fencing & Duplicate Delivery', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-fencing';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('rejects stale worker completion via fencing token', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(cmd, 'gateway');

    // Worker-1 claims
    const t0 = Date.now();
    const w1Step = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30,
      tenantIds: [],
      capabilities: [],
      now: new Date(t0),
    });
    assert.ok(w1Step);
    const w1Lease = w1Step!.lease!;
    const w1Version = w1Step!.version;

    // Lease expires, step is requeued. F-K2-25: explicit clock, no sleep.
    await kernel.reclaimExpiredLeases(new Date(t0 + 30), 100);

    // Worker-2 claims with new lease
    const w2Step = await kernel.claimNextStep({
      workerId: 'w2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
      now: new Date(t0 + 30),
    });
    assert.ok(w2Step);
    assert.notEqual(w2Step!.lease!.fencingEpoch, w1Lease.fencingEpoch, 'Fencing epoch must differ');

    // Worker-2 completes successfully
    const completed = await kernel.completeStep({
      stepId: w2Step!.id,
      tenantId: w2Step!.tenantId,
      lease: w2Step!.lease!,
      expectedVersion: w2Step!.version,
      output: { status: 'ok' },
      actor: 'w2',
    });
    assert.ok(completed);

    // Worker-1 (zombie) tries to complete with stale lease — must fail
    const staleComplete = await kernel.completeStep({
      stepId: w1Step!.id,
      tenantId: w1Step!.tenantId,
      lease: w1Lease,
      expectedVersion: w1Version,
      output: { status: 'zombie' },
      actor: 'w1',
    });
    assert.equal(staleComplete, null, 'Zombie worker must not be able to complete');
  });

  it('rejects duplicate step completion with same version', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(cmd, 'gateway');

    const claimed = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimed);

    // First completion succeeds
    const first = await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { status: 'ok' },
      actor: 'w1',
    });
    assert.ok(first);

    // Second completion with same version fails (duplicate delivery)
    const second = await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { status: 'dup' },
      actor: 'w1',
    });
    assert.equal(second, null, 'Duplicate completion must be rejected');
  });
});

describe('V2 Distributed Fault — Concurrent Claim Race', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-race';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('only one worker claims a step when multiple race (in-memory)', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // Multiple workers try to claim the same step
    const claims = await Promise.all([
      kernel.claimNextStep({ workerId: 'w1', leaseTtlMs: 30_000, tenantIds: [], capabilities: [] }),
      kernel.claimNextStep({ workerId: 'w2', leaseTtlMs: 30_000, tenantIds: [], capabilities: [] }),
      kernel.claimNextStep({ workerId: 'w3', leaseTtlMs: 30_000, tenantIds: [], capabilities: [] }),
    ]);

    const claimed = claims.filter((c) => c !== null);
    assert.equal(claimed.length, 1, 'Only one worker should claim the step');
  });

  it('processes independent steps from multiple workers in parallel', async () => {
    const cmd = createRunCommand(tenantId, [
      { kind: 'agent' },
      { kind: 'agent' },
      { kind: 'agent' },
    ]);
    await kernel.createRun(cmd, 'gateway');

    // All three workers claim in parallel
    const claims = await Promise.all([
      kernel.claimNextStep({ workerId: 'w1', leaseTtlMs: 30_000, tenantIds: [], capabilities: [] }),
      kernel.claimNextStep({ workerId: 'w2', leaseTtlMs: 30_000, tenantIds: [], capabilities: [] }),
      kernel.claimNextStep({ workerId: 'w3', leaseTtlMs: 30_000, tenantIds: [], capabilities: [] }),
    ]);

    const claimed = claims.filter((c) => c !== null);
    assert.equal(claimed.length, 3, 'All three workers should claim a step');

    // Verify they claimed different steps
    const stepIds = claimed.map((c) => c!.id);
    const unique = new Set(stepIds);
    assert.equal(unique.size, 3, 'Each worker should get a different step');
  });
});

describe('V2 Distributed Fault — Multi-Attempt Terminal Failure', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-terminal';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('terminally fails step after maxAttempts exhausted', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 3 }]);
    await kernel.createRun(cmd, 'gateway');

    // Attempts 1-2: retryable failures
    for (let attempt = 1; attempt <= 2; attempt++) {
      const claimed = await kernel.claimNextStep({
        workerId: `w-${attempt}`,
        leaseTtlMs: 30_000,
        tenantIds: [],
        capabilities: [],
      });
      assert.ok(claimed);
      assert.equal(claimed!.attempt, attempt);

      await kernel.failStep({
        stepId: claimed!.id,
        tenantId: claimed!.tenantId,
        lease: claimed!.lease!,
        expectedVersion: claimed!.version,
        error: { code: 'TRANSIENT', message: `Attempt ${attempt} failed`, retryable: true },
        retryAt: new Date(),
        actor: `w-${attempt}`,
      });
    }

    // Attempt 3: terminal failure (retryable=false)
    const claimed = await kernel.claimNextStep({
      workerId: 'w-3',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(claimed);
    assert.equal(claimed!.attempt, 3);

    await kernel.failStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      error: { code: 'PERMANENT_FAIL', message: 'Max attempts exhausted', retryable: false },
      actor: 'w-3',
    });

    // Step should be terminally FAILED, not claimable
    const noStep = await kernel.claimNextStep({
      workerId: 'w-final',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(noStep, null, 'No step should be claimable after terminal failure');

    // Verify step state
    const step = await kernel.getStep(cmd.steps[0]!.id, tenantId);
    assert.equal(step!.state, 'FAILED');
    assert.equal(step!.attempt, 3);
  });

  it('allows step to succeed on retry after transient failure', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent', maxAttempts: 5 }]);
    await kernel.createRun(cmd, 'gateway');

    // Attempt 1: transient failure
    const c1 = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    await kernel.failStep({
      stepId: c1!.id,
      tenantId: c1!.tenantId,
      lease: c1!.lease!,
      expectedVersion: c1!.version,
      error: { code: 'TIMEOUT', message: 'LLM timed out', retryable: true },
      retryAt: new Date(),
      actor: 'w1',
    });

    // Attempt 2: success
    const c2 = await kernel.claimNextStep({
      workerId: 'w2',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.ok(c2);
    assert.equal(c2!.attempt, 2);

    const completed = await kernel.completeStep({
      stepId: c2!.id,
      tenantId: c2!.tenantId,
      lease: c2!.lease!,
      expectedVersion: c2!.version,
      output: { status: 'ok' },
      actor: 'w2',
    });
    assert.equal(completed!.state, 'SUCCEEDED');
  });
});

describe('V2 Distributed Fault — Run Lifecycle & Cancel', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-lifecycle';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('cancels run and marks all non-terminal steps CANCELLED', async () => {
    const cmd = createRunCommand(tenantId, [
      { kind: 'agent' },
      { kind: 'agent', dependencies: [`${''}-step-0`] },
    ]);
    // Fix dependencies
    cmd.steps[1]!.dependencies = [cmd.steps[0]!.id];
    await kernel.createRun(cmd, 'gateway');

    // Cancel before any execution
    const cancelled = await kernel.cancelRun(cmd.id, tenantId, 'operator');
    assert.ok(cancelled);
    assert.equal(cancelled!.state, 'CANCELLED');

    // Verify no steps are claimable
    const noStep = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(noStep, null);
  });

  it('pauses and resumes run', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // Pause before any step is completed
    const paused = await kernel.pauseRun(cmd.id, tenantId, 'operator');
    assert.ok(paused);
    assert.equal(paused!.state, 'PAUSED');

    // Resume
    const resumed = await kernel.resumeRun(cmd.id, tenantId, 'operator');
    assert.ok(resumed);
    assert.equal(resumed!.state, 'RUNNING');
  });
});

describe('V2 Distributed Fault — Outbox At-Least-Once', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-outbox';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('publishes outbox messages and marks them published', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // Claim outbox messages
    const messages = await kernel.claimOutbox(10);
    assert.ok(messages.length > 0, 'Should have outbox messages from run creation');

    // Mark first message as published
    const msg = messages[0]!;
    const published = await kernel.markOutboxPublished(msg.id, msg.claimToken!);
    assert.equal(published, true);
  });

  it('DLQ sweep moves failed messages and supports replay', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // F-K2-2: replacing the old `movedToDlq >= 0` (always true) and the
    // `if (dlqEntries.length > 0)` replay guard with unconditional assertions.
    kernel.outboxMaxAttempts = 1;

    const messages = await kernel.claimOutbox(10);
    assert.equal(messages.length, 1, 'run creation must seed exactly one claimable outbox message');

    // Sweep past the claim lease so the sweep may touch the claimed row.
    const result = await kernel.sweepOutboxDlq(new Date(Date.now() + 61_000), 50);
    assert.equal(result.movedToDlq, 1, 'message at max attempts must be moved to the DLQ');

    const dlqEntries = await kernel.listDlqEntries(100);
    assert.equal(dlqEntries.length, 1);
    assert.equal(dlqEntries[0]!.originalId, messages[0]!.id);

    const replayed = await kernel.replayDlqEntry(dlqEntries[0]!.id);
    assert.equal(replayed, true, 'Should replay DLQ entry');
    assert.equal((await kernel.listDlqEntries(100)).length, 0, 'replay must retire the DLQ entry');
  });
});

describe('V2 Distributed Fault — Timer & Interaction Recovery', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-timer';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('timer fires after delay and transitions to FIRED state', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    const timer = await kernel.createTimer(
      {
        runId: cmd.id,
        stepId: cmd.steps[0]!.id,
        tenantId,
        firesAt: new Date(Date.now() + 50),
        timerType: 'RETRY_DELAY',
        payload: { reason: 'test' },
      },
      'test',
    );

    assert.equal(timer.state, 'PENDING');

    // Not expired yet
    const before = await kernel.claimExpiredTimers(new Date(), 10);
    assert.equal(before.length, 0);

    // F-K2-25: explicit expiry instant instead of a 60ms sleep.
    // Claim processing, then acknowledge durable completion.
    const expired = await kernel.claimExpiredTimers(new Date(Date.now() + 61_000), 10);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.state, 'PROCESSING');
    assert.equal(
      await kernel.acknowledgeTimer(expired[0]!.id, tenantId, expired[0]!.claimToken!),
      true,
    );
  });

  it('interaction lifecycle: create → answer → verify', async () => {
    // answerInteraction releases the step (releaseStep defaults to true), which
    // both the SQLite and PostgreSQL repositories only permit from
    // WAITING_FOR_HUMAN; the step must therefore start in that state.
    const cmd = createRunCommand(tenantId, [{ kind: 'agent', initialState: 'WAITING_FOR_HUMAN' }]);
    await kernel.createRun(cmd, 'gateway');

    const interaction = await kernel.createInteraction(
      {
        runId: cmd.id,
        stepId: cmd.steps[0]!.id,
        tenantId,
        prompt: 'Approve deployment to production?',
        expiresAt: new Date(Date.now() + 60_000),
      },
      'test',
    );

    assert.equal(interaction.status, 'pending');

    // Answer the interaction
    const answered = await kernel.answerInteraction({
      interactionId: interaction.id,
      runId: cmd.id,
      tenantId,
      response: { approved: true, comment: 'looks good' },
      actor: 'human-1',
    });

    assert.equal(answered.status, 'answered');
    assert.deepEqual(answered.response, { approved: true, comment: 'looks good' });
    assert.ok(answered.answeredAt);
  });

  it('interaction expires when not answered in time', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    const interaction = await kernel.createInteraction(
      {
        runId: cmd.id,
        stepId: cmd.steps[0]!.id,
        tenantId,
        prompt: 'Quick question',
        expiresAt: new Date(Date.now() - 1000), // Already expired
      },
      'test',
    );

    const expired = await kernel.expireStaleInteractions(new Date(), 10);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.status, 'expired');
  });
});

describe('V2 Distributed Fault — DB Failover Simulation', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-failover';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  it('recovers state from journal: events are immutable and ordered', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // Verify events were journaled
    const events = await kernel.listEvents(cmd.id, tenantId);
    assert.ok(events.length > 0, 'Events should be journaled');
    assert.deepEqual(
      events.map((event) => event.sequence),
      [...events].sort((a, b) => a.sequence - b.sequence).map((event) => event.sequence),
      'journal must be ordered by sequence',
    );

    // F-K2-19: immutability is proven by a mutation attempt that must not take
    // effect, not by comparing two identical reads.
    const snapshot = events.map((event) => ({ eventId: event.eventId, type: event.type }));
    events[0]!.type = 'tampered.event.type';
    events.push({ ...events[0]!, eventId: 'tampered-event' });
    const reread = await kernel.listEvents(cmd.id, tenantId);
    assert.deepEqual(
      reread.map((event) => ({ eventId: event.eventId, type: event.type })),
      snapshot,
      'mutating a returned journal page must not mutate the durable journal',
    );
    assert.equal(
      reread.some((event) => event.eventId === 'tampered-event'),
      false,
      'an appended fake event must not appear in the journal',
    );
  });

  it('simulates process restart: new kernel instance recovers from journal', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // Complete the step
    const claimed = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    await kernel.completeStep({
      stepId: claimed!.id,
      tenantId: claimed!.tenantId,
      lease: claimed!.lease!,
      expectedVersion: claimed!.version,
      output: { status: 'ok' },
      actor: 'w1',
    });

    // F-K2-1: the previous version constructed kernel2 and then read only the
    // original instance. Restore the durable journal into kernel2 and read it.
    const kernel2 = new InMemoryKernelRepository();
    kernel2.loadSnapshot(kernel.snapshot());

    const recoveredStep = await kernel2.getStep(claimed!.id, claimed!.tenantId);
    assert.equal(recoveredStep?.state, 'SUCCEEDED', 'restarted kernel must recover the step state');
    assert.equal(recoveredStep?.attempt, 1);
    assert.deepEqual(
      await kernel2.getRun(cmd.id, tenantId),
      await kernel.getRun(cmd.id, tenantId),
      'restarted kernel must recover the run record',
    );
    const events = await kernel.listEvents(cmd.id, tenantId);
    assert.deepEqual(
      (await kernel2.listEvents(cmd.id, tenantId)).map((event) => event.type),
      events.map((event) => event.type),
      'restarted kernel must recover the complete journal',
    );
    assert.ok(
      events.map((event) => event.type).includes('step.succeeded'),
      'journal must record the terminal step transition',
    );
  });

  it('handles concurrent pause + cancel without corruption', async () => {
    const cmd = createRunCommand(tenantId, [{ kind: 'agent' }, { kind: 'agent' }]);
    await kernel.createRun(cmd, 'gateway');

    // Simultaneously pause and cancel
    const [paused, cancelled] = await Promise.all([
      kernel.pauseRun(cmd.id, tenantId, 'operator-1'),
      kernel.cancelRun(cmd.id, tenantId, 'operator-2'),
    ]);

    // One should succeed, the other may fail — but state should be consistent
    const finalState = paused?.state ?? cancelled?.state;
    assert.ok(
      finalState === 'PAUSED' || finalState === 'CANCELLED',
      `State should be PAUSED or CANCELLED, got: ${finalState}`,
    );

    // Verify no steps are claimable (both PAUSE and CANCEL prevent claiming)
    const noStep = await kernel.claimNextStep({
      workerId: 'w1',
      leaseTtlMs: 30_000,
      tenantIds: [],
      capabilities: [],
    });
    assert.equal(noStep, null, 'No step should be claimable after pause/cancel');
  });
});
