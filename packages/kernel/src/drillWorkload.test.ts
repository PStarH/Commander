import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveDrillTenantContextConfig } from './drillWorkload.js';

describe('DR drill tenant context configuration', () => {
  it('enables enforced tenant context only for the dedicated authority role', () => {
    assert.deepEqual(
      resolveDrillTenantContextConfig({
        COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
          'postgres://commander_tenant_authority:secret@localhost:55436/fixture',
        COMMANDER_APP_DATABASE_URL: 'postgres://commander_app:secret@localhost:55436/fixture',
      }),
      {
        authorityDatabaseUrl:
          'postgres://commander_tenant_authority:secret@localhost:55436/fixture',
        runtimeDatabaseUrl: 'postgres://commander_app:secret@localhost:55436/fixture',
        phase: 'enforce',
      },
    );
  });

  it('rejects a non-authority role instead of silently using it', () => {
    assert.throws(
      () =>
        resolveDrillTenantContextConfig({
          COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
            'postgres://commander_owner:secret@localhost:55436/fixture',
        }),
      /DRILL_TENANT_AUTHORITY_DATABASE_ROLE_INVALID/,
    );
  });

  it('rejects an authority context without a dedicated app runtime DSN', () => {
    assert.throws(
      () =>
        resolveDrillTenantContextConfig({
          COMMANDER_TENANT_AUTHORITY_DATABASE_URL:
            'postgres://commander_tenant_authority:secret@localhost:55436/fixture',
        }),
      /DRILL_APP_DATABASE_URL_REQUIRED/,
    );
  });

  // KB-05: a missing authority DSN must not silently produce a drill that never
  // exercises the enforced tenant-context path.
  it('fails closed when the tenant-authority DSN is absent', () => {
    assert.throws(
      () => resolveDrillTenantContextConfig({}),
      /DRILL_TENANT_AUTHORITY_DATABASE_URL_REQUIRED/,
    );
    assert.throws(
      () =>
        resolveDrillTenantContextConfig({
          COMMANDER_APP_DATABASE_URL: 'postgres://commander_app:x@h/d',
        }),
      /DRILL_TENANT_AUTHORITY_DATABASE_URL_REQUIRED/,
    );
  });

  it('accepts only an explicit opt-out phase when the authority DSN is absent', () => {
    assert.deepEqual(
      resolveDrillTenantContextConfig({ COMMANDER_DRILL_WITHOUT_TENANT_AUTHORITY: '1' }),
      {
        phase: 'without-tenant-context-authority',
      },
    );
  });
});
