/**
 * AUDIT-CORE2: in multi-tenant mode the file tools' safe root must fail
 * closed — a tenant without a configured workspacePath (or a contextless
 * caller) must never land on the shared global workspace root, where tenant
 * A can read and write tenant B's files.
 */
import { test, describe, before, after } from 'vitest';
import * as assert from 'node:assert/strict';
import { runWithTenant, setMultiTenantEnabled } from '../../src/runtime/tenantContext.js';
import {
  setGlobalTenantProvider,
  resetGlobalTenantProvider,
  type TenantProvider,
  type TenantConfig,
} from '../../src/runtime/tenantProvider.js';
import { getSafeRoot } from '../../src/tools/fileSystemTool.js';

class FakeProvider implements TenantProvider {
  constructor(private readonly configs: Map<string, TenantConfig>) {}
  getTenantConfig(tenantId: string): TenantConfig | undefined {
    return this.configs.get(tenantId);
  }
}

describe('getSafeRoot multi-tenant fail-closed (AUDIT-CORE2)', () => {
  before(() => {
    setMultiTenantEnabled(true);
    setGlobalTenantProvider(
      new FakeProvider(
        new Map([
          ['tenant-configured', { workspacePath: '/tmp/workspaces/tenant-configured' } as TenantConfig],
          // 'tenant-unconfigured' is a known tenant with no workspacePath — the hole.
        ]),
      ),
    );
  });
  after(() => {
    resetGlobalTenantProvider();
    setMultiTenantEnabled(false);
  });

  test('configured tenant stays scoped to its workspace', () => {
    const root = runWithTenant('tenant-configured', () => getSafeRoot());
    assert.equal(root, '/tmp/workspaces/tenant-configured');
  });

  test('known tenant WITHOUT workspacePath refuses instead of shared root (baseline hole)', () => {
    // FAILING before the fix: returned the global COMMANDER_WORKSPACE/cwd
    // shared by every tenant — direct cross-tenant file access.
    assert.throws(
      () => runWithTenant('tenant-unconfigured', () => getSafeRoot()),
      /No workspacePath configured/,
    );
  });

  test('contextless caller in multi-tenant mode refuses (no safe root)', () => {
    assert.throws(() => getSafeRoot(), /tenant context/i);
  });
});
