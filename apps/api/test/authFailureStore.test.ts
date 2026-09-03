import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuthFailureStore, type PgPoolLike } from '../src/authFailureStore.js';

const entry = { count: 2, firstFailureAt: 100, lastFailureAt: 200, lockedUntil: 300 };

describe('AuthFailureStore PostgreSQL authority', () => {
  it('requires a PostgreSQL DSN in production, regardless of Redis configuration', () => {
    assert.throws(
      () =>
        createAuthFailureStore({
          environment: { NODE_ENV: 'production', AUTH_FAILURE_REDIS_URL: 'redis://legacy' },
        }),
      /COMMANDER_AUTH_FAILURE_DATABASE_URL.*required in production/s,
    );
  });

  it('uses an injected PostgreSQL pool when a production DSN is configured', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const pool: PgPoolLike = {
      query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT')) return { rows: [{ entry }] };
        return { rows: [] };
      },
    };
    const store = createAuthFailureStore({
      environment: { NODE_ENV: 'production', DATABASE_URL: 'postgres://app@db/commander' },
      loadPgPool: async (dsn) => {
        assert.equal(dsn, 'postgres://app@db/commander');
        return pool;
      },
    });

    assert.deepEqual(await store.get('127.0.0.1'), entry);
    await store.set('127.0.0.1', entry);
    await store.delete('127.0.0.1');
    await store.cleanup(Date.now(), 60_000);
    assert.equal(queries.some(({ sql }) => sql.includes('commander_auth_failures')), true);
    assert.equal(
      queries.some(({ sql }) => sql.includes('INSERT INTO commander_auth_failures')),
      true,
    );
  });

  it('does not connect to PostgreSQL while the middleware module is being loaded', async () => {
    let loads = 0;
    const store = createAuthFailureStore({
      environment: { NODE_ENV: 'production', DATABASE_URL: 'postgres://app@db/commander' },
      loadPgPool: async () => {
        loads += 1;
        return { query: async () => ({ rows: [] }) };
      },
    });
    assert.equal(loads, 0);
    await store.get('127.0.0.1');
    assert.equal(loads, 1);
  });

  it('rejects malformed PostgreSQL entries', async () => {
    const store = createAuthFailureStore({
      environment: { NODE_ENV: 'production', DATABASE_URL: 'postgres://app@db/commander' },
      loadPgPool: async () => ({
        query: async (sql) =>
          sql.startsWith('SELECT') ? { rows: [{ entry: { count: 'bad' } }] } : { rows: [] },
      }),
    });
    await assert.rejects(
      () => store.get('127.0.0.1'),
      /Postgres auth failure entry is malformed/,
    );
  });

  it('uses process-local state only outside production without a DSN', async () => {
    const store = createAuthFailureStore({ environment: { NODE_ENV: 'test' } });
    await store.set('127.0.0.1', entry);
    assert.deepEqual(await store.get('127.0.0.1'), entry);
  });
});
