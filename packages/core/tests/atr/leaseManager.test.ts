// LeaseManager tests — P0-2 ATR kernel component (process fencing).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { LeaseManager } from '../../src/atr/leaseManager';

function newManager(ttlSeconds = 30): LeaseManager {
  return new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: ttlSeconds,
    defaultHolder: 'test',
  });
}

describe('LeaseManager', () => {
  let lm: LeaseManager;

  beforeEach(() => {
    lm = newManager();
  });

  describe('acquire', () => {
    it('grants a fresh lease on first acquire', () => {
      const r = lm.acquire('run-1');
      assert.strictEqual(r.acquired, true);
      assert.strictEqual(r.reclaimed, undefined);
      assert.strictEqual(r.lease.fencingEpoch, 1);
      assert.strictEqual(r.lease.runId, 'run-1');
      assert.ok(r.lease.token.length > 0);
    });

    it('returns existing lease on second acquire (not expired)', () => {
      const a = lm.acquire('run-2');
      const b = lm.acquire('run-2');
      assert.strictEqual(a.acquired, true);
      assert.strictEqual(b.acquired, false);
      assert.strictEqual(b.lease.token, a.lease.token);
      assert.strictEqual(b.lease.fencingEpoch, 1);
    });

    it('reclaims expired lease with bumped epoch', () => {
      const short = newManager(1);
      const a = short.acquire('run-3');
      const wait = new Promise((r) => setTimeout(r, 1100));
      return wait.then(() => {
        const b = short.acquire('run-3');
        assert.strictEqual(b.acquired, true);
        assert.strictEqual(b.reclaimed, true);
        assert.strictEqual(b.lease.fencingEpoch, 2);
        assert.notStrictEqual(b.lease.token, a.lease.token);
        short.close();
      });
    });
  });

  describe('heartbeat', () => {
    it('refreshes expiry for correct token', () => {
      const { lease } = lm.acquire('run-4');
      const ok = lm.heartbeat('run-4', lease.token);
      assert.strictEqual(ok, true);
    });

    it('rejects heartbeat for wrong token (fenced)', () => {
      lm.acquire('run-5');
      const ok = lm.heartbeat('run-5', 'wrong-token');
      assert.strictEqual(ok, false);
    });

    it('rejects heartbeat for evicted run', () => {
      const ok = lm.heartbeat('never-acquired', 'any-token');
      assert.strictEqual(ok, false);
    });
  });

  describe('release', () => {
    it('releases the lease for the correct token', () => {
      const { lease } = lm.acquire('run-6');
      const ok = lm.release('run-6', lease.token);
      assert.strictEqual(ok, true);
      assert.strictEqual(lm.get('run-6'), null);
    });

    it('rejects release for wrong token', () => {
      lm.acquire('run-7');
      const ok = lm.release('run-7', 'wrong-token');
      assert.strictEqual(ok, false);
      assert.notStrictEqual(lm.get('run-7'), null);
    });
  });

  describe('validate (fencing)', () => {
    it('returns the lease for correct token+epoch', () => {
      const { lease } = lm.acquire('run-8');
      const v = lm.validate('run-8', lease.token, lease.fencingEpoch);
      assert.ok(v);
      assert.strictEqual(v!.token, lease.token);
    });

    it('returns null for stale epoch (zombie fenced)', () => {
      const { lease } = lm.acquire('run-9');
      const v = lm.validate('run-9', lease.token, lease.fencingEpoch - 1);
      assert.strictEqual(v, null);
    });

    it('returns null for wrong token', () => {
      const { lease } = lm.acquire('run-10');
      const v = lm.validate('run-10', 'wrong', lease.fencingEpoch);
      assert.strictEqual(v, null);
    });

    it('returns null for missing run', () => {
      const v = lm.validate('never-acquired', 'any', 1);
      assert.strictEqual(v, null);
    });
  });

  describe('tenant isolation', () => {
    it('separate tenants have independent leases for the same runId', () => {
      const a = lm.acquire('run-shared', { tenantId: 'tenant-a' });
      const b = lm.acquire('run-shared', { tenantId: 'tenant-b' });
      assert.strictEqual(a.acquired, true);
      assert.strictEqual(b.acquired, true);
      assert.notStrictEqual(a.lease.token, b.lease.token);
    });

    it('cross-tenant release fails', () => {
      const a = lm.acquire('run-shared-2', { tenantId: 'tenant-a' });
      const ok = lm.release('run-shared-2', a.lease.token, { tenantId: 'tenant-b' });
      assert.strictEqual(ok, false);
      assert.notStrictEqual(lm.get('run-shared-2', { tenantId: 'tenant-a' }), null);
    });
  });

  describe('evict', () => {
    it('removes expired leases', () => {
      const short = newManager(1);
      short.acquire('exp-1');
      short.acquire('exp-2');
      return new Promise((r) => setTimeout(r, 1100)).then(() => {
        const n = short.evict();
        assert.strictEqual(n, 2);
        short.close();
      });
    });
  });
});
