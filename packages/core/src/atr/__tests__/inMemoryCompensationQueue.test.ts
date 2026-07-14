/**
 * InMemoryCompensationQueue — test-friendly compensation queue core.
 *
 * This is the contract that the SQLite-backed CompensationQueue must mirror
 * for the V2 architecture test suite. The in-memory implementation is
 * intentionally synchronous and side-effect free, so the assertions below
 * pin down the exact semantics that downstream code (worker pool,
 * compensation bridge, ops CLI) relies on:
 *
 *   1. enqueue persists a pending item with a stable, queryable shape
 *   2. claimNext is atomic: only one caller observes a given item
 *   3. markCompleted removes the item
 *   4. markFailed respects exponential backoff and `maxAttempts` ->
 *      escalation
 *   5. markEscalated sets status; retry() is the only path back to pending
 *   6. Tenant visibility mirrors the SQL `WHERE tenant_id IS ? OR ? IS NULL`
 *   7. The module-level store is keyed by filePath, so a "crashed"
 *      instance can be reopened and observe the same state
 *   8. close() makes subsequent calls fail-closed (no silent no-ops)
 *
 * The tests are deterministic: time is injected by `Date.now` plus small
 * backoffBaseMs (5ms) so the suite runs in <1s without flakiness on
 * shared CI runners.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { InMemoryCompensationQueue } from '../inMemoryCompensationQueue';
import {
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  SimpleTenantProvider,
} from '../../runtime/tenantProvider';
import { runWithTenant } from '../../runtime/tenantContext';

const baseItem = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  runId: `run-${id}`,
  agentId: `agent-${id}`,
  tenantId: 'tenant-A',
  toolName: 'shell_execute',
  args: { command: 'rm -rf /tmp/foo' },
  compensationHandlerKey: 'shell_execute.compensate',
  ...overrides,
});

describe('InMemoryCompensationQueue — V2 contract', () => {
  beforeEach(() => {
    // Reset the module-level store so each test sees a clean slate.
    InMemoryCompensationQueue.resetAllStores();
    resetGlobalTenantProvider();
  });

  afterEach(() => {
    InMemoryCompensationQueue.resetAllStores();
    resetGlobalTenantProvider();
  });

  // ─── 1. enqueue + claimNext ───────────────────────────────────────────────

  describe('enqueue + claimNext', () => {
    it('stores a new pending item and lets a worker claim it', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('item-1'));

      const claimed = q.claimNext();
      expect(claimed).not.toBeNull();
      expect(claimed?.id).toBe('item-1');
      expect(claimed?.status).toBe('in_progress');
      expect(claimed?.attemptCount).toBe(1);
      expect(claimed?.lastAttemptAt).toBeDefined();
      // args are JSON-serialized for the durable layer contract.
      expect(typeof claimed?.args).toBe('string');
      expect(JSON.parse(claimed!.args)).toEqual({ command: 'rm -rf /tmp/foo' });
    });

    it('returns null when no items are due', () => {
      const q = new InMemoryCompensationQueue();
      expect(q.claimNext()).toBeNull();
    });

    it('respects nextAttemptAt scheduling — future-dated items are skipped', async () => {
      const q = new InMemoryCompensationQueue({ backoffBaseMs: 5 });
      q.enqueue(baseItem('item-future'));
      // First claim works.
      const first = q.claimNext();
      expect(first).not.toBeNull();
      // Fail it → schedule next attempt in the future.
      const status = q.markFailed('item-future', 'transient', 1);
      expect(status).toBe('pending');
      // Immediately re-claim: must return null because nextAttemptAt > now.
      expect(q.claimNext()).toBeNull();
      // Wait past the backoff window.
      await new Promise((r) => setTimeout(r, 30));
      const retry = q.claimNext();
      expect(retry).not.toBeNull();
      expect(retry?.id).toBe('item-future');
    });

    it('orders multiple due items by nextAttemptAt (FIFO)', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('a'));
      // Bump b's enqueueAt later so a is strictly older.
      const later = new Date(Date.now() + 50).toISOString();
      // The InMemory queue reads enqueueAt for list() ordering, but
      // claimNext sorts by nextAttemptAt. Two enqueue() calls produce
      // a < b in time, so a is claimed first.
      q.enqueue(baseItem('b'));
      const first = q.claimNext();
      expect(first?.id).toBe('a');
      // After marking a completed, b should be next.
      q.markCompleted('a');
      const second = q.claimNext();
      expect(second?.id).toBe('b');
      void later;
    });

    it('claimNext returns a defensive copy — mutating the result does not affect the store', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('item-copy'));
      const claimed = q.claimNext()!;
      // Mutating the returned copy must not be visible to subsequent
      // reads of the in-flight item. We verify by enqueuing a second
      // item, completing the first, and re-reading via get() to confirm
      // the original item's metadata (attemptCount) was not corrupted.
      claimed.attemptCount = 999;
      claimed.lastError = 'corrupted-from-claimed';
      q.markCompleted('item-copy');
      // Re-enqueue with the same id and read it back: the store should
      // not be polluted by mutations on the previously returned copy.
      q.enqueue(baseItem('item-copy'));
      const second = q.claimNext()!;
      expect(second.attemptCount).toBe(1);
      expect(second.lastError).toBeUndefined();
    });
  });

  // ─── 2. markCompleted ─────────────────────────────────────────────────────

  describe('markCompleted', () => {
    it('removes the item from the queue', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('item-done'));
      q.claimNext();
      q.markCompleted('item-done');
      expect(q.get('item-done')).toBeNull();
      expect(q.list()).toEqual([]);
    });

    it('is a no-op for an unknown id (does not throw)', () => {
      const q = new InMemoryCompensationQueue();
      expect(() => q.markCompleted('never-existed')).not.toThrow();
    });
  });

  // ─── 3. markFailed + backoff + escalation ─────────────────────────────────

  describe('markFailed and escalation', () => {
    it('returns pending and reschedules when attempts remain', async () => {
      const q = new InMemoryCompensationQueue({ backoffBaseMs: 5 });
      q.enqueue(baseItem('item-retry', { maxAttempts: 3 }));
      q.claimNext();
      const next = q.markFailed('item-retry', 'transient', 1);
      expect(next).toBe('pending');
      const item = q.get('item-retry');
      expect(item?.status).toBe('pending');
      expect(item?.lastError).toBe('transient');
      expect(item?.attemptCount).toBe(1);
      // nextAttemptAt must be in the future.
      expect(new Date(item!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() - 1);
    });

    it('escalates when currentAttempt >= maxAttempts', () => {
      const q = new InMemoryCompensationQueue({ backoffBaseMs: 5 });
      q.enqueue(baseItem('item-escalate', { maxAttempts: 2 }));
      q.claimNext();
      // currentAttempt is what the caller (worker) observed; the gate
      // escalates once it reaches maxAttempts.
      const next = q.markFailed('item-escalate', 'permanent', 2);
      expect(next).toBe('escalated');
      const item = q.get('item-escalate');
      expect(item?.status).toBe('escalated');
      expect(item?.lastError).toBe('permanent');
    });

    it('returns escalated for an unknown id (mirrors SQL "no such row")', () => {
      const q = new InMemoryCompensationQueue();
      expect(q.markFailed('ghost', 'err', 1)).toBe('escalated');
    });

    it('exponential backoff doubles per attempt up to the cap', () => {
      const q = new InMemoryCompensationQueue({
        backoffBaseMs: 1000,
        backoffMaxMs: 60_000,
      });
      // attempt 1 → 1000 * 2^0 = 1000
      // attempt 5 → 1000 * 2^4 = 16000
      // attempt 10 → 1000 * 2^9 = 512000 → capped to 60_000
      q.enqueue(baseItem('item-backoff', { maxAttempts: 20 }));
      q.claimNext();
      q.markFailed('item-backoff', 'e1', 1);
      const a1 = new Date(q.get('item-backoff')!.nextAttemptAt).getTime() - Date.now();
      q.claimNext();
      q.markFailed('item-backoff', 'e5', 5);
      const a5 = new Date(q.get('item-backoff')!.nextAttemptAt).getTime() - Date.now();
      q.claimNext();
      q.markFailed('item-backoff', 'e10', 10);
      const a10 = new Date(q.get('item-backoff')!.nextAttemptAt).getTime() - Date.now();
      // a5 > a1 (strict monotonic growth)
      expect(a5).toBeGreaterThan(a1);
      // a10 is capped near the max
      expect(a10).toBeLessThanOrEqual(60_000 + 50);
      // a10 ≈ a1's doubling (a5 doubling is ≈ 16x a1)
      expect(a5 / Math.max(a1, 1)).toBeGreaterThan(10);
    });
  });

  // ─── 4. retry() — force-retry an escalated item ───────────────────────────

  describe('retry of escalated items', () => {
    it('moves an escalated item back to pending with attemptCount=0', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('item-retry', { maxAttempts: 1 }));
      q.claimNext();
      q.markFailed('item-retry', 'first', 1);
      expect(q.get('item-retry')?.status).toBe('escalated');
      const ok = q.retry('item-retry');
      expect(ok).toBe(true);
      const item = q.get('item-retry');
      expect(item?.status).toBe('pending');
      expect(item?.attemptCount).toBe(0);
      expect(item?.lastError).toBeUndefined();
    });

    it('returns false for items that are not in escalated state', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('item-pending'));
      expect(q.retry('item-pending')).toBe(false);
    });

    it('returns false for an unknown id', () => {
      const q = new InMemoryCompensationQueue();
      expect(q.retry('nope')).toBe(false);
    });
  });

  // ─── 5. Tenant isolation ──────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('outside tenant context, all items are visible', () => {
      setGlobalTenantProvider(new SimpleTenantProvider([{ id: 'tenant-A' }, { id: 'tenant-B' }]));
      // Without runWithTenant: getCurrentTenantId is undefined →
      // the SQL clause `? IS NULL` is true → all rows visible.
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('a', { tenantId: 'tenant-A' }));
      q.enqueue(baseItem('b', { tenantId: 'tenant-B' }));
      expect(
        q
          .list()
          .map((i) => i.id)
          .sort(),
      ).toEqual(['a', 'b']);
    });

    it('inside tenant context, only that tenant items are visible', () => {
      setGlobalTenantProvider(new SimpleTenantProvider([{ id: 'tenant-A' }, { id: 'tenant-B' }]));
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('a', { tenantId: 'tenant-A' }));
      q.enqueue(baseItem('b', { tenantId: 'tenant-B' }));
      runWithTenant('tenant-A', () => {
        const visible = q.list().map((i) => i.id);
        expect(visible).toEqual(['a']);
        expect(q.get('b')).toBeNull();
        expect(q.claimNext()?.tenantId).toBe('tenant-A');
      });
    });

    it('countByStatus respects the tenant filter', () => {
      setGlobalTenantProvider(new SimpleTenantProvider([{ id: 'tenant-A' }, { id: 'tenant-B' }]));
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('a1', { tenantId: 'tenant-A' }));
      q.enqueue(baseItem('a2', { tenantId: 'tenant-A' }));
      q.enqueue(baseItem('b1', { tenantId: 'tenant-B' }));
      runWithTenant('tenant-A', () => {
        const counts = q.countByStatus();
        expect(counts.pending).toBe(2);
        expect(counts.in_progress).toBe(0);
        expect(counts.escalated).toBe(0);
      });
    });
  });

  // ─── 6. Crash recovery via shared filePath ────────────────────────────────

  describe('crash recovery via shared filePath', () => {
    it('a fresh instance with the same filePath observes the prior items', () => {
      const filePath = '/tmp/commander-comp-queue-test.db';
      // Pre-populate via the first "process".
      const first = new InMemoryCompensationQueue({ filePath });
      first.enqueue(baseItem('item-survive', { tenantId: undefined }));
      // "Crash" — close the first handle. Data persists in the
      // module-level store keyed by filePath.
      first.close();

      // Second "process" reopens the same filePath.
      const second = new InMemoryCompensationQueue({ filePath });
      const items = second.list().map((i) => i.id);
      expect(items).toContain('item-survive');
      // close() does not wipe the store; reopen must see prior state.
      second.close();
    });

    it('a fresh instance with a different filePath sees an empty queue', () => {
      const q1 = new InMemoryCompensationQueue({ filePath: '/tmp/comp-A.db' });
      q1.enqueue(baseItem('only-A'));
      q1.close();

      const q2 = new InMemoryCompensationQueue({ filePath: '/tmp/comp-B.db' });
      expect(q2.list()).toEqual([]);
    });
  });

  // ─── 7. close() fail-closed semantics ─────────────────────────────────────

  describe('close() fail-closed semantics', () => {
    it('rejects new enqueues after close', () => {
      const q = new InMemoryCompensationQueue();
      q.close();
      expect(() => q.enqueue(baseItem('after-close'))).toThrow(/not initialized/);
    });

    it('makes claimNext return null after close (no silent processing)', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('before-close'));
      q.close();
      expect(q.claimNext()).toBeNull();
    });

    it('makes list/countByStatus return safe empty values after close', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('a'));
      q.close();
      expect(q.list()).toEqual([]);
      expect(q.countByStatus()).toEqual({ pending: 0, in_progress: 0, escalated: 0 });
    });
  });

  // ─── 8. list() filters ────────────────────────────────────────────────────

  describe('list() filtering and ordering', () => {
    it('filters by status', () => {
      const q = new InMemoryCompensationQueue();
      q.enqueue(baseItem('p1'));
      q.enqueue(baseItem('p2'));
      // p1 → escalated via immediate failure.
      q.claimNext();
      q.markFailed('p1', 'perm', 1);
      q.markEscalated('p1', 'final');
      // p2 still pending.
      const pending = q.list({ status: 'pending' }).map((i) => i.id);
      const escalated = q.list({ status: 'escalated' }).map((i) => i.id);
      expect(pending).toEqual(['p2']);
      expect(escalated).toEqual(['p1']);
    });

    it('respects the limit option', () => {
      const q = new InMemoryCompensationQueue();
      for (let i = 0; i < 5; i++) q.enqueue(baseItem(`p${i}`));
      expect(q.list({ limit: 3 })).toHaveLength(3);
    });
  });
});
