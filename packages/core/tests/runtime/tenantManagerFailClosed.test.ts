/**
 * AUDIT-CORE4/CORE5: unknown tenants fail closed in multi-tenant mode, and
 * threeLayerMemory cross-tenant guards use the effective tenant context.
 */
import { test, describe, beforeEach, afterEach } from 'vitest';
import * as assert from 'node:assert/strict';
import { setMultiTenantEnabled, runWithTenant } from '../../src/runtime/tenantContext.js';
import { TenantManager } from '../../src/runtime/tenantManager.js';
import { SimpleTenantProvider } from '../../src/runtime/tenantProvider.js';
import { ThreeLayerMemory } from '../../src/threeLayerMemory.js';

const emptyStores = {
  samplesStore: null,
  traceStore: null,
  checkpointer: null,
  memory: null,
  governor: null,
} as never;

describe('TenantManager.resolveTenantContext (AUDIT-CORE4)', () => {
  beforeEach(() => setMultiTenantEnabled(true));
  afterEach(() => setMultiTenantEnabled(false));

  test('unknown tenant is denied in multi-tenant mode (baseline: allowed → no limits)', () => {
    const mgr = new TenantManager();
    // FAILING before the fix: { allowed: true } with no rate/quota enforcement.
    const result = mgr.resolveTenantContext('tenant-spoofed', undefined, emptyStores);
    assert.equal(result.allowed, false);
    assert.match(result.error ?? '', /TENANT_NOT_PROVISIONED/);
  });

  test('missing tenant is denied in multi-tenant mode', () => {
    const mgr = new TenantManager();
    const result = mgr.resolveTenantContext(undefined, undefined, emptyStores);
    assert.equal(result.allowed, false);
    assert.match(result.error ?? '', /TENANT_REQUIRED/);
  });

  test('single-tenant mode stays permissive (no regression)', () => {
    setMultiTenantEnabled(false);
    const mgr = new TenantManager();
    const result = mgr.resolveTenantContext(undefined, undefined, emptyStores);
    assert.equal(result.allowed, true);
    setMultiTenantEnabled(true);
  });
});

describe('ThreeLayerMemory cross-tenant guards (AUDIT-CORE5)', () => {
  beforeEach(() => setMultiTenantEnabled(true));
  afterEach(() => setMultiTenantEnabled(false));

  test('ambient tenant cannot promote another tenant entry (baseline: guard inert)', () => {
    const mem = new ThreeLayerMemory();
    // Entry tagged tenant-b, stored via the same store.
    const entry = runWithTenant('tenant-b', () =>
      mem.add('tenant-b secret', 'working', 'ctx', 0.9, [], { tenantId: 'tenant-b' }),
    );
    assert.ok(entry && entry.id !== 'rejected');
    // tenant-a ambient context attempts promotion — the guard must fire on the
    // effective (ALS) tenant, not the never-set currentTenantId field.
    const promoted = runWithTenant('tenant-a', () => mem.promoteToLongTerm(entry.id));
    assert.equal(promoted, false, 'cross-tenant promotion must be denied');
  });
});

describe('SimpleTenantProvider workspace boundary fails closed (ET-03)', () => {
  const provider = () =>
    new SimpleTenantProvider([{ tenantId: 'alpha', workspacePath: '/srv/alpha' } as never]);

  test('an unknown tenant is denied every path', () => {
    // Baseline: `if (!config?.workspacePath) return true` allowed any tenant
    // any path, so an unconfigured enterprise runtime was wide open.
    assert.equal(provider().validateWorkspacePath('alpha', '/srv/alpha/file.txt'), true);
    assert.equal(provider().validateWorkspacePath('ghost', '/srv/alpha/file.txt'), false);
    assert.equal(provider().validateWorkspacePath('ghost', '/etc/passwd'), false);
  });

  test('a known tenant without a configured workspace is denied', () => {
    const p = new SimpleTenantProvider([{ tenantId: 'beta' } as never]);
    assert.equal(p.validateWorkspacePath('beta', '/srv/beta/file.txt'), false);
  });

  test('a configured tenant stays scoped to its own workspace', () => {
    const p = provider();
    assert.equal(p.validateWorkspacePath('alpha', '/srv/alpha'), true);
    assert.equal(p.validateWorkspacePath('alpha', '/srv/alpha/nested/file.txt'), true);
    assert.equal(p.validateWorkspacePath('alpha', '/srv/alphabet/file.txt'), false);
    assert.equal(p.validateWorkspacePath('alpha', '/srv/beta/file.txt'), false);
  });

  test('an empty provider denies everything (the enterprise wiring installs [])', () => {
    const p = new SimpleTenantProvider();
    assert.equal(p.validateWorkspacePath('any', '/anywhere'), false);
    assert.deepEqual(p.getKnownTenants(), []);
  });
});
