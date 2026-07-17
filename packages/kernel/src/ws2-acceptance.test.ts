/**
 * WS2 §5/§7/§8 acceptance tests (kernel layer).
 *
 * §5 — policy engine: action allowlist, tenant quota, capability revocation.
 * §7 — schema: the four WS2 tables surface as working repository methods.
 * §8 — compensation outbox: claimOutboxByTopic drains the compensation topic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from './testing/inMemoryRepository.js';

describe('WS2 §5 action allowlist', () => {
  it('isActionAllowed fails closed when no allowlist entries exist', async () => {
    const kernel = new InMemoryKernelRepository();
    assert.equal(await kernel.isActionAllowed('tenant-a', 'http.post'), false);
  });

  it('isActionAllowed returns true for an explicitly allowed action', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.setAllowlistEntry('tenant-a', 'http.post', true);
    assert.equal(await kernel.isActionAllowed('tenant-a', 'http.post'), true);
  });

  it('isActionAllowed returns false for an explicitly denied action', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.setAllowlistEntry('tenant-a', 'http.post', false);
    assert.equal(await kernel.isActionAllowed('tenant-a', 'http.post'), false);
  });

  it('isActionAllowed is tenant-scoped', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.setAllowlistEntry('tenant-a', 'http.post', true);
    assert.equal(await kernel.isActionAllowed('tenant-b', 'http.post'), false);
  });
});

describe('WS2 §5 tenant quota', () => {
  it('incrementQuota starts at 1 and increments', async () => {
    const kernel = new InMemoryKernelRepository();
    const r1 = await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'http' });
    assert.equal(r1.countUsed, 1);
    const r2 = await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'http' });
    assert.equal(r2.countUsed, 2);
  });

  it('getQuota returns zero for a fresh tenant', async () => {
    const kernel = new InMemoryKernelRepository();
    const q = await kernel.getQuota('tenant-a', 'http');
    assert.equal(q.countUsed, 0);
    assert.equal(q.tokensUsed, 0);
  });

  it('incrementQuota tracks token usage', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'llm', tokensUsed: 500 });
    await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'llm', tokensUsed: 300 });
    const q = await kernel.getQuota('tenant-a', 'llm');
    assert.equal(q.countUsed, 2);
    assert.equal(q.tokensUsed, 800);
  });

  it('quota is tenant + actionClass scoped', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'http' });
    await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'http' });
    await kernel.incrementQuota({ tenantId: 'tenant-a', actionClass: 'llm' });
    assert.equal((await kernel.getQuota('tenant-a', 'http')).countUsed, 2);
    assert.equal((await kernel.getQuota('tenant-a', 'llm')).countUsed, 1);
    assert.equal((await kernel.getQuota('tenant-b', 'http')).countUsed, 0);
  });
});

describe('WS2 §6/§7 capability revocation lifecycle', () => {
  it('isCapabilityRevoked returns false for a non-revoked jti', async () => {
    const kernel = new InMemoryKernelRepository();
    assert.equal(await kernel.isCapabilityRevoked('jti-active'), false);
  });

  it('revokeCapability marks a jti as revoked', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.revokeCapability({ jti: 'jti-1', tenantId: 'tenant-a', expiresAt: '2099-01-01T00:00:00.000Z', reason: 'rotated' });
    assert.equal(await kernel.isCapabilityRevoked('jti-1'), true);
    assert.equal(await kernel.isCapabilityRevoked('jti-2'), false);
  });
});

describe('WS2 §8 compensation outbox claiming', () => {
  it('claimOutboxByTopic returns messages for the requested topic', async () => {
    const kernel = new InMemoryKernelRepository();
    // Creating a run records a 'run.created' event which enqueues an outbox
    // message on the 'commander.run.created' topic.
    await kernel.createRun({
      id: 'run-comp', tenantId: 'tenant-a', intentHash: 'intent',
      workGraphHash: 'graph', workGraphVersion: 'v1', policySnapshotId: 'p1',
      steps: [{ id: 'step-a', kind: 'agent' }],
    }, 'gateway');
    const claimed = await kernel.claimOutboxByTopic('commander.run.created', 10);
    assert.ok(claimed.length >= 1, 'run.created outbox message should be claimable');
    assert.ok(claimed.every((m) => m.topic === 'commander.run.created'));
  });

  it('claimOutboxByTopic returns empty for a topic with no messages', async () => {
    const kernel = new InMemoryKernelRepository();
    const claimed = await kernel.claimOutboxByTopic('commander.compensation', 10);
    assert.equal(claimed.length, 0);
  });

  it('poison compensation messages hit max_attempts then stay in DLQ (no re-claim)', async () => {
    const kernel = new InMemoryKernelRepository();
    kernel.outboxMaxAttempts = 3;
    kernel.seedOutboxMessage({
      topic: 'commander.compensation',
      payload: {
        tenantId: 'tenant-a',
        runId: 'run-1',
        stepId: 'step-1',
        compensationAction: 'crm.compensate',
        compensationPayload: { undo: true },
      },
    });

    let clock = Date.now();
    for (let i = 0; i < 3; i++) {
      const at = new Date(clock);
      const claimed = await kernel.claimOutboxByTopic('commander.compensation', 10, at);
      assert.equal(claimed.length, 1, `round ${i} should still serve the poison message`);
      const msg = claimed[0]!;
      await kernel.retryOutbox(msg.id, msg.claimToken!, { code: 'POISON', message: 'always fails' }, at);
      clock += 60_000;
    }

    assert.equal((await kernel.claimOutboxByTopic('commander.compensation', 10, new Date(clock))).length, 0);
    const sweep = await kernel.sweepOutboxDlq(new Date(clock), 10);
    assert.equal(sweep.movedToDlq, 1);
    const dlq = await kernel.listDlqEntries(10, 'commander.compensation');
    assert.equal(dlq.length, 1);
    assert.equal(dlq[0]!.dlqReason, 'max_attempts_exceeded');
    assert.equal((await kernel.claimOutboxByTopic('commander.compensation', 10, new Date(clock))).length, 0);
  });

  it('generic claimOutbox also stops at max_attempts before sweep (symmetric with ByTopic)', async () => {
    const kernel = new InMemoryKernelRepository();
    kernel.outboxMaxAttempts = 2;
    kernel.seedOutboxMessage({ topic: 'commander.run.created', key: 'run-x' });

    let clock = Date.now();
    for (let i = 0; i < 2; i++) {
      const at = new Date(clock);
      const claimed = await kernel.claimOutbox(10, at);
      assert.equal(claimed.length, 1, `round ${i}`);
      await kernel.retryOutbox(claimed[0]!.id, claimed[0]!.claimToken!, { code: 'POISON', message: 'fail' }, at);
      clock += 60_000;
    }
    assert.equal((await kernel.claimOutbox(10, new Date(clock))).length, 0);
    assert.equal((await kernel.sweepOutboxDlq(new Date(clock), 10)).movedToDlq, 1);
    assert.equal((await kernel.claimOutbox(10, new Date(clock))).length, 0);
  });

  it('Postgres claimOutbox SQL keeps DLQ + max_attempts filters (source ENFORCED)', () => {
    // InMemory proves semantics; this gate prevents the production SQL from
    // regressing to pre-filter claim loops without a live Postgres suite.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'postgres.ts'),
      'utf8',
    );
    const claimOutbox = src.match(/async claimOutbox\([\s\S]*?^  async markOutboxPublished/m);
    const claimByTopic = src.match(
      /async claimOutboxByTopic\([\s\S]*?^  async isCapabilityRevoked/m,
    );
    assert.ok(claimOutbox, 'claimOutbox method not found in postgres.ts');
    assert.ok(claimByTopic, 'claimOutboxByTopic method not found in postgres.ts');
    for (const [name, body] of [
      ['claimOutbox', claimOutbox![0]],
      ['claimOutboxByTopic', claimByTopic![0]],
    ] as const) {
      assert.match(
        body,
        /moved_to_dlq_at IS NULL AND attempts < max_attempts/,
        `${name} SQL must filter DLQ and max_attempts`,
      );
    }
  });
});
