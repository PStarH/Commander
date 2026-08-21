import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SqlClient, SqlPool } from '@commander/kernel';
import {
  PostgresRateLimitStore,
  createRateLimitStoreFromEnvironment,
} from '../src/securityMiddleware.js';

function createPoolHarness(): { pool: SqlPool; queries: Array<{ sql: string; values: readonly unknown[] }> } {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client: SqlClient = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      return { rows: [{ count: 1, resetAt: Date.now() + 60_000 }] as T[], rowCount: 1 };
    },
    release() {},
  };
  return { queries, pool: { connect: async () => client } };
}

describe('PostgreSQL rate-limit authority', () => {
  it('requires the commander_app PostgreSQL authority without a local fallback', () => {
    assert.throws(() => createRateLimitStoreFromEnvironment({}), /RATE_LIMIT_DATABASE_URL_REQUIRED/);
  });

  it('increments every scope through a conditional PostgreSQL upsert', async () => {
    const harness = createPoolHarness();
    const store = new PostgresRateLimitStore(harness.pool);
    await store.consume('tenant:tenant-a:write', 60_000);

    assert.equal(harness.queries.length, 1);
    assert.match(harness.queries[0].sql, /INSERT INTO commander_auth_rate_limits/);
    assert.match(harness.queries[0].sql, /ON CONFLICT \(bucket_key\) DO UPDATE/);
    assert.match(harness.queries[0].sql, /CASE WHEN commander_auth_rate_limits\.reset_at <= clock_timestamp\(\)/);
  });
});
