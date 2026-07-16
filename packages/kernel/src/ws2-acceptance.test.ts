/**
 * WS2 §5/§7/§8 acceptance tests (kernel layer).
 *
 * §5 — policy engine: action allowlist, tenant quota, capability revocation.
 * §7 — schema: the four WS2 tables surface as working repository methods.
 * §8 — compensation outbox: claimOutboxByTopic drains the compensation topic.
 */
import assert from 'node:assert/strict';
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
});
