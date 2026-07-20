import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { adaptPostgresSqlToSqlite } from './sqlitePool.js';
import { PostgresKernelRepository } from './postgres.js';
import { SQLITE_KERNEL_SCHEMA_SQL } from './sqliteSchema.js';
import { SqliteKernelRepository } from './sqlite.js';

const postgresSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'postgres.ts'),
  'utf-8',
);

function extractMethodSql(methodName: string): string {
  const match = postgresSrc.match(new RegExp(`async ${methodName}\\([\\s\\S]*?\\` + '`([\\s\\S]*?)\\`'));
  assert.ok(match, `${methodName} SQL not found`);
  return match[1]!;
}

function extractSweepOutboxDlqBlock(): string {
  const block = postgresSrc.match(/async sweepOutboxDlq\([\s\S]*?^  async /m);
  assert.ok(block, 'sweepOutboxDlq block not found');
  return block![0];
}

function serializeSqliteTestValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function extractSweepSql(index: number): string {
  const matches = [...extractSweepOutboxDlqBlock().matchAll(/`([\s\S]*?)`/g)].filter(
    (m) => /^\s*(SELECT|INSERT|UPDATE|WITH)\b/i.test(m[1]!),
  );
  assert.ok(matches[index], `sweepOutboxDlq SQL template #${index} not found`);
  return matches[index]![1]!;
}

function assertBindAndRun(db: Database.Database, sql: string, values: unknown[]): void {
  const { sql: adapted, values: bound } = adaptPostgresSqlToSqlite(sql, values);
  assert.ok(!/RETURNING s\.\*/i.test(adapted), 'alias must not leak in RETURNING');
  assert.ok(!/interval\s+'/i.test(adapted), `bare interval must not remain: ${adapted}`);
  const placeholderCount = (adapted.match(/\?/g) ?? []).length;
  assert.equal(placeholderCount, bound.length, `? count (${placeholderCount}) !== bound.length (${bound.length}): ${adapted}`);
  const trimmed = adapted.trimStart().toUpperCase();
  const stmt = db.prepare(adapted);
  const serialized = bound.map(serializeSqliteTestValue);
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH') || /RETURNING/i.test(adapted)) {
    stmt.all(...serialized);
  } else {
    stmt.run(...serialized);
  }
}

describe('sqlitePool adaptPostgresSqlToSqlite', () => {
  const db = new Database(':memory:');
  db.exec(SQLITE_KERNEL_SCHEMA_SQL);

  it('H2a: reclaimExpiredLeases SQL prepares with RETURNING *', () => {
    const sql = extractMethodSql('reclaimExpiredLeases');
    assertBindAndRun(db, sql, [new Date().toISOString(), 100]);
  });

  it('H2b: retryOutbox SQL binds and runs without interval literals', () => {
    const sql = extractMethodSql('retryOutbox');
    const values = [new Date().toISOString(), '{}', 'msg-1', 'token-1'];
    assertBindAndRun(db, sql, values);
    const { sql: adapted, values: bound } = adaptPostgresSqlToSqlite(sql, values);
    assert.equal(bound.length, 4);
    assert.match(adapted, /strftime\('%Y-%m-%dT%H:%M:%fZ'/);
    db.prepare(
      `INSERT INTO commander_events (id, aggregate_type, aggregate_id, sequence, type, tenant_id, run_id, actor, schema_version, payload)
       VALUES ('evt-1','run','run-1',1,'test','tenant-1','run-1','test','v2','{}')`,
    ).run();
    db.prepare(
      `INSERT INTO commander_outbox (id, event_id, tenant_id, topic, key, payload, attempts, max_attempts, available_at, claim_token)
       VALUES ('msg-1','evt-1','tenant-1','topic-a','key-1','{}',1,5,datetime('now'),'token-1')`,
    ).run();
    const { sql: retrySql, values: retryBound } = adaptPostgresSqlToSqlite(sql, values);
    db.prepare(retrySql).run(...retryBound.map(serializeSqliteTestValue));
    const row = db.prepare(`SELECT available_at FROM commander_outbox WHERE id='msg-1'`).get() as {
      available_at: string;
    };
    assert.match(row.available_at, /T.*Z$/);
  });

  it('E6: claim outbox/reconcile Postgres CTE templates are native-only on SQLite', () => {
    for (const methodName of ['claimOutbox', 'claimOutboxByTopic', 'claimReconcileEffects'] as const) {
      const sql = extractMethodSql(methodName);
      assert.match(sql, /FROM candidate|UPDATE commander_outbox o|UPDATE commander_effects e/);
      assert.ok(
        SqliteKernelRepository.prototype[methodName] !== PostgresKernelRepository.prototype[methodName],
        `${methodName} must override inherited Postgres SQL`,
      );
    }
  });

  it('H2b: sweepOutboxDlq Q1 stale-claim filter SQL binds and runs', () => {
    assertBindAndRun(db, extractSweepSql(0), [50, new Date()]);
  });

  it('H2b: sweepOutboxDlq Q2 INSERT dlq SQL binds and runs', () => {
    const now = new Date().toISOString();
    assertBindAndRun(db, extractSweepSql(1), [
      'dlq-1', 'msg-1', 'evt-1', 'tenant-1', 'commander.compensation', 'key-1',
      '{}', 3, now,
    ]);
  });

  it('H2b: sweepOutboxDlq Q3 UPDATE moved_to_dlq SQL binds and runs', () => {
    assertBindAndRun(db, extractSweepSql(2), ['msg-1']);
  });

  it('H2b: sweepOutboxDlq Q4 backoff UPDATE SQL binds and runs', () => {
    const now = new Date();
    assertBindAndRun(db, extractSweepSql(3), [now, 50]);
    const { values: bound } = adaptPostgresSqlToSqlite(extractSweepSql(3), [now, 50]);
    assert.equal(bound.length, 3);
  });

  it('H3: expired lease heartbeat is rejected on same UTC day', async () => {
    const repo = new SqliteKernelRepository({ path: ':memory:', allowMemory: true, schedulerMode: true });
    await repo.initialize();
    repo.seedTestWorker('worker-1', ['tenant-a'], 1);
    await repo.createRun(
      {
        id: 'run-lease',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'policy',
        steps: [{ id: 'step-lease', kind: 'agent' }],
      },
      'gateway',
    );
    const claimed = await repo.claimNextStep({
      workerId: 'worker-1',
      workerGeneration: 1,
      tenantIds: ['tenant-a'],
      capabilities: ['agent', 'tool'],
      leaseTtlMs: 60_000,
    });
    assert.ok(claimed?.lease);
    const past = new Date();
    past.setUTCHours(past.getUTCHours() - 1);
    await repo.heartbeatStep(claimed!.id, 'tenant-a', claimed!.lease!, -3_600_000);
    const heartbeat = await repo.heartbeatStep(claimed!.id, 'tenant-a', claimed!.lease!, 60_000);
    assert.equal(heartbeat, null);
  });
});
