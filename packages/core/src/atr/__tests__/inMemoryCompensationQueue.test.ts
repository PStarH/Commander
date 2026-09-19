/**
 * InMemoryCompensationQueue — test-friendly compensation queue core.
 *
 * This is the contract that the SQLite-backed CompensationQueue must mirror
 * for the V2 architecture test suite. The in-memory implementation is
 * intentionally synchronous and side-effect free, so the assertions below
 * pin down the exact semantics that downstream code (worker pool,
 * compensation bridge, ops CLI) relies on:
 *
 *   1. enqueue persists a pending item bound to the authenticated tenant;
 *      a duplicate id raises (SQLite PRIMARY KEY parity)
 *   2. claimNext is atomic, tenant-scoped, stamps a claim generation and a
 *      bounded claim expiry, and never replays an expired claim
 *   3. markCompleted keeps a minimal receipt and is idempotent
 *   4. markFailed respects exponential backoff and `maxAttempts` ->
 *      escalation
 *   5. markEscalated sets status; retry() is the only path back to pending
 *   6. Every write is CAS-bound to (tenant, claim generation, state): a
 *      tenant cannot touch another tenant's work and a stale claim cannot
 *      mutate a newer attempt
 *   7. Store isolation mirrors SQLite `:memory:`: the default store is
 *      private per instance; an explicit filePath is shared
 *   8. close() refuses later calls explicitly
 *
 * AR-03: the in-memory double is a test convenience, not proof of SQLite
 * persistence or multi-process contention; the SQLite implementation must be
 * verified separately for durability and real cross-process races.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CompensationQueue, CLAIM_EXPIRED_REASON } from '../compensationQueue';
import { InMemoryCompensationQueue } from '../inMemoryCompensationQueue';
import { runWithTenant } from '../../runtime/tenantContext';

const nodeRequire = createRequire(import.meta.url);
let sqliteAvailable = false;
try {
  const Database = nodeRequire('better-sqlite3');
  const probe = new Database(':memory:');
  probe.prepare('SELECT 1').get();
  probe.close();
  sqliteAvailable = true;
} catch {
  sqliteAvailable = false;
}

let storeSeq = 0;
/** Explicit, unique store key per test — never the shared `:memory:` default. */
const storePath = (label = 'store') =>
  `/tmp/commander-comp-queue-${label}-${process.pid}-${++storeSeq}.db`;

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

/** Run inside a fixed fake clock so backoff/expiry are deterministic. */
function withFakeClock<T>(fn: () => T): T {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

function advance(ms: number): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

describe('InMemoryCompensationQueue — V2 contract', () => {
  beforeEach(() => {
    InMemoryCompensationQueue.resetAllStores();
  });

  afterEach(() => {
    vi.useRealTimers();
    InMemoryCompensationQueue.resetAllStores();
  });

  // ─── 1. enqueue + claimNext ───────────────────────────────────────────────

  describe('enqueue + claimNext', () => {
    it('stores a new pending item and lets a worker claim it', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('claim') });
        q.enqueue(baseItem('item-1'));

        const claimed = q.claimNext();
        expect(claimed).not.toBeNull();
        expect(claimed?.id).toBe('item-1');
        expect(claimed?.status).toBe('in_progress');
        expect(claimed?.attemptCount).toBe(1);
        expect(claimed?.claimGeneration).toBe(1);
        expect(claimed?.claimExpiresAt).toBeDefined();
        expect(new Date(claimed!.claimExpiresAt!).getTime()).toBeGreaterThan(Date.now());
        expect(claimed?.lastAttemptAt).toBeDefined();
        // args are JSON-serialized for the durable layer contract.
        expect(typeof claimed?.args).toBe('string');
        expect(JSON.parse(claimed!.args)).toEqual({ command: 'rm -rf /tmp/foo' });
      });
    });

    it('returns null when no items are due', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('empty') });
        expect(q.claimNext()).toBeNull();
      });
    });

    it('raises on a duplicate enqueue (SQLite PRIMARY KEY parity)', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('dup') });
        q.enqueue(baseItem('item-dup'));
        expect(() => q.enqueue(baseItem('item-dup'))).toThrow(/duplicate id/);
        // The original row is untouched (the old Map.set silently overwrote).
        expect(q.get('item-dup')?.attemptCount).toBe(0);
        expect(q.list()).toHaveLength(1);
      });
    });

    it('refuses enqueue without an authenticated tenant context', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('notenant') });
      expect(() => q.enqueue(baseItem('item-no-tenant'))).toThrow(/authenticated tenant context/);
    });

    it('refuses enqueue when input.tenantId disagrees with the authenticated tenant', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('mismatch') });
        expect(() => q.enqueue(baseItem('item-x', { tenantId: 'tenant-B' }))).toThrow(
          /does not match the authenticated tenant/,
        );
      });
    });

    it('respects nextAttemptAt scheduling — future-dated items are skipped', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('future'),
            backoffBaseMs: 1000,
          });
          q.enqueue(baseItem('item-future'));
          const first = q.claimNext();
          expect(first).not.toBeNull();
          const status = q.markFailed('item-future', 'transient', {
            tenantId: 'tenant-A',
            claimGeneration: first!.claimGeneration,
          });
          expect(status).toBe('pending');
          // Immediately re-claim: must return null because nextAttemptAt > now.
          expect(q.claimNext()).toBeNull();
          // Advance past the deterministic backoff window.
          advance(1001);
          const retry = q.claimNext();
          expect(retry).not.toBeNull();
          expect(retry?.id).toBe('item-future');
        });
      });
    });

    it('orders multiple due items by nextAttemptAt (FIFO)', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({ filePath: storePath('fifo') });
          q.enqueue(baseItem('a'));
          advance(1);
          q.enqueue(baseItem('b'));
          const first = q.claimNext();
          expect(first?.id).toBe('a');
          q.markCompleted('a', { tenantId: 'tenant-A', claimGeneration: first!.claimGeneration });
          const second = q.claimNext();
          expect(second?.id).toBe('b');
        });
      });
    });

    it('claimNext returns a defensive copy — mutating the result does not affect the store', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('copy') });
        q.enqueue(baseItem('item-copy'));
        const claimed = q.claimNext()!;
        claimed.attemptCount = 999;
        claimed.lastError = 'corrupted-from-claimed';
        // Verify the STORED row before deleting it — the old test deleted and
        // re-created the item, so it could not detect pollution at all.
        expect(q.get('item-copy')?.attemptCount).toBe(1);
        expect(q.get('item-copy')?.lastError).toBeUndefined();
        q.markCompleted('item-copy', { tenantId: 'tenant-A', claimGeneration: 1 });
        expect(q.get('item-copy')).toBeNull();
      });
    });
  });

  // ─── 2. markCompleted + receipts ──────────────────────────────────────────

  describe('markCompleted', () => {
    it('removes the item and keeps a minimal audit receipt', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('complete') });
        q.enqueue(baseItem('item-done'));
        const claimed = q.claimNext()!;
        expect(
          q.markCompleted('item-done', {
            tenantId: 'tenant-A',
            claimGeneration: claimed.claimGeneration,
          }),
        ).toBe(true);
        expect(q.get('item-done')).toBeNull();
        expect(q.list()).toEqual([]);
        const receipt = q.getReceipt('item-done');
        expect(receipt).not.toBeNull();
        expect(receipt?.tenantId).toBe('tenant-A');
        expect(receipt?.runId).toBe('run-item-done');
        expect(receipt?.claimGeneration).toBe(1);
      });
    });

    it('is idempotent: repeating the same completion does not double-apply', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('idem') });
        q.enqueue(baseItem('item-idem'));
        q.claimNext();
        const claim = { tenantId: 'tenant-A', claimGeneration: 1 };
        expect(q.markCompleted('item-idem', claim)).toBe(true);
        expect(q.markCompleted('item-idem', claim)).toBe(true);
        expect(q.getReceipt('item-idem')?.completedAt).toBeDefined();
      });
    });

    it('is refused for an unknown id (no fabricated success)', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('unknown') });
        expect(q.markCompleted('never-existed', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
          false,
        );
        expect(q.getReceipt('never-existed')).toBeNull();
      });
    });

    it('is refused without an explicit claim (legacy shape carries no ownership)', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('noclaim') });
        q.enqueue(baseItem('item-noclaim'));
        q.claimNext();
        expect(q.markCompleted('item-noclaim')).toBe(false);
        expect(q.get('item-noclaim')?.status).toBe('in_progress');
      });
    });
  });

  // ─── 3. markFailed + backoff + escalation ─────────────────────────────────

  describe('markFailed and escalation', () => {
    it('returns pending and reschedules when attempts remain', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('retry'),
            backoffBaseMs: 1000,
          });
          q.enqueue(baseItem('item-retry', { maxAttempts: 3 }));
          const claimed = q.claimNext()!;
          const next = q.markFailed('item-retry', 'transient', {
            tenantId: 'tenant-A',
            claimGeneration: claimed.claimGeneration,
          });
          expect(next).toBe('pending');
          const item = q.get('item-retry');
          expect(item?.status).toBe('pending');
          expect(item?.lastError).toBe('transient');
          expect(item?.attemptCount).toBe(1);
          // nextAttemptAt must be in the future.
          expect(new Date(item!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
          // The claim is released — nothing is left in_progress.
          expect(item?.claimExpiresAt).toBeUndefined();
        });
      });
    });

    it('escalates when attemptCount reaches maxAttempts', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('escalate'),
            backoffBaseMs: 1,
          });
          q.enqueue(baseItem('item-escalate', { maxAttempts: 2 }));
          const first = q.claimNext()!;
          q.markFailed('item-escalate', 'transient', {
            tenantId: 'tenant-A',
            claimGeneration: first.claimGeneration,
          });
          advance(2);
          const second = q.claimNext()!;
          const next = q.markFailed('item-escalate', 'permanent', {
            tenantId: 'tenant-A',
            claimGeneration: second.claimGeneration,
          });
          expect(next).toBe('escalated');
          const item = q.get('item-escalate');
          expect(item?.status).toBe('escalated');
          expect(item?.lastError).toBe('permanent');
        });
      });
    });

    it('is refused for an unknown id (mirrors SQL "no such row")', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('ghost') });
        expect(q.markFailed('ghost', 'err', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
          'refused',
        );
      });
    });

    it('is refused without an explicit claim (legacy numeric shape)', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('legacy-fail') });
        q.enqueue(baseItem('item-legacy'));
        q.claimNext();
        expect(q.markFailed('item-legacy', 'err', 1)).toBe('refused');
        expect(q.get('item-legacy')?.status).toBe('in_progress');
      });
    });

    it('exponential backoff doubles per attempt up to the cap', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('backoff'),
            backoffBaseMs: 1000,
            backoffMaxMs: 60_000,
          });
          q.enqueue(baseItem('item-backoff', { maxAttempts: 20 }));
          const c1 = q.claimNext()!;
          q.markFailed('item-backoff', 'e1', {
            tenantId: 'tenant-A',
            claimGeneration: c1.claimGeneration,
          });
          const a1 = new Date(q.get('item-backoff')!.nextAttemptAt).getTime() - Date.now();
          advance(2000);
          const c5 = q.claimNext()!;
          q.markFailed('item-backoff', 'e5', {
            tenantId: 'tenant-A',
            claimGeneration: c5.claimGeneration,
          });
          const a2 = new Date(q.get('item-backoff')!.nextAttemptAt).getTime() - Date.now();
          advance(20_000);
          const c10 = q.claimNext()!;
          q.markFailed('item-backoff', 'e10', {
            tenantId: 'tenant-A',
            claimGeneration: c10.claimGeneration,
          });
          const a3 = new Date(q.get('item-backoff')!.nextAttemptAt).getTime() - Date.now();
          expect(a2).toBeGreaterThan(a1);
          expect(a3).toBeLessThanOrEqual(60_000);
          expect(a3).toBeGreaterThan(a2);
        });
      });
    });
  });

  // ─── 4. retry() — force-retry an escalated item ───────────────────────────

  describe('retry of escalated items', () => {
    it('moves an escalated item back to pending with attemptCount=0', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('retry-esc') });
        q.enqueue(baseItem('item-retry', { maxAttempts: 1 }));
        const claimed = q.claimNext()!;
        q.markFailed('item-retry', 'first', {
          tenantId: 'tenant-A',
          claimGeneration: claimed.claimGeneration,
        });
        expect(q.get('item-retry')?.status).toBe('escalated');
        expect(q.retry('item-retry', 'tenant-A')).toBe(true);
        const item = q.get('item-retry');
        expect(item?.status).toBe('pending');
        expect(item?.attemptCount).toBe(0);
        expect(item?.lastError).toBeUndefined();
      });
    });

    it('returns false for items that are not in escalated state', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('retry-pending') });
        q.enqueue(baseItem('item-pending'));
        expect(q.retry('item-pending', 'tenant-A')).toBe(false);
      });
    });

    it('returns false without an explicit tenant (no implicit admin)', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('retry-noadmin') });
        q.enqueue(baseItem('item-noadmin'));
        expect(q.retry('item-noadmin')).toBe(false);
      });
    });

    it('returns false for an unknown id', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('retry-unknown') });
        expect(q.retry('nope', 'tenant-A')).toBe(false);
      });
    });
  });

  // ─── 5. Tenant isolation ──────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('outside any tenant context, no rows are visible (no implicit admin)', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('nocontext') });
      runWithTenant('tenant-A', () => q.enqueue(baseItem('a', { tenantId: 'tenant-A' })));
      runWithTenant('tenant-B', () => q.enqueue(baseItem('b', { tenantId: 'tenant-B' })));
      // No ambient tenant → fail closed, never "every tenant".
      expect(q.list()).toEqual([]);
      expect(q.get('a')).toBeNull();
      expect(q.get('b')).toBeNull();
      expect(q.claimNext()).toBeNull();
      expect(q.countByStatus()).toEqual({ pending: 0, in_progress: 0, escalated: 0 });
    });

    it('inside tenant context, only that tenant items are visible', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('visible') });
      runWithTenant('tenant-A', () => q.enqueue(baseItem('a', { tenantId: 'tenant-A' })));
      runWithTenant('tenant-B', () => q.enqueue(baseItem('b', { tenantId: 'tenant-B' })));
      runWithTenant('tenant-A', () => {
        expect(
          q
            .list()
            .map((i) => i.id)
            .sort(),
        ).toEqual(['a']);
        expect(q.get('b')).toBeNull();
        expect(q.claimNext()?.tenantId).toBe('tenant-A');
      });
      runWithTenant('tenant-B', () => {
        expect(q.get('a')).toBeNull();
      });
    });

    it('tenant A cannot complete tenant B work', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('x-complete') });
      const claimedB = runWithTenant('tenant-B', () => {
        q.enqueue(baseItem('b1', { tenantId: 'tenant-B' }));
        return q.claimNext()!;
      });
      runWithTenant('tenant-A', () => {
        expect(q.markCompleted('b1', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(false);
      });
      runWithTenant('tenant-B', () => {
        expect(q.get('b1')?.status).toBe('in_progress');
        expect(
          q.markCompleted('b1', {
            tenantId: 'tenant-B',
            claimGeneration: claimedB.claimGeneration,
          }),
        ).toBe(true);
      });
    });

    it('tenant A cannot escalate tenant B work', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('x-escalate') });
      runWithTenant('tenant-B', () => {
        q.enqueue(baseItem('b2', { tenantId: 'tenant-B' }));
        q.claimNext();
      });
      runWithTenant('tenant-A', () => {
        expect(q.markEscalated('b2', 'nope', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
          false,
        );
      });
      runWithTenant('tenant-B', () => {
        expect(q.get('b2')?.status).toBe('in_progress');
        expect(q.get('b2')?.lastError).toBeUndefined();
      });
    });

    it('tenant A cannot markFailed tenant B work', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('x-fail') });
      runWithTenant('tenant-B', () => {
        q.enqueue(baseItem('b3', { tenantId: 'tenant-B' }));
        q.claimNext();
      });
      runWithTenant('tenant-A', () => {
        expect(q.markFailed('b3', 'nope', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
          'refused',
        );
      });
      runWithTenant('tenant-B', () => {
        expect(q.get('b3')?.status).toBe('in_progress');
      });
    });

    it('tenant A cannot retry tenant B escalated work', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('x-retry') });
      runWithTenant('tenant-B', () => {
        q.enqueue(baseItem('b4', { tenantId: 'tenant-B' }));
        const claimed = q.claimNext()!;
        q.markEscalated('b4', 'manual', {
          tenantId: 'tenant-B',
          claimGeneration: claimed.claimGeneration,
        });
      });
      expect(runWithTenant('tenant-A', () => q.retry('b4', 'tenant-A'))).toBe(false);
      runWithTenant('tenant-B', () => {
        expect(q.get('b4')?.status).toBe('escalated');
        expect(q.retry('b4', 'tenant-B')).toBe(true);
      });
    });

    it('countByStatus respects the tenant filter', () => {
      const q = new InMemoryCompensationQueue({ filePath: storePath('count') });
      runWithTenant('tenant-A', () => {
        q.enqueue(baseItem('a1', { tenantId: 'tenant-A' }));
        q.enqueue(baseItem('a2', { tenantId: 'tenant-A' }));
      });
      runWithTenant('tenant-B', () => q.enqueue(baseItem('b1', { tenantId: 'tenant-B' })));
      runWithTenant('tenant-A', () => {
        expect(q.countByStatus()).toEqual({ pending: 2, in_progress: 0, escalated: 0 });
      });
      runWithTenant('tenant-B', () => {
        expect(q.countByStatus()).toEqual({ pending: 1, in_progress: 0, escalated: 0 });
      });
    });
  });

  // ─── 6. Claim generation (CAS) ────────────────────────────────────────────

  describe('claim generation CAS', () => {
    it('an old claim cannot mutate a newer claim', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('cas'),
            backoffBaseMs: 1,
          });
          q.enqueue(baseItem('item-cas', { maxAttempts: 5 }));
          const first = q.claimNext()!;
          expect(first.claimGeneration).toBe(1);
          q.markFailed('item-cas', 'transient', {
            tenantId: 'tenant-A',
            claimGeneration: 1,
          });
          advance(2);
          const second = q.claimNext()!;
          expect(second.claimGeneration).toBe(2);
          // The stale worker (generation 1) can no longer complete or fail it.
          expect(q.markCompleted('item-cas', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
            false,
          );
          expect(
            q.markEscalated('item-cas', 'stale', { tenantId: 'tenant-A', claimGeneration: 1 }),
          ).toBe(false);
          expect(
            q.markFailed('item-cas', 'stale', { tenantId: 'tenant-A', claimGeneration: 1 }),
          ).toBe('refused');
          const current = q.get('item-cas')!;
          expect(current.status).toBe('in_progress');
          expect(current.lastError).toBe('transient');
          // The live claim still owns the row.
          expect(q.markCompleted('item-cas', { tenantId: 'tenant-A', claimGeneration: 2 })).toBe(
            true,
          );
        });
      });
    });

    it('increments the generation on every claim', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('gen'),
            backoffBaseMs: 1,
          });
          q.enqueue(baseItem('item-gen', { maxAttempts: 10 }));
          for (let gen = 1; gen <= 3; gen++) {
            const claimed = q.claimNext()!;
            expect(claimed.claimGeneration).toBe(gen);
            q.markFailed('item-gen', 'again', {
              tenantId: 'tenant-A',
              claimGeneration: gen,
            });
            advance(2);
          }
        });
      });
    });
  });

  // ─── 7. Bounded claim expiry → reconciliation ─────────────────────────────

  describe('bounded claims never replay unknown external effects', () => {
    it('escalates an expired in-progress claim instead of re-claiming it', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('expiry'),
            claimTtlSeconds: 30,
          });
          q.enqueue(baseItem('item-expire'));
          const claimed = q.claimNext()!;
          expect(claimed.status).toBe('in_progress');
          advance(30_001);
          // No replay: the expired claim is escalated for reconciliation.
          expect(q.claimNext()).toBeNull();
          const item = q.get('item-expire')!;
          expect(item.status).toBe('escalated');
          expect(item.lastError).toBe(CLAIM_EXPIRED_REASON);
          expect(item.claimExpiresAt).toBeUndefined();
        });
      });
    });

    it('does not touch another tenant expired claims', () => {
      withFakeClock(() => {
        const q = new InMemoryCompensationQueue({
          filePath: storePath('expiry-tenant'),
          claimTtlSeconds: 30,
        });
        runWithTenant('tenant-B', () => {
          q.enqueue(baseItem('b-expire', { tenantId: 'tenant-B' }));
          q.claimNext();
        });
        advance(30_001);
        runWithTenant('tenant-A', () => {
          expect(q.claimNext()).toBeNull();
        });
        runWithTenant('tenant-B', () => {
          expect(q.get('b-expire')?.status).toBe('in_progress');
        });
      });
    });

    it('a live claim is not stolen by another claimer', () => {
      withFakeClock(() => {
        runWithTenant('tenant-A', () => {
          const q = new InMemoryCompensationQueue({
            filePath: storePath('live'),
            claimTtlSeconds: 30,
          });
          q.enqueue(baseItem('item-live'));
          expect(q.claimNext()).not.toBeNull();
          advance(1_000);
          expect(q.claimNext()).toBeNull();
          expect(q.get('item-live')?.status).toBe('in_progress');
        });
      });
    });
  });

  // ─── 8. Crash recovery via shared filePath ────────────────────────────────

  describe('crash recovery via shared filePath', () => {
    it('a fresh instance with the same filePath observes the prior items', () => {
      const filePath = storePath('crash-shared');
      runWithTenant('tenant-A', () => {
        const first = new InMemoryCompensationQueue({ filePath });
        first.enqueue(baseItem('item-survive', { tenantId: 'tenant-A' }));
        first.close();
      });
      runWithTenant('tenant-A', () => {
        const second = new InMemoryCompensationQueue({ filePath });
        expect(second.list().map((i) => i.id)).toContain('item-survive');
        second.close();
      });
    });

    it('a fresh instance with a different filePath sees an empty queue', () => {
      runWithTenant('tenant-A', () => {
        const q1 = new InMemoryCompensationQueue({ filePath: storePath('crash-A') });
        q1.enqueue(baseItem('only-A', { tenantId: 'tenant-A' }));
        q1.close();
        const q2 = new InMemoryCompensationQueue({ filePath: storePath('crash-B') });
        expect(q2.list()).toEqual([]);
        q2.close();
      });
    });

    it('the default :memory: store is private per instance (SQLite parity)', () => {
      runWithTenant('tenant-A', () => {
        const a = new InMemoryCompensationQueue();
        a.enqueue(baseItem('only-private', { tenantId: 'tenant-A' }));
        const b = new InMemoryCompensationQueue();
        expect(b.list()).toEqual([]);
      });
    });

    it('after a process kill the claimed work is auditable and never replayed', () => {
      withFakeClock(() => {
        const filePath = storePath('kill9');
        const claimed = runWithTenant('tenant-A', () => {
          const worker = new InMemoryCompensationQueue({ filePath, claimTtlSeconds: 30 });
          worker.enqueue(baseItem('item-killed', { tenantId: 'tenant-A' }));
          const c = worker.claimNext()!;
          // "Process kill": the handle closes while the claim is live.
          worker.close();
          return c;
        });
        expect(claimed.status).toBe('in_progress');

        runWithTenant('tenant-A', () => {
          const restarted = new InMemoryCompensationQueue({ filePath, claimTtlSeconds: 30 });
          // The claim is still live → no duplicate side effect (no replay).
          expect(restarted.claimNext()).toBeNull();
          advance(30_001);
          // Once the claim expires it is escalated for reconciliation, still
          // auditable, and still never replayed.
          expect(restarted.claimNext()).toBeNull();
          const item = restarted.get('item-killed')!;
          expect(item.status).toBe('escalated');
          expect(item.lastError).toBe(CLAIM_EXPIRED_REASON);
          expect(item.claimGeneration).toBe(1);
          expect(item.attemptCount).toBe(1);
          restarted.close();
        });
      });
    });
  });

  // ─── 9. close() fail-closed semantics ─────────────────────────────────────

  describe('close() fail-closed semantics', () => {
    it('refuses every operation after close', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('closed') });
        q.enqueue(baseItem('before-close', { tenantId: 'tenant-A' }));
        q.close();
        expect(() => q.enqueue(baseItem('after-close', { tenantId: 'tenant-A' }))).toThrow(
          /closed/,
        );
        expect(() => q.claimNext()).toThrow(/closed/);
        expect(() => q.list()).toThrow(/closed/);
        expect(() => q.get('before-close')).toThrow(/closed/);
        expect(() => q.countByStatus()).toThrow(/closed/);
        expect(() => q.getReceipt('before-close')).toThrow(/closed/);
        expect(() => q.retry('before-close', 'tenant-A')).toThrow(/closed/);
        expect(() =>
          q.markCompleted('before-close', { tenantId: 'tenant-A', claimGeneration: 1 }),
        ).toThrow(/closed/);
      });
    });
  });

  // ─── 10. list() filters ───────────────────────────────────────────────────

  describe('list() filtering and ordering', () => {
    it('filters by status', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('list-status') });
        q.enqueue(baseItem('p1', { tenantId: 'tenant-A' }));
        q.enqueue(baseItem('p2', { tenantId: 'tenant-A' }));
        const claimed = q.claimNext()!;
        q.markEscalated('p1', 'final', {
          tenantId: 'tenant-A',
          claimGeneration: claimed.claimGeneration,
        });
        expect(q.list({ status: 'pending' }).map((i) => i.id)).toEqual(['p2']);
        expect(q.list({ status: 'escalated' }).map((i) => i.id)).toEqual(['p1']);
      });
    });

    it('respects the limit option', () => {
      runWithTenant('tenant-A', () => {
        const q = new InMemoryCompensationQueue({ filePath: storePath('list-limit') });
        for (let i = 0; i < 5; i++) q.enqueue(baseItem(`p${i}`, { tenantId: 'tenant-A' }));
        expect(q.list({ limit: 3 })).toHaveLength(3);
      });
    });
  });
});

/**
 * AR-03 parity: the durable SQLite queue must enforce the same ownership
 * contract as the double above. These run against a real SQLite file; the
 * suite skips (loudly, via describe.skipIf) when the native binding is not
 * available for this Node ABI.
 */
describe.skipIf(!sqliteAvailable)('SQLite CompensationQueue — parity contract', () => {
  let dir: string;

  const openSqlite = (overrides: Record<string, unknown> = {}) =>
    new CompensationQueue({
      filePath: join(dir, `q-${++storeSeq}.db`),
      ...overrides,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'commander-compq-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('claims a pending item with a claim generation, expiry and tenant binding', () => {
    runWithTenant('tenant-A', () => {
      const q = openSqlite();
      try {
        q.enqueue(baseItem('sql-1', { tenantId: 'tenant-A' }));
        const claimed = q.claimNext()!;
        expect(claimed.status).toBe('in_progress');
        expect(claimed.tenantId).toBe('tenant-A');
        expect(claimed.attemptCount).toBe(1);
        expect(claimed.claimGeneration).toBe(1);
        expect(new Date(claimed.claimExpiresAt!).getTime()).toBeGreaterThan(Date.now());
      } finally {
        q.close();
      }
    });
  });

  it('raises on a duplicate enqueue (PRIMARY KEY)', () => {
    runWithTenant('tenant-A', () => {
      const q = openSqlite();
      try {
        q.enqueue(baseItem('sql-dup', { tenantId: 'tenant-A' }));
        expect(() => q.enqueue(baseItem('sql-dup', { tenantId: 'tenant-A' }))).toThrow();
        expect(q.list()).toHaveLength(1);
      } finally {
        q.close();
      }
    });
  });

  it('refuses enqueue without an authenticated tenant context', () => {
    const q = openSqlite();
    try {
      expect(() => q.enqueue(baseItem('sql-notenant', { tenantId: 'tenant-A' }))).toThrow(
        /authenticated tenant/,
      );
      expect(q.list()).toEqual([]);
    } finally {
      q.close();
    }
  });

  it('no tenant context returns no rows (no implicit admin)', () => {
    const q = openSqlite();
    try {
      runWithTenant('tenant-A', () =>
        q.enqueue(baseItem('sql-nocontext', { tenantId: 'tenant-A' })),
      );
      expect(q.list()).toEqual([]);
      expect(q.get('sql-nocontext')).toBeNull();
      expect(q.claimNext()).toBeNull();
      expect(q.countByStatus()).toEqual({ pending: 0, in_progress: 0, escalated: 0 });
    } finally {
      q.close();
    }
  });

  it('tenant A cannot complete, escalate, retry or fail tenant B work', () => {
    const q = openSqlite();
    try {
      runWithTenant('tenant-B', () => {
        q.enqueue(baseItem('sql-b', { tenantId: 'tenant-B' }));
        q.claimNext();
      });
      runWithTenant('tenant-A', () => {
        expect(q.markCompleted('sql-b', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(false);
        expect(q.markEscalated('sql-b', 'no', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
          false,
        );
        expect(q.markFailed('sql-b', 'no', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
          'refused',
        );
        expect(q.retry('sql-b', 'tenant-A')).toBe(false);
      });
      runWithTenant('tenant-B', () => {
        expect(q.get('sql-b')?.status).toBe('in_progress');
        expect(q.retry('sql-b', 'tenant-B')).toBe(false); // not escalated
      });
    } finally {
      q.close();
    }
  });

  it('an old claim cannot mutate a newer claim', () => {
    withFakeClock(() => {
      runWithTenant('tenant-A', () => {
        const q = openSqlite({ backoffBaseMs: 1 });
        try {
          q.enqueue(baseItem('sql-cas', { tenantId: 'tenant-A', maxAttempts: 5 }));
          const first = q.claimNext()!;
          expect(first.claimGeneration).toBe(1);
          expect(
            q.markFailed('sql-cas', 'transient', { tenantId: 'tenant-A', claimGeneration: 1 }),
          ).toBe('pending');
          advance(2);
          const second = q.claimNext()!;
          expect(second.claimGeneration).toBe(2);
          expect(q.markCompleted('sql-cas', { tenantId: 'tenant-A', claimGeneration: 1 })).toBe(
            false,
          );
          expect(
            q.markFailed('sql-cas', 'stale', { tenantId: 'tenant-A', claimGeneration: 1 }),
          ).toBe('refused');
          expect(q.get('sql-cas')?.lastError).toBe('transient');
          expect(q.markCompleted('sql-cas', { tenantId: 'tenant-A', claimGeneration: 2 })).toBe(
            true,
          );
        } finally {
          q.close();
        }
      });
    });
  });

  it('expired claim is escalated for reconciliation, never replayed', () => {
    withFakeClock(() => {
      runWithTenant('tenant-A', () => {
        const q = openSqlite({ claimTtlSeconds: 30 });
        try {
          q.enqueue(baseItem('sql-expire', { tenantId: 'tenant-A' }));
          expect(q.claimNext()).not.toBeNull();
          advance(30_001);
          expect(q.claimNext()).toBeNull();
          const item = q.get('sql-expire')!;
          expect(item.status).toBe('escalated');
          expect(item.lastError).toBe(CLAIM_EXPIRED_REASON);
        } finally {
          q.close();
        }
      });
    });
  });

  it('completion keeps a receipt and is idempotent', () => {
    runWithTenant('tenant-A', () => {
      const q = openSqlite();
      try {
        q.enqueue(baseItem('sql-receipt', { tenantId: 'tenant-A' }));
        q.claimNext();
        const claim = { tenantId: 'tenant-A', claimGeneration: 1 };
        expect(q.markCompleted('sql-receipt', claim)).toBe(true);
        expect(q.get('sql-receipt')).toBeNull();
        expect(q.getReceipt('sql-receipt')?.claimGeneration).toBe(1);
        expect(q.markCompleted('sql-receipt', claim)).toBe(true);
        expect(q.getReceipt('sql-receipt')).not.toBeNull();
      } finally {
        q.close();
      }
    });
  });

  it('close releases handles and refuses later operations', () => {
    runWithTenant('tenant-A', () => {
      const q = openSqlite();
      q.enqueue(baseItem('sql-closed', { tenantId: 'tenant-A' }));
      q.close();
      expect(() => q.enqueue(baseItem('sql-closed-2', { tenantId: 'tenant-A' }))).toThrow(/closed/);
      expect(() => q.claimNext()).toThrow(/closed/);
      expect(() => q.list()).toThrow(/closed/);
      expect(() => q.get('sql-closed')).toThrow(/closed/);
      expect(() => q.countByStatus()).toThrow(/closed/);
      expect(() =>
        q.markCompleted('sql-closed', { tenantId: 'tenant-A', claimGeneration: 1 }),
      ).toThrow(/closed/);
    });
  });
});
