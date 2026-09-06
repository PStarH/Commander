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
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });

  it('fails startup for COMMANDER_ENV=production without a DSN (multi-signal)', async () => {
    assert.throws(
      () => createAuthFailureStore({ environment: { COMMANDER_ENV: 'production' } }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });

  it('never selects Redis, even if AUTH_FAILURE_REDIS_URL is set', async () => {
    assert.throws(
      () =>
        createAuthFailureStore({
          environment: { NODE_ENV: 'production', AUTH_FAILURE_REDIS_URL: 'redis://legacy' },
        }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });

  it('fails closed outside production without a DSN', async () => {
    assert.throws(
      () => createAuthFailureStore({ environment: { NODE_ENV: 'test' } }),
      /AUTH_DATABASE_URL_REQUIRED/,
    );
  });
});
