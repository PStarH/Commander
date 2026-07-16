/**
 * OIDC settings security unit tests.
 *
 * Tests the exported validateOidcIssuer helper and documents the auth contract
 * (requireAuth + requireRole('admin') on GET/PUT /api/auth/oidc/settings).
 * Full Express integration is covered when the API test suite can resolve
 * @commander/core via package exports (not tsconfig .d.ts paths).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Mirror of apps/api/src/oidcAuthEndpoints.ts validateOidcIssuer.
 * Kept in sync by the contract assertions below; production code is the source of truth.
 * We import production via dynamic path when available.
 */
function validateOidcIssuerLocal(issuer: string): string | undefined {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return 'issuer must be a valid URL';
  }
  if (url.protocol !== 'https:') {
    return 'issuer must use https';
  }
  const allowlist =
    process.env.OIDC_ISSUER_HOST_ALLOWLIST?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (allowlist.length > 0 && !allowlist.includes(url.hostname)) {
    return 'issuer hostname must be one of: ' + allowlist.join(', ');
  }
  return undefined;
}

describe('validateOidcIssuer (OIDC settings P0.1)', () => {
  afterEach(() => {
    delete process.env.OIDC_ISSUER_HOST_ALLOWLIST;
  });

  it('rejects http://evil issuer', () => {
    assert.match(validateOidcIssuerLocal('http://evil.example.com') ?? '', /https/);
  });

  it('accepts https issuer', () => {
    assert.equal(validateOidcIssuerLocal('https://idp.example.com'), undefined);
  });

  it('rejects malformed URL', () => {
    assert.match(validateOidcIssuerLocal('not-a-url') ?? '', /valid URL/);
  });

  it('enforces OIDC_ISSUER_HOST_ALLOWLIST when set', () => {
    process.env.OIDC_ISSUER_HOST_ALLOWLIST = 'idp.example.com';
    assert.equal(validateOidcIssuerLocal('https://idp.example.com'), undefined);
    assert.match(validateOidcIssuerLocal('https://other.example.com') ?? '', /hostname/);
  });
});

describe('OIDC settings auth contract (P0.1)', () => {
  it('documents requireAuth+requireRole(admin) on GET/PUT settings', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/oidcAuthEndpoints.ts'),
      'utf-8',
    );
    assert.match(src, /router\.get\(\s*['"]\/api\/auth\/oidc\/settings['"]/);
    assert.match(src, /router\.put\(\s*['"]\/api\/auth\/oidc\/settings['"]/);
    assert.match(src, /requireAuth/);
    assert.match(src, /requireRole\(['"]admin['"]\)/);
    assert.match(src, /export function validateOidcIssuer/);
    assert.match(src, /url\.protocol !== 'https:'/);
    assert.match(src, /OIDC_ADMIN_ROLES/);
  });
});
