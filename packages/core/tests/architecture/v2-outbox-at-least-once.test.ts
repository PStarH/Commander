/**
 * V2 Outbox At-Least-Once Delivery Tests
 *
 * Verifies the transactional outbox at-least-once delivery semantics:
 *   1. OutboxPublisher happy path: claim → publish → ack
 *   2. Failing publisher: message stays unacked
 *   3. Redelivery after failure: at-least-once property
 *   4. Duplicate delivery: publish succeeds but ack fails (claim expired)
 *   5. Exponential backoff: availableAt advances by 2^attempts
 *   6. Concurrent outbox claim: two publishers can't claim same message
 *   7. DLQ replay: payload integrity preserved through round-trip
 *   8. backoffApplied return value from sweepOutboxDlq
 *   9. Partial failure: some messages publish, some fail
 *  10. Full lifecycle: create → fail → retry → backoff → re-claim → success
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

import { InMemoryKernelRepository } from '../../../kernel/src/testing/inMemoryRepository.js';
import { OutboxPublisher, type EventPublisher } from '../../../kernel/src/index.js';
import type { KernelOutboxMessage } from '../../../kernel/src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createRunCommand(tenantId: string) {
  const runId = randomUUID();
  return {
    id: runId,
    tenantId,
    intentHash: createHash('sha256').update(runId).digest('hex'),
    workGraphHash: createHash('sha256').update(runId).digest('hex'),
    workGraphVersion: 'v1',
    policySnapshotId: 'test-policy',
    steps: [
      {
        id: `${runId}-step-0`,
        kind: 'agent',
        input: { goal: 'Test', agentId: 'a' },
        maxAttempts: 3,
      },
    ],
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Stub EventPublisher that records all published messages and can simulate failures. */
class StubEventPublisher implements EventPublisher {
  readonly published: Array<{ topic: string; key: string; payload: Record<string, unknown> }> = [];
  private failN = 0;
  private failCount = 0;
  private failMatcher:
    | ((msg: { topic: string; key: string; payload: Record<string, unknown> }) => boolean)
    | null = null;

  /** Fail the next N publish() calls regardless of message. */
  failNext(n: number): void {
    this.failN = n;
    this.failCount = 0;
  }

  /** Fail any publish() where the matcher returns true. */
  failMatching(
    matcher: (msg: { topic: string; key: string; payload: Record<string, unknown> }) => boolean,
  ): void {
    this.failMatcher = matcher;
  }

  async publish(message: {
    topic: string;
    key: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (this.failN > 0 && this.failCount < this.failN) {
      this.failCount++;
      throw new Error(`Simulated publish failure ${this.failCount}`);
    }
    if (this.failMatcher?.(message)) {
      throw new Error('Simulated publish failure (matcher)');
    }
    this.published.push(message);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('V2 Outbox At-Least-Once Delivery', () => {
  let kernel: InMemoryKernelRepository;
  const tenantId = 'tenant-outbox-test';

  beforeEach(() => {
    kernel = new InMemoryKernelRepository();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────────

  it('should claim, publish, and ack outbox messages on the happy path', async () => {
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    const stub = new StubEventPublisher();
    const publisher = new OutboxPublisher(kernel, stub);

    const result = await publisher.publishOnce(100);

    assert.ok(result.published > 0, 'Should have published at least 1 message');
    assert.equal(result.failed, 0, 'Should have 0 failures');
    assert.ok(stub.published.length > 0, 'Stub should have received the message');

    const remaining = await kernel.claimOutbox(100);
    assert.equal(remaining.length, 0, 'Outbox should be empty after publish');
  });

  // ── 2. Failing publisher: message stays unacked ────────────────────────────

  it('should leave message unacked when publisher fails', async () => {
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    const stub = new StubEventPublisher();
    stub.failNext(1);
    const publisher = new OutboxPublisher(kernel, stub);

    const result = await publisher.publishOnce(100);

    assert.equal(result.published, 0, 'Nothing should be published');
    assert.ok(result.failed > 0, 'Should have failures');

    // Message should still be in the outbox (unacked)
    const remaining = await kernel.claimOutbox(100, new Date(Date.now() + 62_000));
    assert.ok(remaining.length > 0, 'Unacked message should be re-claimable after lease expiry');
    assert.ok(remaining[0]!.attempts >= 2, 'Attempts should have been incremented on re-claim');
  });

  // ── 3. Redelivery after failure: at-least-once property ─────────────────────

  it('should redeliver message after publish failure (at-least-once)', async () => {
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    const stub = new StubEventPublisher();
    stub.failNext(1);
    const publisher = new OutboxPublisher(kernel, stub);

    // First attempt: fails
    const result1 = await publisher.publishOnce(100);
    assert.equal(result1.published, 0);

    // Advance past claim lease (60s) so the message becomes re-claimable
    const afterExpiry = new Date(Date.now() + 62_000);

    // Publish with a fresh publisher using advanced-time wrapper
    // The publisher will claim + publish + ack in one cycle
    const stub2 = new StubEventPublisher();
    const advancedKernel = {
      claimOutbox: (limit: number) => kernel.claimOutbox(limit, afterExpiry),
      markOutboxPublished: (id: string, token: string) => kernel.markOutboxPublished(id, token),
    };
    const publisher2 = new OutboxPublisher(advancedKernel, stub2);
    const result3 = await publisher2.publishOnce(100);

    assert.ok(result3.published > 0, 'Message should eventually be published');
    assert.ok(stub2.published.length > 0, 'Message should be delivered');

    // Verify payload integrity
    const delivered = stub2.published[0]!;
    assert.ok(delivered.topic.includes('commander.'), 'Topic should be commander-prefixed');
  });

  // ── 4. Duplicate delivery: publish succeeds but ack fails ───────────────────

  it('should deliver duplicate when ack fails (claim expired)', async () => {
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    // Step 1: Claim message directly
    const claimed1 = await kernel.claimOutbox(100);
    assert.ok(claimed1.length > 0);
    const msg1 = claimed1[0]!;
    assert.ok(msg1.claimToken, 'Should have claim token');

    // Step 2: Simulate: publish succeeds (stub records it) but ack fails (claim expired)
    const stub = new StubEventPublisher();
    await stub.publish({ topic: msg1.topic, key: msg1.key, payload: msg1.payload });
    // Don't call markOutboxPublished — simulate ack failure (e.g., process crash after publish)

    // Step 3: Advance past claim lease (60s) and re-claim + publish via publisher
    const afterExpiry = new Date(Date.now() + 62_000);
    const advancedKernel = {
      claimOutbox: (limit: number) => kernel.claimOutbox(limit, afterExpiry),
      markOutboxPublished: (id: string, token: string) => kernel.markOutboxPublished(id, token),
    };
    const publisher = new OutboxPublisher(advancedKernel, stub);
    const result = await publisher.publishOnce(100);

    // The message was delivered twice (once manually, once via publisher)
    assert.ok(
      stub.published.length >= 2,
      'Message should have been delivered at least twice (duplicate delivery)',
    );
  });

  // ── 5. Exponential backoff: availableAt advances by 2^attempts ──────────────

  it('should apply exponential backoff: availableAt advances by 2^attempts seconds', async () => {
    kernel.outboxMaxAttempts = 10;
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    // Claim once (attempts=1), don't ack
    const claimed = await kernel.claimOutbox(100);
    assert.ok(claimed.length > 0);
    assert.equal(claimed[0]!.attempts, 1);

    // Advance past claim lease (60s)
    const afterExpiry = new Date(Date.now() + 62_000);

    // Sweep: should apply backoff (2^1 = 2 seconds)
    const sweepResult = await kernel.sweepOutboxDlq(afterExpiry);
    assert.ok(sweepResult.backoffApplied >= 1, 'Should have applied backoff to 1+ message');
    assert.equal(sweepResult.movedToDlq, 0, 'Should not move to DLQ (below max attempts)');

    // Message should NOT be immediately claimable (availableAt is in the future)
    const immediateClaim = await kernel.claimOutbox(100, afterExpiry);
    assert.equal(immediateClaim.length, 0, 'Message should not be claimable during backoff period');

    // After advancing past backoff (2^1 = 2 seconds + buffer), message becomes claimable
    const afterBackoff = new Date(afterExpiry.getTime() + 3_000);
    const backoffClaim = await kernel.claimOutbox(100, afterBackoff);
    assert.ok(backoffClaim.length > 0, 'Message should be claimable after backoff period');
  });

  // ── 6. Concurrent outbox claim: two publishers can't claim same message ─────

  it('should prevent two publishers from claiming the same message', async () => {
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    // Publisher-A claims
    const claimedA = await kernel.claimOutbox(100);
    assert.ok(claimedA.length > 0, 'Publisher-A should claim messages');

    // Publisher-B claims immediately (same time)
    const claimedB = await kernel.claimOutbox(100);
    assert.equal(claimedB.length, 0, 'Publisher-B should get 0 messages (already claimed by A)');

    // Publisher-A's messages have claimToken
    for (const msg of claimedA) {
      assert.ok(msg.claimToken, 'Claimed message should have claim token');
    }
  });

  // ── 7. DLQ replay: payload integrity preserved ──────────────────────────────

  it('should preserve payload integrity through DLQ replay round-trip', async () => {
    kernel.outboxMaxAttempts = 2;
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    // Claim twice without acking, advancing time past lease each time
    let clock = Date.now();
    for (let i = 0; i < kernel.outboxMaxAttempts; i++) {
      const claimed = await kernel.claimOutbox(100, new Date(clock));
      assert.ok(claimed.length > 0, `Claim ${i + 1} should return the message`);
      clock += 62_000;
    }

    // Sweep to DLQ
    const sweepResult = await kernel.sweepOutboxDlq(new Date(clock));
    assert.equal(sweepResult.movedToDlq, 1, 'Should move 1 message to DLQ');

    // Get DLQ entries
    const dlqEntries = await kernel.listDlqEntries();
    assert.equal(dlqEntries.length, 1);
    const dlqEntry = dlqEntries[0]!;

    // Replay
    const replayed = await kernel.replayDlqEntry(dlqEntry.id);
    assert.equal(replayed, true, 'Replay should succeed');

    // Claim the replayed message
    const replayedClaim = await kernel.claimOutbox(100, new Date(clock));
    assert.ok(replayedClaim.length > 0, 'Replayed message should be claimable');

    const replayedMsg = replayedClaim[0]!;
    assert.equal(replayedMsg.topic, dlqEntry.topic, 'Topic should match');
    assert.equal(replayedMsg.key, dlqEntry.key, 'Key should match');
    assert.deepEqual(replayedMsg.payload, dlqEntry.payload, 'Payload should match');
    assert.equal(replayedMsg.eventId, dlqEntry.eventId, 'EventId should match');
  });

  // ── 8. backoffApplied return value ──────────────────────────────────────────

  it('should return backoffApplied count from sweepOutboxDlq', async () => {
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    // Claim once, don't ack
    const claimed = await kernel.claimOutbox(100);
    assert.ok(claimed.length > 0);

    // Advance past claim lease and sweep
    const afterExpiry = new Date(Date.now() + 62_000);
    const result = await kernel.sweepOutboxDlq(afterExpiry);

    assert.ok(
      result.backoffApplied >= 1,
      `backoffApplied should be >= 1, got ${result.backoffApplied}`,
    );
    assert.equal(result.movedToDlq, 0, 'Should not move to DLQ (below max attempts)');
  });

  // ── 9. Partial failure: some messages publish, some fail ────────────────────

  it('should handle partial failure: some messages published, some failed', async () => {
    // Create 3 runs → 3 outbox messages (run.created events)
    for (let i = 0; i < 3; i++) {
      await kernel.createRun(createRunCommand(tenantId), 'gateway');
    }

    // Verify 3 messages exist
    const allMessages = await kernel.claimOutbox(100);
    assert.equal(allMessages.length, 3, 'Should have 3 outbox messages');

    // Release claims by advancing time
    const afterExpiry = new Date(Date.now() + 62_000);

    // Create publisher that fails on messages matching a specific key
    const stub = new StubEventPublisher();
    const failKey = allMessages[1]!.key;
    stub.failMatching((msg) => msg.key === failKey);

    const publisher = new OutboxPublisher(kernel, stub);

    // Need to re-claim first (previous claims expired)
    // OutboxPublisher calls claimOutbox internally
    // But claims are still active — need to advance time
    // Use a wrapper that advances time
    const advancedKernel = {
      claimOutbox: (limit: number) => kernel.claimOutbox(limit, afterExpiry),
      markOutboxPublished: (id: string, token: string) => kernel.markOutboxPublished(id, token),
    };

    const publisher2 = new OutboxPublisher(advancedKernel, stub);
    const result = await publisher2.publishOnce(100);

    // Should have some published and some failed
    assert.ok(result.published > 0, 'Some messages should be published');
    assert.ok(result.failed > 0, 'Some messages should fail');

    // The failed message should still be in outbox
    const remaining = await kernel.claimOutbox(100, new Date(afterExpiry.getTime() + 62_000));
    assert.ok(remaining.length > 0, 'Failed message should still be in outbox');
  });

  // ── 10. Full lifecycle: create → fail → retry → backoff → re-claim → success ─

  it('should complete full lifecycle: fail → retry → backoff → re-claim → success', async () => {
    kernel.outboxMaxAttempts = 10;
    await kernel.createRun(createRunCommand(tenantId), 'gateway');

    // Step 1: First publish attempt fails
    const stub = new StubEventPublisher();
    stub.failNext(1);
    const publisher = new OutboxPublisher(kernel, stub);
    const result1 = await publisher.publishOnce(100);
    assert.equal(result1.published, 0);
    assert.ok(result1.failed > 0);

    // Step 2: Advance past claim lease (60s)
    const afterExpiry = new Date(Date.now() + 62_000);

    // Step 3: Sweep → applies exponential backoff (2^1 = 2s)
    const sweepResult = await kernel.sweepOutboxDlq(afterExpiry);
    assert.ok(sweepResult.backoffApplied >= 1);

    // Step 4: Message not claimable during backoff
    const immediate = await kernel.claimOutbox(100, afterExpiry);
    assert.equal(immediate.length, 0, 'Should not be claimable during backoff');

    // Step 5: After backoff period (2s + buffer), message becomes claimable
    const afterBackoff = new Date(afterExpiry.getTime() + 3_000);

    // Step 6: Re-claim and publish successfully
    const stub2 = new StubEventPublisher();
    const publisher2 = new OutboxPublisher(kernel, stub2);

    // OutboxPublisher calls claimOutbox with no time arg (uses now)
    // We need to wrap it to use advanced time
    const advancedKernel = {
      claimOutbox: (limit: number) => kernel.claimOutbox(limit, afterBackoff),
      markOutboxPublished: (id: string, token: string) => kernel.markOutboxPublished(id, token),
    };
    const publisher3 = new OutboxPublisher(advancedKernel, stub2);
    const result2 = await publisher3.publishOnce(100);

    assert.ok(result2.published > 0, 'Message should be published after backoff');
    assert.equal(result2.failed, 0, 'No failures on retry');

    // Outbox should now be empty
    const remaining = await kernel.claimOutbox(100, new Date(afterBackoff.getTime() + 62_000));
    assert.equal(remaining.length, 0, 'Outbox should be empty after successful publish');
  });
});
