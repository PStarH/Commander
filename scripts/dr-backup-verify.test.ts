import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRestoreDatabaseUrl,
  computeRpoMs,
  queryRunCommittedAt,
  parseDatabaseUrl,
  resolveHonestyLevel,
  assertDistinctRestoreTarget,
  refuseSourceDestructiveRestore,
  sanitizeError,
  type DsnParts,
} from './dr-backup-verify.js';

describe('dr-backup-verify honesty', () => {
  it('parseDatabaseUrl extracts host/port/database', () => {
    const dsn = parseDatabaseUrl('postgres://user:pass@src.example.com:5432/commander');
    assert.equal(dsn.host, 'src.example.com');
    assert.equal(dsn.port, 5432);
    assert.equal(dsn.database, 'commander');
    assert.equal(dsn.user, 'user');
  });

  it('buildRestoreDatabaseUrl uses a different port than source', () => {
    const source = 'postgres://user:pass@localhost:5432/commander';
    const restore = buildRestoreDatabaseUrl(source, '5433');
    const src = parseDatabaseUrl(source);
    const rst = parseDatabaseUrl(restore);
    assert.notEqual(src.port, rst.port);
    assert.equal(rst.port, 5433);
  });

  it('assertDistinctRestoreTarget rejects same host:port:database', () => {
    const dsn: DsnParts = { host: 'localhost', port: 5432, database: 'commander', user: 'u', password: 'p' };
    assert.throws(() => assertDistinctRestoreTarget(dsn, { ...dsn }), /distinct restore/);
  });

  it('refuseSourceDestructiveRestore blocks restore when RST DSN equals source', () => {
    const dsn: DsnParts = { host: 'localhost', port: 5432, database: 'commander', user: 'u', password: 'p' };
    const reason = refuseSourceDestructiveRestore(dsn, { ...dsn });
    assert.match(reason ?? '', /distinct restore/);
  });

  it('refuseSourceDestructiveRestore allows distinct port restore target', () => {
    const source: DsnParts = { host: 'localhost', port: 5432, database: 'commander', user: 'u', password: 'p' };
    const restore: DsnParts = { host: 'localhost', port: 5433, database: 'commander_dr', user: 'u', password: 'p' };
    assert.equal(refuseSourceDestructiveRestore(source, restore), null);
  });

  it('assertDistinctRestoreTarget accepts different port', () => {
    const source: DsnParts = { host: 'localhost', port: 5432, database: 'commander', user: 'u', password: 'p' };
    const restore: DsnParts = { host: 'localhost', port: 5433, database: 'commander', user: 'u', password: 'p' };
    assert.doesNotThrow(() => assertDistinctRestoreTarget(source, restore));
  });

  it('computeRpoMs uses backup completion minus DB commit (can exceed target)', () => {
    const cutoff = new Date('2026-07-19T12:00:00.000Z');
    const lastCommitted = new Date('2026-07-19T11:58:30.000Z');
    const rpo = computeRpoMs(cutoff, lastCommitted);
    assert.equal(rpo, 90_000);
    assert.notEqual(rpo, 0);
    const stale = computeRpoMs(new Date('2026-07-19T12:10:00.000Z'), lastCommitted);
    assert.ok(stale > 5 * 60 * 1000, 'RPO must be able to exceed 5min target');
  });

  it('queryRunCommittedAt reads epoch ms from psql output', () => {
    const dsn: DsnParts = { host: 'localhost', port: 5432, database: 'commander', user: 'u', password: 'p' };
    const epochMs = '1718806710000';
    const committed = queryRunCommittedAt(dsn, 'run_test', (_d, _sql) => epochMs);
    assert.equal(committed.getTime(), Number(epochMs));
  });

  it('resolveHonestyLevel is DRAFT without independent restore', () => {
    assert.equal(resolveHonestyLevel({ independentRestore: false, sentinelVerified: false }), 'DRAFT');
  });

  it('resolveHonestyLevel is ENFORCED with restore + sentinel but no cell processes', () => {
    assert.equal(
      resolveHonestyLevel({ independentRestore: true, sentinelVerified: true, cellProcessesVerified: false }),
      'ENFORCED',
    );
  });

  it('resolveHonestyLevel is PROVEN only with full verification', () => {
    assert.equal(
      resolveHonestyLevel({
        independentRestore: true,
        sentinelVerified: true,
        cellProcessesVerified: true,
      }),
      'PROVEN',
    );
  });

  it('sanitizeError strips passwords and DSN fragments', () => {
    const secret = 'SecretPass_XYZ';
    const err = new Error(`Command failed: psql postgres://drill:${secret}@127.0.0.1:5432/db`);
    const cleaned = sanitizeError(err, [secret]);
    assert.ok(!cleaned.includes(secret));
    assert.ok(!cleaned.includes('postgres://'));
  });
});
