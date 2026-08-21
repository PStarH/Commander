import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SqlClient, SqlPool } from '@commander/kernel';
import {
  PostgresRateLimitStore,
  createRateLimitStoreFromEnvironment,
} from '../src/securityMiddleware.js';

function createPoolHarness(failBucketKey?: string): {
  pool: SqlPool;
  entries: Map<string, number>;
  queries: Array<{ sql: string; values: readonly unknown[] }>;
} {
  const entries = new Map<string, number>();
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  let transactionEntries: Map<string, number> | undefined;
  const client: SqlClient = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      if (sql === 'BEGIN') {
        transactionEntries = new Map(entries);
        return { rows: [] as T[], rowCount: null };
      }
      if (sql === 'ROLLBACK') {
        entries.clear();
        for (const [bucketKey, count] of transactionEntries ?? []) entries.set(bucketKey, count);
        return { rows: [] as T[], rowCount: null };
      }
      if (sql === 'COMMIT') return { rows: [] as T[], rowCount: null };

      const bucketKey = values[0];
      if (bucketKey === failBucketKey) throw new Error('SECOND_SCOPE_FAILURE');
      if (typeof bucketKey !== 'string') throw new Error('RATE_LIMIT_BUCKET_INVALID');
      const count = (entries.get(bucketKey) ?? 0) + 1;
      entries.set(bucketKey, count);
      return { rows: [{ count, resetAt: Date.now() + 60_000 }] as T[], rowCount: 1 };
    },
    release() {},
  };
  return { entries, queries, pool: { connect: async () => client } };
}

describe('PostgreSQL rate-limit authority', () => {
  it('requires the commander_app PostgreSQL authority without a local fallback', () => {
    assert.throws(() => createRateLimitStoreFromEnvironment({}), /RATE_LIMIT_DATABASE_URL_REQUIRED/);
  });

  it('increments every scope through a conditional PostgreSQL upsert', async () => {
    const harness = createPoolHarness();
    const store = new PostgresRateLimitStore(harness.pool);
    await store.consume([{ key: 'tenant:tenant-a:write', windowMs: 60_000 }]);

    assert.deepEqual(harness.queries.map(({ sql }) => sql), ['BEGIN', harness.queries[1].sql, 'COMMIT']);
    assert.match(harness.queries[1].sql, /INSERT INTO commander_auth_rate_limits/);
    assert.match(harness.queries[1].sql, /ON CONFLICT \(bucket_key\) DO UPDATE/);
    assert.match(harness.queries[1].sql, /CASE WHEN commander_auth_rate_limits\.reset_at <= clock_timestamp\(\)/);
  });

  it('rolls back prior scope consumption when a later scope fails', async () => {
    const harness = createPoolHarness('user:user-a:write');
    const store = new PostgresRateLimitStore(harness.pool);

    await assert.rejects(
      store.consume([
        { key: 'global:write', windowMs: 1_000 },
        { key: 'user:user-a:write', windowMs: 60_000 },
      ]),
      /SECOND_SCOPE_FAILURE/,
    );

    assert.equal(harness.entries.get('global:write'), undefined);
    assert.deepEqual(harness.queries.map(({ sql }) => sql), ['BEGIN', harness.queries[1].sql, harness.queries[2].sql, 'ROLLBACK']);
  });
});
