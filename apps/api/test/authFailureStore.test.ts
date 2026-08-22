/**
 * AUDIT-E1: authority-selection policy tests. Redis has been removed entirely
 * (no-Redis-auth-fallback policy); fine-grained SQL behaviour is covered by
 * authFailureAuthority.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAuthFailureStore } from '../src/authFailureStore.js';

describe('AuthFailureStore authority selection (PostgreSQL policy)', () => {
  it('fails production startup when no PostgreSQL DSN is configured', async () => {
    assert.throws(
      () => createAuthFailureStore({ environment: { NODE_ENV: 'production' } }),
      /COMMANDER_AUTH_FAILURE_DATABASE_URL.*required in production/s,
    );
  });

  it('fails startup for COMMANDER_ENV=production without a DSN (multi-signal)', async () => {
    assert.throws(
      () => createAuthFailureStore({ environment: { COMMANDER_ENV: 'production' } }),
      /required in production/,
    );
  });

  it('never selects Redis, even if AUTH_FAILURE_REDIS_URL is set', async () => {
    assert.throws(
      () =>
        createAuthFailureStore({
          environment: { NODE_ENV: 'production', AUTH_FAILURE_REDIS_URL: 'redis://legacy' },
        }),
      /required in production/,
    );
  });

  it('uses the in-memory store only outside production without a DSN', async () => {
    const store = createAuthFailureStore({ environment: { NODE_ENV: 'test' } });
    await store.set('127.0.0.1', { count: 1, firstFailureAt: 1, lastFailureAt: 1, lockedUntil: 0 });
    const entry = await store.get('127.0.0.1');
    assert.equal(entry?.count, 1);
  });
});
