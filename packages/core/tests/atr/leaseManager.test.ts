// LeaseManager tests — P0-2 ATR kernel component (process fencing).

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LeaseManager } from '../../src/atr/leaseManager';

const nodeRequire = createRequire(import.meta.url);
const LEASE_MANAGER_URL = new URL('../../src/atr/leaseManager.ts', import.meta.url).href;
const TSX_LOADER_URL = pathToFileURL(nodeRequire.resolve('tsx')).href;
const RACE_WORKERS = 6;
const RACE_ROUNDS = 4;
const RACE_INTERVAL_MS = 350;
const RACE_LEAD_MS = 2500;

function newManager(ttlSeconds = 30): LeaseManager {
  return new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: ttlSeconds,
    defaultHolder: 'test',
  });
}

function newFileManager(dbPath: string, ttlSeconds = 30): LeaseManager {
  return new LeaseManager({
    filePath: dbPath,
    defaultTtlSeconds: ttlSeconds,
    defaultHolder: 'test',
  });
}

function tempLeaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'commander-lease-'));
}

/** Insert a lease row directly so a test can pin expires_at to an exact instant. */
function seedLeaseRow(
  dbPath: string,
  row: { runId: string; tenantId: string | null; token: string; epoch: number; expiresAt: string },
): void {
  const Database = nodeRequire('better-sqlite3');
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO leases
         (run_id, tenant_id, token, fencing_epoch, acquired_at, expires_at, holder)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.runId,
      row.tenantId,
      row.token,
      row.epoch,
      new Date().toISOString(),
      row.expiresAt,
      'seed',
    );
  } finally {
    db.close();
  }
}

interface RaceOutcome {
  round: number;
  acquired: boolean;
  reclaimed: boolean;
  epoch: number;
}

/**
 * Spawn `RACE_WORKERS` OS processes that acquire the same runIds on a shared
 * wall-clock schedule. Two calls on one event loop cannot expose the
 * SELECT-then-write window that AL-01 is about, so the race needs real
 * processes; the SQLite file is the only shared state.
 */
function runAcquireRace(opts: {
  dbPath: string;
  runIds: string[];
  tenantId: string | null;
}): Promise<RaceOutcome[][]> {
  const baseStart = Date.now() + RACE_LEAD_MS;
  const source = `
const { LeaseManager } = await import(${JSON.stringify(LEASE_MANAGER_URL)});
const lm = new LeaseManager({
  filePath: ${JSON.stringify(opts.dbPath)},
  defaultTtlSeconds: 30,
  defaultHolder: 'race-' + process.pid,
});
const runIds = ${JSON.stringify(opts.runIds)};
const base = ${baseStart};
const interval = ${RACE_INTERVAL_MS};
for (let round = 0; round < runIds.length; round++) {
  while (Date.now() < base + round * interval) {}
  const r = lm.acquire(runIds[round], { tenantId: ${JSON.stringify(opts.tenantId)} });
  process.stdout.write('RACE_RESULT:' + JSON.stringify({
    round,
    acquired: r.acquired,
    reclaimed: r.reclaimed === true,
    epoch: r.lease.fencingEpoch,
  }) + '\\n');
}
lm.close();
`;
  return new Promise((resolve, reject) => {
    const results: RaceOutcome[][] = Array.from({ length: RACE_WORKERS }, () => []);
    let pending = RACE_WORKERS;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    for (let i = 0; i < RACE_WORKERS; i++) {
      const child = spawn(
        process.execPath,
        ['--import', TSX_LOADER_URL, '--input-type=module', '-e', source],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', fail);
      child.on('close', (code) => {
        if (code !== 0) {
          fail(new Error(`race worker ${i} exited with ${code}: ${stderr}`));
          return;
        }
        try {
          for (const line of stdout.split('\n')) {
            if (line.startsWith('RACE_RESULT:')) {
              results[i].push(JSON.parse(line.slice('RACE_RESULT:'.length)) as RaceOutcome);
            }
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        pending -= 1;
        if (pending === 0) {
          settled = true;
          resolve(results);
        }
      });
    }
  });
}

function winnersByRound(results: RaceOutcome[][]): number[] {
  const counts = new Array<number>(RACE_ROUNDS).fill(0);
  for (const worker of results) {
    for (const outcome of worker) {
      if (outcome.acquired) counts[outcome.round] += 1;
    }
  }
  return counts;
}

function assertAllRoundsReported(results: RaceOutcome[][]): void {
  for (const worker of results) {
    assert.strictEqual(worker.length, RACE_ROUNDS, 'every process must report every round');
  }
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

  // ── AL-01: atomic acquire ─────────────────────────────────────────────────
  describe('atomic acquire (AL-01)', () => {
    it('a second connection receives the current owner, not a fabricated lease', () => {
      const dir = tempLeaseDir();
      const dbPath = path.join(dir, 'leases.db');
      const a = newFileManager(dbPath);
      const b = newFileManager(dbPath);
      try {
        const winner = a.acquire('run-loser', { tenantId: 'tenant-a' });
        const loser = b.acquire('run-loser', { tenantId: 'tenant-a' });
        assert.strictEqual(winner.acquired, true);
        assert.strictEqual(
          loser.acquired,
          false,
          'the loser must not be told it acquired the lease',
        );
        assert.strictEqual(loser.lease.token, winner.lease.token);
        assert.strictEqual(loser.lease.fencingEpoch, winner.lease.fencingEpoch);
      } finally {
        a.close();
        b.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exactly one process wins the first acquire (non-null tenant)', async () => {
      const dir = tempLeaseDir();
      const dbPath = path.join(dir, 'leases.db');
      const warm = newFileManager(dbPath);
      warm.close();
      try {
        const runIds = Array.from({ length: RACE_ROUNDS }, (_, i) => `race-first-${i}`);
        const results = await runAcquireRace({ dbPath, runIds, tenantId: 'tenant-a' });
        assertAllRoundsReported(results);
        assert.deepStrictEqual(
          winnersByRound(results),
          new Array<number>(RACE_ROUNDS).fill(1),
          'exactly one of the racing processes may report acquired:true per round',
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exactly one process wins the first acquire for a NULL tenant (composite-key race)', async () => {
      const dir = tempLeaseDir();
      const dbPath = path.join(dir, 'leases.db');
      const warm = newFileManager(dbPath);
      warm.close();
      try {
        const runIds = Array.from({ length: RACE_ROUNDS }, (_, i) => `race-first-null-${i}`);
        const results = await runAcquireRace({ dbPath, runIds, tenantId: null });
        assertAllRoundsReported(results);
        assert.deepStrictEqual(
          winnersByRound(results),
          new Array<number>(RACE_ROUNDS).fill(1),
          'a nullable tenant key must still admit exactly one first acquirer',
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exactly one process reclaims a simultaneously-expired lease', async () => {
      const dir = tempLeaseDir();
      const dbPath = path.join(dir, 'leases.db');
      const runIds = Array.from({ length: RACE_ROUNDS }, (_, i) => `race-reclaim-${i}`);
      const seed = newFileManager(dbPath, 0);
      try {
        for (const runId of runIds) {
          // ttl 0 pins expires_at to "now": every worker observes it as expired.
          const seeded = seed.acquire(runId, { tenantId: null, ttlSeconds: 0 });
          assert.strictEqual(seeded.acquired, true);
        }
        seed.close();
        const results = await runAcquireRace({ dbPath, runIds, tenantId: null });
        assertAllRoundsReported(results);
        assert.deepStrictEqual(
          winnersByRound(results),
          new Array<number>(RACE_ROUNDS).fill(1),
          'exactly one of the racing processes may win the reclaim per round',
        );
      } finally {
        seed.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a second null-tenant lease row at the schema level', () => {
      const dir = tempLeaseDir();
      const dbPath = path.join(dir, 'leases.db');
      const owner = newFileManager(dbPath);
      try {
        assert.strictEqual(owner.acquire('run-null-unique').acquired, true);
        const Database = nodeRequire('better-sqlite3');
        const raw = new Database(dbPath);
        try {
          assert.throws(
            () =>
              raw
                .prepare(
                  `INSERT INTO leases
                     (run_id, tenant_id, token, fencing_epoch, acquired_at, expires_at, holder)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  'run-null-unique',
                  null,
                  'intruder-token',
                  1,
                  new Date().toISOString(),
                  new Date(Date.now() + 60000).toISOString(),
                  'intruder',
                ),
            /UNIQUE|constraint/i,
            'a second null-tenant row for the same run must violate the unique owner key',
          );
          const count = raw
            .prepare('SELECT COUNT(*) AS c FROM leases WHERE run_id = ? AND tenant_id IS NULL')
            .get('run-null-unique') as { c: number };
          assert.strictEqual(count.c, 1);
        } finally {
          raw.close();
        }
      } finally {
        owner.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── AL-01: expiry-aware heartbeat ─────────────────────────────────────────
  describe('heartbeat expiry guard (AL-01)', () => {
    it('rejects a heartbeat from an expired lease before any takeover', async () => {
      const short = newManager(1);
      try {
        const { lease } = short.acquire('run-hb-expired');
        await new Promise((r) => setTimeout(r, 1100));
        assert.strictEqual(
          short.heartbeat('run-hb-expired', lease.token),
          false,
          'an expired lease must not be resurrectable by its old holder',
        );
        assert.strictEqual(short.validate('run-hb-expired', lease.token, lease.fencingEpoch), null);
      } finally {
        short.close();
      }
    });

    it('rejects a heartbeat whose epoch does not match', () => {
      const { lease } = lm.acquire('run-hb-epoch');
      assert.strictEqual(
        lm.heartbeat('run-hb-epoch', lease.token, { epoch: lease.fencingEpoch + 1 }),
        false,
      );
      assert.strictEqual(
        lm.heartbeat('run-hb-epoch', lease.token, { epoch: lease.fencingEpoch }),
        true,
      );
    });

    it('rejects a stale heartbeat from the previous holder after a takeover', async () => {
      const short = newManager(1);
      try {
        const old = short.acquire('run-hb-stale').lease;
        await new Promise((r) => setTimeout(r, 1100));
        const fresh = short.acquire('run-hb-stale');
        assert.strictEqual(fresh.acquired, true);
        assert.strictEqual(fresh.reclaimed, true);
        assert.notStrictEqual(fresh.lease.token, old.token);
        assert.strictEqual(short.heartbeat('run-hb-stale', old.token), false);
        assert.strictEqual(short.heartbeat('run-hb-stale', fresh.lease.token), true);
        assert.strictEqual(short.validate('run-hb-stale', old.token, old.fencingEpoch), null);
        assert.ok(short.validate('run-hb-stale', fresh.lease.token, fresh.lease.fencingEpoch));
      } finally {
        short.close();
      }
    });

    it('fails closed at the expiry boundary while a live lease still refreshes', () => {
      const dir = tempLeaseDir();
      const dbPath = path.join(dir, 'leases.db');
      const manager = newFileManager(dbPath);
      const tenantId = 'tenant-boundary';
      try {
        const boundary = new Date().toISOString();
        seedLeaseRow(dbPath, {
          runId: 'run-boundary',
          tenantId,
          token: 'boundary-token',
          epoch: 1,
          expiresAt: boundary,
        });
        // expires_at > now is strict: a lease whose expiry equals the current
        // instant is already gone, so the heartbeat must fail closed.
        assert.strictEqual(
          manager.heartbeat('run-boundary', 'boundary-token', { tenantId }),
          false,
        );
        // expires_at <= now is inclusive: the same instant is reclaimable.
        const reclaim = manager.acquire('run-boundary', { tenantId });
        assert.strictEqual(reclaim.acquired, true);
        assert.strictEqual(reclaim.reclaimed, true);
        assert.strictEqual(reclaim.lease.fencingEpoch, 2);

        const live = new Date(Date.now() + 60000).toISOString();
        seedLeaseRow(dbPath, {
          runId: 'run-boundary-live',
          tenantId,
          token: 'live-token',
          epoch: 1,
          expiresAt: live,
        });
        assert.strictEqual(
          manager.heartbeat('run-boundary-live', 'live-token', { tenantId }),
          true,
        );
      } finally {
        manager.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── AL-01: epoch authority survives row deletion ──────────────────────────
  describe('monotonic epoch authority (AL-01)', () => {
    it('keeps the fencing epoch monotonic across release and re-acquire', () => {
      const first = lm.acquire('run-epoch-release');
      assert.strictEqual(first.lease.fencingEpoch, 1);
      assert.strictEqual(lm.release('run-epoch-release', first.lease.token), true);
      const second = lm.acquire('run-epoch-release');
      assert.strictEqual(second.acquired, true);
      assert.strictEqual(
        second.lease.fencingEpoch,
        first.lease.fencingEpoch + 1,
        'the epoch must not restart at 1 after the row is deleted',
      );
    });

    it('keeps the fencing epoch monotonic across evict and re-acquire', async () => {
      const short = newManager(1);
      try {
        const first = short.acquire('run-epoch-evict');
        await new Promise((r) => setTimeout(r, 1100));
        assert.strictEqual(short.evict(), 1);
        const second = short.acquire('run-epoch-evict');
        assert.strictEqual(second.acquired, true);
        assert.ok(
          second.lease.fencingEpoch > first.lease.fencingEpoch,
          `epoch must survive eviction (was ${first.lease.fencingEpoch}, got ${second.lease.fencingEpoch})`,
        );
      } finally {
        short.close();
      }
    });

    it('keeps epochs independent per tenant and monotonic for each', () => {
      const a1 = lm.acquire('run-epoch-tenant', { tenantId: 'tenant-a' });
      const b1 = lm.acquire('run-epoch-tenant', { tenantId: 'tenant-b' });
      assert.strictEqual(a1.lease.fencingEpoch, 1);
      assert.strictEqual(b1.lease.fencingEpoch, 1);
      assert.strictEqual(
        lm.release('run-epoch-tenant', a1.lease.token, { tenantId: 'tenant-a' }),
        true,
      );
      const a2 = lm.acquire('run-epoch-tenant', { tenantId: 'tenant-a' });
      const b2 = lm.acquire('run-epoch-tenant', { tenantId: 'tenant-b' });
      assert.strictEqual(a2.lease.fencingEpoch, 2, 'tenant A epoch advances');
      assert.strictEqual(b2.acquired, false, 'tenant B still holds its lease');
      assert.strictEqual(b2.lease.fencingEpoch, 1, 'tenant B epoch is unaffected');
    });
  });
});
