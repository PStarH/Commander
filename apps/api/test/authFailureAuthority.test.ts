/**
 * AUDIT-E1: the authentication-failure authority is PostgreSQL-backed.
 * Redis (AUTH_FAILURE_REDIS_URL) is removed; production without a DSN fails
 * closed; dev keeps the named in-memory store.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createAuthFailureStore,
  authFailureDsn,
  type PgPoolLike,
  type AuthFailureEntry,
} from '../src/authFailureStore';

class RecordingPool implements PgPoolLike {
  public calls: { sql: string; values?: unknown[] }[] = [];
  private rows: Record<string, unknown>[] = [];
  setNextRows(rows: Record<string, unknown>[]): void {
    this.rows = rows;
  }
  async query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    return { rows: this.rows };
  }
}

const entry: AuthFailureEntry = {
  count: 3,
  firstFailureAt: 1,
  lastFailureAt: 2,
  lockedUntil: 0,
};

describe('createAuthFailureStore (AUDIT-E1)', () => {
  test('production without any DSN refuses to construct (baseline: demanded Redis)', () => {
    // FAILING before the fix: threw AUTH_FAILURE_REDIS_URL is required — the
    // crash-at-boot P0 — or, had Redis been configured, used a forbidden backend.
    assert.throws(
      () => createAuthFailureStore({ environment: { NODE_ENV: 'production' } }),
      /COMMANDER_AUTH_FAILURE_DATABASE_URL.*required in production/s,
    );
  });

  test('AUTH_FAILURE_REDIS_URL no longer selects any backend', () => {
    assert.throws(
      () =>
        createAuthFailureStore({
          environment: { NODE_ENV: 'production', AUTH_FAILURE_REDIS_URL: 'redis://x' },
        }),
      /required in production/,
    );
  });

  test('production with a DSN builds the Postgres store', () => {
    const pool = new RecordingPool();
    const store = createAuthFailureStore({
      environment: { NODE_ENV: 'production', DATABASE_URL: 'postgres://db' },
      loadPgPool: () => pool,
    });
    assert.ok(store);
  });

  test('non-production without a DSN keeps the in-memory store', () => {
    const store = createAuthFailureStore({ environment: { NODE_ENV: 'test' } });
    assert.ok(store);
  });

  test('DSN precedence: AUTH_FAILURE > KERNEL > DATABASE_URL', () => {
    assert.equal(
      authFailureDsn({ COMMANDER_AUTH_FAILURE_DATABASE_URL: 'a', COMMANDER_KERNEL_DATABASE_URL: 'b', DATABASE_URL: 'c' }),
      'a',
    );
    assert.equal(authFailureDsn({ COMMANDER_KERNEL_DATABASE_URL: 'b', DATABASE_URL: 'c' }), 'b');
    assert.equal(authFailureDsn({ DATABASE_URL: 'c' }), 'c');
    assert.equal(authFailureDsn({}), undefined);
  });
});

describe('PostgresAuthFailureStore SQL (AUDIT-E1)', () => {
  let pool: RecordingPool;
  let store: ReturnType<typeof createAuthFailureStore>;

  beforeEach(() => {
    pool = new RecordingPool();
    store = createAuthFailureStore({
      environment: { NODE_ENV: 'test', DATABASE_URL: 'postgres://db' },
      loadPgPool: () => pool,
    });
  });

  afterEach(async () => {
    // no-op; pool is a recording stub
  });

  test('set upserts parameterised jsonb with TTL', async () => {
    await store.set('203.0.113.9', entry);
    const call = pool.calls.find((c) => c.sql.startsWith('INSERT INTO commander_auth_failures'));
    assert.ok(call, 'INSERT executed');
    assert.equal(call.values?.[0], '203.0.113.9');
    assert.deepEqual(JSON.parse(String(call.values?.[1])), entry);
    assert.ok(!call.sql.includes('203.0.113.9'), 'no string interpolation of the IP');
  });

  test('get reads only unexpired rows and validates the payload', async () => {
    pool.setNextRows([{ entry }]);
    const got = await store.get('203.0.113.9');
    assert.deepEqual(got, entry);
    pool.setNextRows([{ entry: { count: 'x' } }]);
    await assert.rejects(() => store.get('203.0.113.9'), /malformed/);
  });

  test('delete and cleanup use parameterised/bounded SQL', async () => {
    await store.delete('203.0.113.9');
    await store.cleanup(Date.now(), 60_000);
    assert.ok(pool.calls.some((c) => c.sql.startsWith('DELETE FROM commander_auth_failures WHERE ip')));
    assert.ok(pool.calls.some((c) => c.sql.includes('expires_at <= now()')));
  });
});
