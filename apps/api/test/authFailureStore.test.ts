import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SqlClient, SqlPool } from '@commander/kernel';
import {
  PostgresAuthFailureStore,
  createAuthFailureStore,
} from '../src/authFailureStore.js';

function createPoolHarness(): { pool: SqlPool; queries: Array<{ sql: string; values: readonly unknown[] }> } {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client: SqlClient = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      if (sql.startsWith('SELECT')) return { rows: [] as T[], rowCount: 0 };
      return {
        rows: [{ count: 1, firstFailureAt: 100, lastFailureAt: 100, lockedUntil: 0 }] as T[],
        rowCount: 1,
      };
    },
    release() {},
  };
  return { queries, pool: { connect: async () => client } };
}

describe('PostgreSQL auth-failure authority', () => {
  it('requires the commander_app PostgreSQL authority with no development fallback', () => {
    assert.throws(() => createAuthFailureStore({ environment: {} }), /AUTH_FAILURE_DATABASE_URL_REQUIRED/);
    assert.throws(
      () => createAuthFailureStore({ environment: { DATABASE_URL: 'postgresql://postgres:secret@db.example.test/commander' } }),
      /AUTH_FAILURE_DATABASE_ROLE_INVALID/,
    );
  });

  it('uses one conditional PostgreSQL upsert to record and lock failures', async () => {
    const harness = createPoolHarness();
    const store = new PostgresAuthFailureStore(harness.pool);
    await store.recordFailure('127.0.0.1', 100, 5, 60_000, 300_000);

    assert.equal(harness.queries.length, 1);
    assert.match(harness.queries[0].sql, /INSERT INTO commander_auth_failures/);
    assert.match(harness.queries[0].sql, /ON CONFLICT \(failure_key\) DO UPDATE/);
    assert.match(harness.queries[0].sql, /CASE WHEN commander_auth_failures\.last_failure_at/);
    assert.match(harness.queries[0].sql, /locked_until/);
  });

  it('locks the initial failure when the configured threshold is one', async () => {
    const harness = createPoolHarness();
    const store = new PostgresAuthFailureStore(harness.pool);
    await store.recordFailure('127.0.0.1', 100, 1, 60_000, 300_000);

    assert.match(harness.queries[0].sql, /CASE WHEN \$4 <= 1 THEN to_timestamp\(\(\$2 \+ \$5\) \/ 1000\.0\)/);
  });
});
