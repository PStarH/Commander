/**
 * AUDIT-CORE3: store bucketing must fail closed in multi-tenant mode.
 * Contextless callers previously landed in the shared `__default__` bucket.
 */
import { test, describe, before, after } from 'vitest';
import * as assert from 'node:assert/strict';
import { setMultiTenantEnabled, runWithTenant } from '../../src/runtime/tenantContext.js';
import { tenantBucketOrThrow } from '../../src/runtime/tenantContext.js';

describe('tenantBucketOrThrow (AUDIT-CORE3)', () => {
  before(() => setMultiTenantEnabled(true));
  after(() => setMultiTenantEnabled(false));

  test('multi-tenant mode without context refuses the shared bucket', () => {
    // FAILING before the fix: returned '__default__' — contextless traffic
    // from any tenant mixed in one shared bucket.
    assert.throws(() => tenantBucketOrThrow(), /shared default bucket|Tenant context required/);
  });

  test('multi-tenant mode with context returns the bound tenant', () => {
    assert.equal(
      runWithTenant('tenant-a', () => tenantBucketOrThrow()),
      'tenant-a',
    );
  });

  test('single-tenant mode keeps the implicit default bucket', () => {
    setMultiTenantEnabled(false);
    assert.equal(tenantBucketOrThrow(), '__default__');
    setMultiTenantEnabled(true);
  });
});
