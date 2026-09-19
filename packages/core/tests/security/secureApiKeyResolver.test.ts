/**
 * SecureApiKeyResolver tenant-fallback tests.
 *
 * A tenant secret the vault cannot resolve is *unconfigured*. In multi-tenant
 * mode the environment variable is a single process-wide value shared by every
 * tenant, so falling back to it would hand one tenant another tenant's
 * credential. That path must fail closed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  initSecureApiKeyResolver,
  resolveSecureApiKey,
} from '../../src/security/secureApiKeyResolver';
import { setMultiTenantEnabled, runWithTenant } from '../../src/runtime/tenantContext';

const ENV_VAR = 'COMMANDER_TEST_TENANT_SHARED_KEY';

describe('SecureApiKeyResolver multi-tenant env fallback', () => {
  beforeEach(() => {
    delete process.env[ENV_VAR];
    setMultiTenantEnabled(false);
    initSecureApiKeyResolver(null);
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
    setMultiTenantEnabled(false);
    initSecureApiKeyResolver(null);
  });

  it('refuses the shared env-var fallback when multi-tenant mode is enabled', () => {
    process.env[ENV_VAR] = 'shared-platform-secret';
    setMultiTenantEnabled(true);
    // Vault resolves nothing for this tenant.
    initSecureApiKeyResolver({
      hasSecret: () => false,
      getSecret: () => null,
    });

    assert.equal(
      runWithTenant('tenant-a', () => resolveSecureApiKey(ENV_VAR)),
      '',
    );
  });

  it('refuses the env-var fallback even when the tenant vault lookup throws', () => {
    process.env[ENV_VAR] = 'shared-platform-secret';
    setMultiTenantEnabled(true);
    initSecureApiKeyResolver({
      hasSecret: () => true,
      getSecret: () => {
        throw new Error('tenant vault unavailable');
      },
    });

    assert.equal(
      runWithTenant('tenant-a', () => resolveSecureApiKey(ENV_VAR)),
      '',
    );
  });

  it('still returns a tenant vault secret in multi-tenant mode', () => {
    process.env[ENV_VAR] = 'shared-platform-secret';
    setMultiTenantEnabled(true);
    initSecureApiKeyResolver({
      hasSecret: () => true,
      getSecret: () => 'tenant-scoped-secret',
    });

    assert.equal(resolveSecureApiKey(ENV_VAR), 'tenant-scoped-secret');
  });

  it('keeps the env-var fallback in single-tenant mode', () => {
    process.env[ENV_VAR] = 'single-tenant-dev-secret';
    setMultiTenantEnabled(false);
    initSecureApiKeyResolver({
      hasSecret: () => false,
      getSecret: () => null,
    });

    assert.equal(resolveSecureApiKey(ENV_VAR), 'single-tenant-dev-secret');
  });
});
