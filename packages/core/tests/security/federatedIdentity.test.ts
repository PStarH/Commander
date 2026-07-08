/**
 * FederatedIdentity — comprehensive tests for cross-org trust delegation.
 *
 * Uses a single shared FederatedIdentity instance with a deterministic HMAC key
 * so that issuer and audience share the same active trusts map (production
 * pattern via tenant-aware singleton).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  FederatedIdentity,
  getFederatedIdentity,
  resetFederatedIdentity,
  resolveFederationKey,
  resolveFederationOIDCKey,
  FEDERATION_KEY_ENV,
  FEDERATION_OIDC_KEY_ENV,
} from '../../src/security/federatedIdentity';
import type {
  FederationTrust,
  FederatedExchangeResult,
  ResourceScope,
} from '../../src/security/federatedIdentity';
import { runWithTenant } from '../../src/runtime/tenantContext';
import {
  setGlobalTenantProvider,
  SimpleTenantProvider,
  resetGlobalTenantProvider,
} from '../../src/runtime/tenantProvider';
import { resetCapabilityTokenState } from '../../src/security/capabilityToken';
import { resetAuditChainLedger } from '../../src/security/auditChainLedger';
import { resetAgentLineage } from '../../src/security/agentLineage';
import * as crypto from 'crypto';

// ============================================================================
// Constants
// ============================================================================

const ISSUER_TENANT = 'tenant-issuer';
const AUDIENCE_TENANT = 'tenant-audience';
const TEST_HMAC_KEY = crypto.createHash('sha256').update('test-key-32-chars-minimum!!!').digest();

function setupTenants() {
  setGlobalTenantProvider(
    new SimpleTenantProvider([
      {
        tenantId: ISSUER_TENANT,
        tokenBudget: 100000,
        maxConcurrency: 5,
        maxRunsPerMinute: 30,
        enabled: true,
      },
      {
        tenantId: AUDIENCE_TENANT,
        tokenBudget: 100000,
        maxConcurrency: 5,
        maxRunsPerMinute: 30,
        enabled: true,
      },
    ]),
  );
}

function fullReset() {
  resetFederatedIdentity();
  resetCapabilityTokenState();
  resetAuditChainLedger();
  resetAgentLineage();
  resetGlobalTenantProvider();
  delete process.env[FEDERATION_KEY_ENV];
  delete process.env[FEDERATION_OIDC_KEY_ENV];
}

beforeEach(() => {
  fullReset();
  setupTenants();
  process.env[FEDERATION_KEY_ENV] = 'test-federation-key-minimum-32-chars!!';
  process.env.NODE_ENV = 'test';
});

afterEach(() => fullReset());

// ============================================================================
// Helpers — single shared FI instance (production pattern)
// ============================================================================

/** Single FederatedIdentity instance with deterministic HMAC key. */
function fi(): FederatedIdentity {
  return new FederatedIdentity({ hmacKey: TEST_HMAC_KEY });
}

function issueTrust(
  f: FederatedIdentity,
  overrides: Partial<{
    audienceTenant: string;
    resourceScopes: ResourceScope[];
    ttlSeconds: number;
    maxDepth: number;
    trustId: string;
  }> = {},
): FederationTrust {
  return runWithTenant(ISSUER_TENANT, () =>
    f.issueTrust({
      audienceTenant: overrides.audienceTenant ?? AUDIENCE_TENANT,
      resourceScopes: overrides.resourceScopes ?? ['call:web_fetch', 'read:reports'],
      ttlSeconds: overrides.ttlSeconds ?? 3600,
      maxDepth: overrides.maxDepth ?? 1,
      trustId: overrides.trustId,
    }),
  );
}

function exchangeTrust(f: FederatedIdentity, trust: FederationTrust): FederatedExchangeResult {
  return runWithTenant(AUDIENCE_TENANT, () => {
    const result = f.exchange(JSON.stringify(trust));
    if (!result.accepted) {
      throw new Error(`Exchange rejected: ${result.reason} - ${result.detail ?? ''}`);
    }
    return result;
  });
}

// ============================================================================
// Trust Issuance
// ============================================================================

describe('FederatedIdentity - Trust Issuance', () => {
  it('should issue a federation trust with HMAC signature', () => {
    const f = fi();
    const trust = issueTrust(f);
    expect(trust.trustId).toBeTruthy();
    expect(trust.trustId.length).toBe(32);
    expect(trust.issuerTenant).toBe(ISSUER_TENANT);
    expect(trust.audienceTenant).toBe(AUDIENCE_TENANT);
    expect(trust.resourceScopes).toEqual(['call:web_fetch', 'read:reports']);
    expect(trust.maxDepth).toBe(1);
    expect(trust.expiresAt).toBeGreaterThan(trust.issuedAt);
    expect(trust.hmacSignature).toBeTruthy();
    expect(trust.hmacSignature.length).toBe(64);
  });

  it('should sort resourceScopes for canonical representation', () => {
    const f = fi();
    const trust = issueTrust(f, {
      resourceScopes: ['call:web_fetch', 'read:reports', 'call:file_read'],
    });
    expect(trust.resourceScopes).toEqual(['call:file_read', 'call:web_fetch', 'read:reports']);
  });

  it('should include metadata', () => {
    const f = fi();
    const trust = runWithTenant(ISSUER_TENANT, () =>
      f.issueTrust({
        audienceTenant: AUDIENCE_TENANT,
        resourceScopes: ['call:web_fetch'],
        metadata: { purpose: 'ci-pipeline' },
      }),
    );
    expect(trust.metadata).toEqual({ purpose: 'ci-pipeline' });
  });

  it('should throw without active tenant context', () => {
    const f = fi();
    expect(() => f.issueTrust({ audienceTenant: 'x', resourceScopes: ['call:web_fetch'] })).toThrow(
      'active tenant context',
    );
  });

  it('should throw with empty resourceScopes', () => {
    const f = fi();
    expect(() =>
      runWithTenant(ISSUER_TENANT, () =>
        f.issueTrust({ audienceTenant: AUDIENCE_TENANT, resourceScopes: [] }),
      ),
    ).toThrow('at least one entry');
  });

  it('should cap TTL at 86400 seconds', () => {
    const f = fi();
    const trust = issueTrust(f, { ttlSeconds: 999999 });
    expect(trust.expiresAt - trust.issuedAt).toBeLessThanOrEqual(86400);
  });

  it('should sign with OIDC JWT when private key configured', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const f = new FederatedIdentity({ hmacKey: TEST_HMAC_KEY, oidcPrivateKey: privateKey });
    const trust = issueTrust(f);

    expect(trust.jwtToken).toBeTruthy();
    expect(trust.jwtToken!.split('.').length).toBe(3);

    const parts = trust.jwtToken!.split('.');
    const sigB64 = parts[2]!.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (sigB64.length % 4)) % 4;
    const sig = Buffer.from(sigB64 + '='.repeat(pad), 'base64');
    const verified = crypto.verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf-8'),
      crypto.createPublicKey(publicKey),
      sig,
    );
    expect(verified).toBe(true);
  });
});

// ============================================================================
// Trust Exchange
// ============================================================================

describe('FederatedIdentity - Trust Exchange', () => {
  it('should exchange a valid trust for local agent identities', () => {
    const f = fi();
    const trust = issueTrust(f);
    const result = exchangeTrust(f, trust);

    expect(result.accepted).toBe(true);
    expect(result.agentId).toMatch(/^fed_tenant-issuer_/);
    expect(result.capabilityToken).toBeTruthy();
    expect(result.lineageInstanceId).toBeTruthy();
    expect(result.tokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(result.trust.trustId).toBe(trust.trustId);
  });

  it('should reject an expired trust', () => {
    const f = fi();
    const nowSec = Math.floor(Date.now() / 1000);
    const expired: FederationTrust = {
      trustId: crypto.randomUUID().replace(/-/g, ''),
      issuerTenant: ISSUER_TENANT,
      audienceTenant: AUDIENCE_TENANT,
      resourceScopes: ['call:web_fetch'],
      maxDepth: 1,
      issuedAt: nowSec - 7200,
      expiresAt: nowSec - 3600,
      hmacSignature: 'unused',
    };
    const outcome = runWithTenant(AUDIENCE_TENANT, () => f.exchange(JSON.stringify(expired)));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) {
      expect(['trust_expired', 'invalid_signature']).toContain(outcome.reason);
    }
  });

  it('should reject audience mismatch', () => {
    const f = fi();
    const trust = issueTrust(f, { audienceTenant: 'other-tenant' });
    const outcome = runWithTenant(AUDIENCE_TENANT, () => f.exchange(JSON.stringify(trust)));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('audience_mismatch');
  });

  it('should reject a revoked trust', () => {
    const f = fi();
    const trust = issueTrust(f);
    runWithTenant(ISSUER_TENANT, () => f.revokeTrust(trust.trustId, 'test-revoke'));
    const outcome = runWithTenant(AUDIENCE_TENANT, () => f.exchange(JSON.stringify(trust)));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('trust_revoked');
  });

  it('should reject invalid HMAC signature', () => {
    const f = fi();
    const trust = issueTrust(f);
    const tampered = { ...trust, resourceScopes: ['admin:*'] };
    const outcome = runWithTenant(AUDIENCE_TENANT, () => f.exchange(JSON.stringify(tampered)));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('invalid_signature');
  });

  it('should reject malformed JSON', () => {
    const f = fi();
    const outcome = runWithTenant(AUDIENCE_TENANT, () => f.exchange('not-json'));
    expect(outcome.accepted).toBe(false);
  });

  it('should reject without active tenant context', () => {
    const f = fi();
    const trust = issueTrust(f);
    const outcome = f.exchange(JSON.stringify(trust));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('audience_mismatch');
  });
});

// ============================================================================
// Scope Enforcement
// ============================================================================

describe('FederatedIdentity - Scope Enforcement', () => {
  it('should allow tool within call:* scope', () => {
    const f = fi();
    const trust = issueTrust(f, { resourceScopes: ['call:web_fetch'] });
    exchangeTrust(f, trust);
    expect(
      runWithTenant(AUDIENCE_TENANT, () => f.verifyFederationScope(trust.trustId, 'web_fetch')),
    ).toBe(true);
  });

  it('should deny tool outside call:* scope', () => {
    const f = fi();
    const trust = issueTrust(f, { resourceScopes: ['call:web_fetch'] });
    exchangeTrust(f, trust);
    expect(
      runWithTenant(AUDIENCE_TENANT, () => f.verifyFederationScope(trust.trustId, 'shell_execute')),
    ).toBe(false);
  });

  it('should allow read:* scope mapped to {resource}_read', () => {
    const f = fi();
    const trust = issueTrust(f, { resourceScopes: ['read:reports'] });
    exchangeTrust(f, trust);
    expect(
      runWithTenant(AUDIENCE_TENANT, () => f.verifyFederationScope(trust.trustId, 'reports_read')),
    ).toBe(true);
  });

  it('should allow manage:* scope mapped to {resource}_manage', () => {
    const f = fi();
    const trust = issueTrust(f, { resourceScopes: ['manage:configs'] });
    exchangeTrust(f, trust);
    expect(
      runWithTenant(AUDIENCE_TENANT, () =>
        f.verifyFederationScope(trust.trustId, 'configs_manage'),
      ),
    ).toBe(true);
  });

  it('should allow admin:* wildcard for any tool', () => {
    const f = fi();
    const trust = issueTrust(f, { resourceScopes: ['admin:*'] });
    exchangeTrust(f, trust);
    expect(
      runWithTenant(AUDIENCE_TENANT, () => f.verifyFederationScope(trust.trustId, 'shell_execute')),
    ).toBe(true);
  });

  it('should deny unknown trust ID', () => {
    const f = fi();
    expect(f.verifyFederationScope('nonexistent', 'web_fetch')).toBe(false);
  });

  it('should deny scope after trust revocation', () => {
    const f = fi();
    const trust = issueTrust(f);
    exchangeTrust(f, trust);
    runWithTenant(ISSUER_TENANT, () => f.revokeTrust(trust.trustId, 'test'));
    expect(
      runWithTenant(AUDIENCE_TENANT, () => f.verifyFederationScope(trust.trustId, 'web_fetch')),
    ).toBe(false);
  });
});

// ============================================================================
// Revocation Cascade
// ============================================================================

describe('FederatedIdentity - Revocation Cascade', () => {
  it('should revoke a trust and report counts', () => {
    const f = fi();
    const trust = issueTrust(f);
    exchangeTrust(f, trust);
    const result = runWithTenant(ISSUER_TENANT, () =>
      f.revokeTrust(trust.trustId, 'security-incident'),
    );
    expect(result.revoked).toBe(true);
    expect(result.tokensRevoked).toBeGreaterThanOrEqual(0);
    expect(result.instancesKilled).toBeGreaterThanOrEqual(0);
  });

  it('should not double-revoke', () => {
    const f = fi();
    const trust = issueTrust(f);
    runWithTenant(ISSUER_TENANT, () => f.revokeTrust(trust.trustId, 'first'));
    const second = runWithTenant(ISSUER_TENANT, () => f.revokeTrust(trust.trustId, 'second'));
    expect(second.revoked).toBe(false);
  });

  it('should handle nonexistent trust gracefully', () => {
    const f = fi();
    const result = runWithTenant(ISSUER_TENANT, () => f.revokeTrust('nonexistent', 'test'));
    expect(result.revoked).toBe(false);
    expect(result.tokensRevoked).toBe(0);
  });
});

// ============================================================================
// Query API
// ============================================================================

describe('FederatedIdentity - Query API', () => {
  it('should list active trusts', () => {
    const f = fi();
    const t1 = issueTrust(f, { trustId: 'trust-001' });
    const t2 = runWithTenant(ISSUER_TENANT, () =>
      f.issueTrust({
        audienceTenant: AUDIENCE_TENANT,
        resourceScopes: ['call:file_read'],
        trustId: 'trust-002',
      }),
    );
    const active = runWithTenant(ISSUER_TENANT, () => f.listActiveTrusts());
    expect(active.some((t) => t.trustId === 'trust-001')).toBe(true);
    expect(active.some((t) => t.trustId === 'trust-002')).toBe(true);
  });

  it('should exclude revoked from active list', () => {
    const f = fi();
    issueTrust(f, { trustId: 'trust-to-revoke' });
    runWithTenant(ISSUER_TENANT, () => f.revokeTrust('trust-to-revoke', 'test'));
    const active = runWithTenant(ISSUER_TENANT, () => f.listActiveTrusts());
    expect(active.some((t) => t.trustId === 'trust-to-revoke')).toBe(false);
  });

  it('should track derived tokens', () => {
    const f = fi();
    issueTrust(f, { trustId: 'trust-track' });
    expect(f.trackDerivedToken('trust-track', 'jti-abc')).toBe(true);
    expect(f.getTrustEntry('trust-track')!.derivedTokens.has('jti-abc')).toBe(true);
  });

  it('should track derived instances', () => {
    const f = fi();
    issueTrust(f, { trustId: 'trust-inst' });
    expect(f.trackDerivedInstance('trust-inst', 'inst-xyz')).toBe(true);
    expect(f.getTrustEntry('trust-inst')!.derivedInstances.has('inst-xyz')).toBe(true);
  });

  it('should get a trust by ID', () => {
    const f = fi();
    issueTrust(f, { trustId: 'trust-get' });
    expect(f.getTrust('trust-get')!.trustId).toBe('trust-get');
  });

  it('should return undefined for unknown', () => {
    expect(fi().getTrust('nope')).toBeUndefined();
    expect(fi().getTrustEntry('nope')).toBeUndefined();
  });
});

// ============================================================================
// Key Resolution
// ============================================================================

describe('FederatedIdentity - Key Resolution', () => {
  it('should resolve HMAC key from env', () => {
    process.env[FEDERATION_KEY_ENV] = 'a'.repeat(32);
    expect(resolveFederationKey()).toBeInstanceOf(Buffer);
  });

  it('should use dev key when env not set', () => {
    delete process.env[FEDERATION_KEY_ENV];
    process.env.NODE_ENV = 'test';
    expect(resolveFederationKey()).toBeInstanceOf(Buffer);
  });

  it('should resolve OIDC key', () => {
    process.env[FEDERATION_OIDC_KEY_ENV] = 'some-key';
    expect(resolveFederationOIDCKey()).toBe('some-key');
  });

  it('should return null for missing OIDC key', () => {
    delete process.env[FEDERATION_OIDC_KEY_ENV];
    expect(resolveFederationOIDCKey()).toBeNull();
  });
});

// ============================================================================
// Cross-Tenant Isolation
// ============================================================================

describe('FederatedIdentity - Cross-Tenant Isolation', () => {
  it('should isolate trusts per tenant via separate instances', () => {
    const f = fi();
    issueTrust(f, { trustId: 'isolated-trust' });

    // A separate instance (different tenant) should NOT see the trust
    const other = new FederatedIdentity({ hmacKey: TEST_HMAC_KEY });
    expect(
      runWithTenant('tenant-third', () => other.getTrustEntry('isolated-trust')),
    ).toBeUndefined();
  });
});

// ============================================================================
// Singleton API
// ============================================================================

describe('FederatedIdentity - Singleton API', () => {
  it('should return FederatedIdentity instance', () => {
    expect(runWithTenant('fi-default', () => getFederatedIdentity())).toBeInstanceOf(
      FederatedIdentity,
    );
  });

  it('should return same instance on repeated calls', () => {
    expect(runWithTenant('fi-default', () => getFederatedIdentity())).toBe(
      runWithTenant('fi-default', () => getFederatedIdentity()),
    );
  });

  it('should reset all state', () => {
    const f = fi();
    issueTrust(f, { trustId: 'reset-test' });
    resetFederatedIdentity();
    expect(
      runWithTenant('fi-default', () => getFederatedIdentity().getTrustEntry('reset-test')),
    ).toBeUndefined();
  });
});
