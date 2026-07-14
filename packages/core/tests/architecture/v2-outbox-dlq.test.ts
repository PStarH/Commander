/**
 * V2 Outbox DLQ + Replay Cycle Tests — Architecture V2 integration.
 *
 * These tests prove the transactional outbox publish / retry / DLQ / replay
 * lifecycle works end-to-end using the test-only InMemoryKernelRepository:
 *
 *   1. Outbox claim + publish + ack happy path
 *   2. Outbox retry on publish failure (attempts increment)
 *   3. DLQ sweep after max attempts exceeded
 *   4. DLQ replay re-inserts into outbox with attempts reset
 *   5. Wrong claim token rejection
 *   6. Cross-tenant outbox isolation
 *
 * Uses InMemoryKernelRepository (test-only) to avoid Postgres dependency.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

// Kernel imports (test-only in-memory repository)
import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import type { KernelOutboxMessage, KernelDlqEntry, KernelStep } from '../../../kernel/src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a valid CreateKernelRun command with the given steps. */
function createRunCommand(
  tenantId: string,
  steps: Array<{ kind: string; input?: Record<string, unknown> }>,
) {
  const runId = randomUUID();
  const stepDefs = steps.map((s, i) => ({
    id: `${runId}-step-${i}`,
    kind: s.kind,
    input: s.input ?? { goal: `Execute ${s.kind}`, agentId: 'test-agent' },
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

/**
 * Claim and complete a single step, producing lifecycle outbox messages
 * (step.claimed, step.succeeded, run.succeeded).
 */
async function claimAndComplete(
  kernel: InMemoryKernelRepository,
  workerId: string,
  tenantId: string,
): Promise<KernelStep | null> {
  const claimed = await kernel.claimNextStep({
    workerId,
    leaseTtlMs: 30_000,
    tenantIds: [tenantId],
    capabilities: [],
  });
  if (!claimed) return null;
  await kernel.completeStep({
    stepId: claimed.id,
    tenantId: claimed.tenantId,
    lease: claimed.lease!,
    expectedVersion: claimed.version,
    output: { status: 'success' },
    actor: workerId,
  });
  return claimed;
}

/** Claim all available outbox messages and mark each as published. */
async function claimAndPublishAll(
  kernel: InMemoryKernelRepository,
  at?: Date,
  tenantId?: string,
): Promise<{ claimed: KernelOutboxMessage[]; published: number }> {
  const claimed = await kernel.claimOutbox(100, at, tenantId);
  let published = 0;
  for (const msg of claimed) {
    const ok = await kernel.markOutboxPublished(msg.id, msg.claimToken!);
    if (ok) published++;
  }
  return { claimed, published };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('V2 Outbox DLQ + Replay Cycle', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-test';
  const workerId = 'worker-1';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────────

  it('should claim, publish, and ack outbox messages on the happy path', async () => {
    // 1. Create a run — produces a run.created outbox message.
    const command = createRunCommand(tenantId, [
      { kind: 'agent', input: { goal: 'Say hello', agentId: 'greeter' } },
    ]);
    const run = await kernel.createRun(command, 'gateway');

    // 2. Execute the step — produces step.claimed, step.succeeded, run.succeeded.
    const step = await claimAndComplete(kernel, workerId, tenantId);
    assert.ok(step, 'Should have claimed and completed a step');

    // 3. Claim all outbox messages.
    const { claimed, published } = await claimAndPublishAll(kernel);
    assert.ok(claimed.length >= 1, 'Should have claimed at least one outbox message');
    assert.equal(published, claimed.length, 'Every claimed message should be marked published');

    // 4. Verify the outbox is now empty (no claimable messages remain).
    const remaining = await kernel.claimOutbox(100);
    assert.equal(remaining.length, 0, 'Outbox should be empty after all messages are published');

    // Sanity: the run reached SUCCEEDED.
    const finalRun = await kernel.getRun(run.id, tenantId);
    assert.equal(finalRun!.state, 'SUCCEEDED');
  });

  // ── 2. Retry on publish failure ────────────────────────────────────────────

  it('should increment attempts when a claimed message is re-claimed after publish failure', async () => {
    // Create a run — produces a single outbox message (run.created).
    await kernel.createRun(createRunCommand(tenantId, [{ kind: 'agent' }]), 'gateway');

    // First claim — simulate a publish failure by NOT marking published.
    const claimed1 = await kernel.claimOutbox(100);
    assert.ok(claimed1.length > 0, 'Should claim an outbox message');
    const msg1 = claimed1[0]!;
    assert.equal(msg1.attempts, 1, 'First claim should set attempts to 1');
    assert.ok(msg1.claimToken, 'Claimed message should carry a claim token');

    // The claim lease is 60 s; advance simulated time past expiry so the
    // message becomes re-claimable.
    const afterExpiry = new Date(Date.now() + 61_000);
    const claimed2 = await kernel.claimOutbox(100, afterExpiry);
    assert.ok(claimed2.length > 0, 'Should re-claim the message after claim expiry');

    const msg2 = claimed2.find((m) => m.id === msg1.id);
    assert.ok(msg2, 'The same message should be re-claimed');
    assert.equal(msg2!.attempts, 2, 'Second claim should increment attempts to 2');
    assert.notEqual(
      msg2!.claimToken,
      msg1.claimToken,
      'A new claim token should be issued on re-claim',
    );
  });

  // ── 3. DLQ sweep after max attempts ────────────────────────────────────────

  it('should move outbox messages to DLQ after exceeding max attempts', async () => {
    // Configure a low max-attempts threshold.
    kernel.outboxMaxAttempts = 3;

    await kernel.createRun(createRunCommand(tenantId, [{ kind: 'agent' }]), 'gateway');

    // Claim repeatedly without marking published, advancing simulated time
    // past the 60 s claim lease each iteration so the message is re-claimable.
    const start = Date.now();
    let clock = start;
    for (let i = 0; i < kernel.outboxMaxAttempts; i++) {
      const claimed = await kernel.claimOutbox(100, new Date(clock));
      assert.ok(claimed.length > 0, `Claim ${i + 1} should return the message`);
      assert.equal(claimed[0]!.attempts, i + 1, `Attempt ${i + 1} should have attempts = ${i + 1}`);
      clock += 61_000; // past claim lease expiry
    }

    // Sweep — the message has attempts === maxAttempts, so it should be moved.
    const result = await kernel.sweepOutboxDlq(new Date(clock));
    assert.equal(result.movedToDlq, 1, 'Should have moved 1 message to DLQ');

    // Verify the DLQ entry.
    const dlqEntries = await kernel.listDlqEntries();
    assert.equal(dlqEntries.length, 1, 'Should have exactly 1 DLQ entry');
    const entry = dlqEntries[0]!;
    assert.equal(entry.dlqReason, 'max_attempts_exceeded');
    assert.equal(entry.attempts, kernel.outboxMaxAttempts);
    assert.ok(entry.originalCreatedAt, 'DLQ entry should record original creation time');
    assert.ok(entry.movedToDlqAt, 'DLQ entry should record move timestamp');

    // The message should no longer be claimable.
    const remaining = await kernel.claimOutbox(100, new Date(clock));
    assert.equal(remaining.length, 0, 'Swept message should no longer be claimable');
  });

  // ── 4. DLQ replay ──────────────────────────────────────────────────────────

  it('should replay a DLQ entry back into the outbox with attempts reset to 0', async () => {
    kernel.outboxMaxAttempts = 2;

    await kernel.createRun(createRunCommand(tenantId, [{ kind: 'agent' }]), 'gateway');

    // Exhaust attempts to drive the message into the DLQ.
    const start = Date.now();
    let clock = start;
    for (let i = 0; i < kernel.outboxMaxAttempts; i++) {
      await kernel.claimOutbox(100, new Date(clock));
      clock += 61_000;
    }
    const sweepResult = await kernel.sweepOutboxDlq(new Date(clock));
    assert.equal(sweepResult.movedToDlq, 1, 'Message should be in DLQ before replay');

    const dlqEntries = await kernel.listDlqEntries();
    assert.equal(dlqEntries.length, 1);
    const dlqId = dlqEntries[0]!.id;

    // Replay the DLQ entry.
    const replayed = await kernel.replayDlqEntry(dlqId);
    assert.equal(replayed, true, 'replayDlqEntry should return true for an existing entry');

    // The DLQ should now be empty.
    const dlqAfterReplay = await kernel.listDlqEntries();
    assert.equal(dlqAfterReplay.length, 0, 'DLQ should be empty after replay');

    // The replayed message should be claimable from the outbox with attempts
    // reset to 0 (incremented to 1 by the claim itself).
    const claimed = await kernel.claimOutbox(100, new Date(clock));
    assert.ok(claimed.length > 0, 'Should claim the replayed message');
    assert.equal(
      claimed[0]!.attempts,
      1,
      'Replayed message should have attempts = 1 after claim (was 0 before claim)',
    );

    // Publish the replayed message successfully.
    const published = await kernel.markOutboxPublished(claimed[0]!.id, claimed[0]!.claimToken!);
    assert.equal(published, true, 'Should mark the replayed message as published');

    // Outbox should be empty.
    const remaining = await kernel.claimOutbox(100, new Date(clock));
    assert.equal(remaining.length, 0, 'Outbox should be empty after publishing replayed message');
  });

  // ── 5. Wrong claim token rejection ─────────────────────────────────────────

  it('should reject markOutboxPublished with a wrong claim token', async () => {
    await kernel.createRun(createRunCommand(tenantId, [{ kind: 'agent' }]), 'gateway');

    const claimed = await kernel.claimOutbox(100);
    assert.ok(claimed.length > 0);
    const msg = claimed[0]!;
    assert.ok(msg.claimToken, 'Claimed message should have a claim token');

    // Try to ack with a fabricated token.
    const wrongToken = randomUUID();
    assert.notEqual(wrongToken, msg.claimToken, 'Wrong token should differ from the real token');
    const result = await kernel.markOutboxPublished(msg.id, wrongToken);
    assert.equal(result, false, 'Should reject a wrong claim token');

    // The message should still be claimable after the failed ack. Advance time
    // past the claim lease to make it re-claimable.
    const afterExpiry = new Date(Date.now() + 61_000);
    const reClaimed = await kernel.claimOutbox(100, afterExpiry);
    const sameMsg = reClaimed.find((m) => m.id === msg.id);
    assert.ok(sameMsg, 'Message should still be claimable after wrong-token rejection');
    assert.equal(sameMsg!.attempts, 2, 'Re-claim after failed ack should increment attempts');
  });

  // ── 6. Cross-tenant outbox isolation ───────────────────────────────────────

  it('should isolate outbox claims by tenant when a tenant filter is provided', async () => {
    const tenantA = 'tenant-A';
    const tenantB = 'tenant-B';

    // Create a run for each tenant — each produces one outbox message.
    await kernel.createRun(createRunCommand(tenantA, [{ kind: 'agent' }]), 'gateway');
    await kernel.createRun(createRunCommand(tenantB, [{ kind: 'agent' }]), 'gateway');

    // Claim outbox scoped to tenant-A only.
    const claimedA = await kernel.claimOutbox(100, undefined, tenantA);
    assert.ok(claimedA.length > 0, 'Should claim tenant-A outbox messages');
    for (const msg of claimedA) {
      assert.equal(
        msg.payload.tenantId,
        tenantA,
        'Every claimed message should belong to tenant-A',
      );
    }
    assert.ok(
      !claimedA.some((m) => m.payload.tenantId === tenantB),
      'No tenant-B messages should be claimed when filtering for tenant-A',
    );

    // Claim outbox scoped to tenant-B only.
    const claimedB = await kernel.claimOutbox(100, undefined, tenantB);
    assert.ok(claimedB.length > 0, 'Should claim tenant-B outbox messages');
    for (const msg of claimedB) {
      assert.equal(
        msg.payload.tenantId,
        tenantB,
        'Every claimed message should belong to tenant-B',
      );
    }
    assert.ok(
      !claimedB.some((m) => m.payload.tenantId === tenantA),
      'No tenant-A messages should be claimed when filtering for tenant-B',
    );

    // The two claim sets should be disjoint.
    const idsA = new Set(claimedA.map((m) => m.id));
    assert.ok(
      !claimedB.some((m) => idsA.has(m.id)),
      'Tenant-A and tenant-B claim sets should be disjoint',
    );
  });
});
