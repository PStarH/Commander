/**
 * AUDIT-E1: authority-selection policy tests. Redis has been removed entirely
 * (no-Redis-auth-fallback policy); fine-grained SQL behaviour is covered by
 * authFailureAuthority.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuthFailureStore } from '../src/authFailureStore.js';

describe('AuthFailureStore authority selection (PostgreSQL policy)', () => {
  it('fails production startup when no PostgreSQL DSN is configured', () => {
    assert.throws(
      () => createAuthFailureStore({ environment: { NODE_ENV: 'production' } }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });

  it('fails startup for COMMANDER_ENV=production without a DSN (multi-signal)', () => {
    assert.throws(
      () => createAuthFailureStore({ environment: { COMMANDER_ENV: 'production' } }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });

  it('never selects Redis, even if AUTH_FAILURE_REDIS_URL is set', () => {
    assert.throws(
      () =>
        createAuthFailureStore({
          environment: { NODE_ENV: 'production', AUTH_FAILURE_REDIS_URL: 'redis://legacy' },
        }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });

  it('fails closed outside production without a DSN', () => {
    assert.throws(
      () => createAuthFailureStore({ environment: { NODE_ENV: 'test' } }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });
});

/**
 * F-A-23: the four cases above are synchronous `assert.throws` checks on
 * construction. The store's own contract is async, so pin it against a stub
 * pool: the failure count and lockout window must reach the caller.
 */
class StubClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
  constructor(private readonly rows: Array<Record<string, unknown>>) {}
  async query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, values });
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
  async release(): Promise<void> {}
}

it('recordFailure returns the persisted count and lockout from PostgreSQL', async () => {
  const now = 1_700_000_000_000;
  const client = new StubClient([
    { count: 5, firstFailureAt: now, lastFailureAt: now, lockedUntil: now + 300_000 },
  ]);
  const { PostgresAuthFailureStore } = await import('../src/authFailureStore.js');
  const store = new PostgresAuthFailureStore({ connect: async () => client } as never);

  const entry = await store.recordFailure('1.2.3.4', now, 5, 60_000, 300_000);
  assert.equal(entry.count, 5);
  assert.equal(entry.lockedUntil, now + 300_000);
  assert.equal(client.calls.length, 1);
  assert.match(client.calls[0]!.sql, /INSERT INTO commander_auth_failures/);
  assert.deepEqual(client.calls[0]!.values, ['1.2.3.4', now, 60_000, 5, 300_000]);
});

it('recordFailure fails closed when PostgreSQL returns no row', async () => {
  const client = new StubClient([]);
  const { PostgresAuthFailureStore } = await import('../src/authFailureStore.js');
  const store = new PostgresAuthFailureStore({ connect: async () => client } as never);

  await assert.rejects(
    () => store.recordFailure('1.2.3.4', 1, 5, 60_000, 300_000),
    /AUTH_FAILURE_RECORD_MISSING/,
  );
});
