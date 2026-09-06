/**
 * AUDIT-K2 (api leg): production must refuse an ephemeral in-memory store
 * fallback instead of warning and continuing.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { assertDurableStoreConfigured, StoreBackendConfigError } from '../src/storeBackendGate';

describe('assertDurableStoreConfigured (AUDIT-K2)', () => {
  test('non-production without backend stays permissive (dev ergonomics)', () => {
    assert.doesNotThrow(() => assertDurableStoreConfigured({ NODE_ENV: 'test' }));
  });

  test('production without any backend refuses (baseline: warn-only fallback)', () => {
    // FAILING before the fix: startup continued with an in-memory store.
    assert.throws(
      () => assertDurableStoreConfigured({ NODE_ENV: 'production' }),
      StoreBackendConfigError,
    );
  });

  test('COMMANDER_ENV=production signal also refuses (not NODE_ENV-only)', () => {
    assert.throws(
      () => assertDurableStoreConfigured({ COMMANDER_ENV: 'production' }),
      StoreBackendConfigError,
    );
  });

  test('production with DATABASE_URL passes', () => {
    assert.doesNotThrow(() =>
      assertDurableStoreConfigured({ NODE_ENV: 'production', DATABASE_URL: 'postgres://db' }),
    );
  });

  test('production with API_STORE_BACKEND passes', () => {
    assert.doesNotThrow(() =>
      assertDurableStoreConfigured({ NODE_ENV: 'production', API_STORE_BACKEND: 'postgres' }),
    );
  });

  test('explicit ephemeral opt-out honoured in production', () => {
    assert.doesNotThrow(() =>
      assertDurableStoreConfigured({
        NODE_ENV: 'production',
        COMMANDER_ALLOW_MEMORY_STORE: '1',
      }),
    );
  });

  test('bogus opt-out value does not count', () => {
    assert.throws(() =>
      assertDurableStoreConfigured({
        NODE_ENV: 'production',
        COMMANDER_ALLOW_MEMORY_STORE: 'yes-please',
      }),
    );
  });
});
