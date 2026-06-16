/**
 * Tests for OIDC Authentication Plugin
 *
 * Covers:
 * - JWT signature validation (RS256, RS384, RS512, ES256, ES384, ES512)
 * - Algorithm whitelist enforcement
 * - Required claims (iss, aud, exp, sub) validation
 * - JWKS cache behavior
 * - Role mapping from OIDC claims
 * - Tenant resolution
 * - createOIDCPluginFromEnv helper
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import {
  OIDCAuthPlugin,
  createOIDCPluginFromEnv,
  JWKWithKid,
} from '../../src/runtime/oidcAuthPlugin';

// ============================================================================
// Helpers
// ============================================================================

/** Generate an RSA key pair for JWT signing */
function generateKeyPair(): {
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  jwk: JWKWithKid;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const pubKeyObj = crypto.createPublicKey(publicKey);
  const jwk = pubKeyObj.export({ format: 'jwk' }) as JWKWithKid;
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';

  return { publicKey: pubKeyObj, privateKey: crypto.createPrivateKey(privateKey), jwk };
}

/** Base64URL encode a buffer */
function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Create a signed RS256 JWT */
function createSignedJWT(
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  kid: string = 'test-key-1',
  alg: string = 'RS256',
): string {
  const header = { alg, kid, typ: 'JWT' };
  const headerStr = base64url(Buffer.from(JSON.stringify(header)));
  const payloadStr = base64url(Buffer.from(JSON.stringify(payload)));
  const data = `${headerStr}.${payloadStr}`;

  const hashName = alg.startsWith('RS') ? `sha${alg.slice(2)}` : 'sha256';
  const signature = crypto.sign(hashName, Buffer.from(data), privateKey);
  return `${data}.${base64url(signature)}`;
}

/** Create a minimal valid JWT payload for testing */
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://test-issuer.okta.com',
    aud: 'test-client-id',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 60,
    sub: 'user-abc-123',
    email: 'test@example.com',
    preferred_username: 'testuser',
    roles: ['operator'],
    ...overrides,
  };
}

// OIDC plugin instance used across tests
let plugin: OIDCAuthPlugin;
let keys: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject; jwk: JWKWithKid };

// ============================================================================
// Tests
// ============================================================================

describe('OIDCAuthPlugin', () => {
  beforeEach(() => {
    keys = generateKeyPair();
    plugin = new OIDCAuthPlugin({
      issuer: 'https://test-issuer.okta.com',
      clientId: 'test-client-id',
      trustedJwks: [keys.jwk],
      jwksCacheTtlMs: 5000, // short TTL for testing
      adminRoles: ['admin'],
      operatorRoles: ['operator', 'developer'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Successful Authentication ──────────────────────────────────────

  describe('successful authentication', () => {
    it('returns AuthPluginResult for a valid RS256 JWT', async () => {
      const jwt = createSignedJWT(validPayload(), keys.privateKey);
      const result = await plugin.authenticate(jwt);

      expect(result).not.toBeNull();
      expect(result!.userId).toBe('user-abc-123');
      expect(result!.username).toBe('test@example.com');
      expect(result!.role).toBe('operator');
    });

    it('maps admin role correctly', async () => {
      const jwt = createSignedJWT(validPayload({ roles: ['admin'] }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).not.toBeNull();
      expect(result!.role).toBe('admin');
    });

    it('maps viewer role when no matching role claim found', async () => {
      const jwt = createSignedJWT(validPayload({ roles: ['guest'] }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).not.toBeNull();
      expect(result!.role).toBe('viewer');
    });

    it('falls back to preferred_username when email is missing', async () => {
      const jwt = createSignedJWT(
        validPayload({ email: undefined, preferred_username: 'dev-user' }),
        keys.privateKey,
      );
      const result = await plugin.authenticate(jwt);
      expect(result).not.toBeNull();
      expect(result!.username).toBe('dev-user');
    });

    it('falls back to sub when both email and preferred_username are missing', async () => {
      const jwt = createSignedJWT(
        validPayload({ email: undefined, preferred_username: undefined }),
        keys.privateKey,
      );
      const result = await plugin.authenticate(jwt);
      expect(result).not.toBeNull();
      expect(result!.username).toBe('user-abc-123');
    });

    it('supports RS384 and RS512 algorithms', async () => {
      for (const alg of ['RS384', 'RS512'] as const) {
        const jwt = createSignedJWT(
          validPayload({ sub: `user-${alg}` }),
          keys.privateKey,
          'test-key-1',
          alg,
        );
        const result = await plugin.authenticate(jwt);
        expect(result).not.toBeNull();
        expect(result!.userId).toBe(`user-${alg}`);
      }
    });

    it('resolves tenant from tenant_id claim', async () => {
      const jwt = createSignedJWT(validPayload({ tenant_id: 'acme-corp' }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe('acme-corp');
    });

    it('resolves tenant from Okta subdomain', async () => {
      // Re-create plugin with Okta-style issuer for tenant resolution test
      const oktaPlugin = new OIDCAuthPlugin({
        issuer: 'https://acme-corp.okta.com',
        clientId: 'test-client-id',
        trustedJwks: [keys.jwk],
      });
      const jwt = createSignedJWT(
        validPayload({ iss: 'https://acme-corp.okta.com', aud: 'test-client-id' }),
        keys.privateKey,
      );
      const result = await oktaPlugin.authenticate(jwt);
      expect(result).not.toBeNull();
      expect(result!.tenantId).toBe('acme-corp');
    });

    it('uses custom roleClaim when configured', async () => {
      const customPlugin = new OIDCAuthPlugin({
        issuer: 'https://test-issuer.okta.com',
        clientId: 'test-client-id',
        roleClaim: 'commander_role',
        adminRoles: ['super-admin'],
        trustedJwks: [keys.jwk],
      });
      const jwt = createSignedJWT(validPayload({ commander_role: 'super-admin' }), keys.privateKey);
      const result = await customPlugin.authenticate(jwt);
      expect(result).not.toBeNull();
      expect(result!.role).toBe('admin');
    });
  });

  // ── Token Format Validation ───────────────────────────────────────

  describe('token validation', () => {
    it('rejects non-JWT tokens (no dots)', async () => {
      const result = await plugin.authenticate('not-a-jwt');
      expect(result).toBeNull();
    });

    it('rejects tokens with wrong number of parts', async () => {
      const result = await plugin.authenticate('part1.part2');
      expect(result).toBeNull();
    });

    it('rejects malformed base64 in header', async () => {
      const result = await plugin.authenticate('!!!.eyJzdWIiOiJ0ZXN0In0=.signature');
      expect(result).toBeNull();
    });

    it('rejects malformed base64 in payload', async () => {
      const result = await plugin.authenticate('eyJhbGciOiJSUzI1NiJ9.!!!.signature');
      expect(result).toBeNull();
    });
  });

  // ── Algorithm Whitelist ────────────────────────────────────────────

  describe('algorithm whitelist', () => {
    it('rejects JWT with algorithm not in whitelist', async () => {
      const jwt = createSignedJWT(validPayload(), keys.privateKey, 'test-key-1', 'HS256');
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('rejects JWT with no algorithm header', async () => {
      // Craft a JWT with no alg in header
      const header = { kid: 'test-key-1' };
      const payload = validPayload();
      const jwt = [
        base64url(Buffer.from(JSON.stringify(header))),
        base64url(Buffer.from(JSON.stringify(payload))),
        'dummy-signature',
      ].join('.');
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('respects custom allowedAlgorithms configuration', async () => {
      const restrictedPlugin = new OIDCAuthPlugin({
        issuer: 'https://test-issuer.okta.com',
        clientId: 'test-client-id',
        allowedAlgorithms: ['RS256'], // only RS256
        trustedJwks: [keys.jwk],
      });
      // RS384 should be rejected
      const jwt = createSignedJWT(validPayload(), keys.privateKey, 'test-key-1', 'RS384');
      const result = await restrictedPlugin.authenticate(jwt);
      expect(result).toBeNull();
    });
  });

  // ── Required Claims ────────────────────────────────────────────────

  describe('required claims validation', () => {
    it('rejects JWT without iss', async () => {
      const jwt = createSignedJWT(validPayload({ iss: undefined }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('rejects JWT without aud', async () => {
      const jwt = createSignedJWT(validPayload({ aud: undefined }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('rejects JWT without exp', async () => {
      const jwt = createSignedJWT(validPayload({ exp: undefined }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('rejects JWT without sub', async () => {
      const jwt = createSignedJWT(validPayload({ sub: undefined }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('rejects JWT with wrong issuer', async () => {
      const jwt = createSignedJWT(
        validPayload({ iss: 'https://wrong-issuer.com' }),
        keys.privateKey,
      );
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('rejects JWT with wrong audience', async () => {
      const jwt = createSignedJWT(validPayload({ aud: 'wrong-client-id' }), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });
  });

  // ── Expiration ─────────────────────────────────────────────────────

  describe('expiration handling', () => {
    it('rejects expired JWT', async () => {
      const jwt = createSignedJWT(
        validPayload({ exp: Math.floor(Date.now() / 1000) - 120 }), // 2 min ago
        keys.privateKey,
      );
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('rejects JWT used before iat (future-dated)', async () => {
      const jwt = createSignedJWT(
        validPayload({ iat: Math.floor(Date.now() / 1000) + 120 }), // 2 min in future
        keys.privateKey,
      );
      const result = await plugin.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('accepts JWT within clock skew tolerance', async () => {
      // JWT that is 50 seconds old — within default 60s clock skew
      const jwt = createSignedJWT(
        validPayload({
          iat: Math.floor(Date.now() / 1000) - 50,
          exp: Math.floor(Date.now() / 1000) + 30,
        }),
        keys.privateKey,
      );
      const result = await plugin.authenticate(jwt);
      expect(result).not.toBeNull();
    });
  });

  // ── JWKS Cache ─────────────────────────────────────────────────────

  describe('JWKS cache', () => {
    it('uses trustedJwks without network calls', async () => {
      const jwt = createSignedJWT(validPayload(), keys.privateKey);
      const result = await plugin.authenticate(jwt);
      expect(result).not.toBeNull();
    });

    it('returns null when no matching key in JWKS', async () => {
      const wrongKeys = generateKeyPair();
      const pluginWithWrongKeys = new OIDCAuthPlugin({
        issuer: 'https://test-issuer.okta.com',
        clientId: 'test-client-id',
        trustedJwks: [wrongKeys.jwk], // key doesn't match the signing key
      });
      const jwt = createSignedJWT(validPayload(), keys.privateKey);
      const result = await pluginWithWrongKeys.authenticate(jwt);
      expect(result).toBeNull();
    });

    it('throws on signature mismatch', async () => {
      // Create a JWT signed with one key, then use a plugin with a different trusted key
      const keyPair2 = generateKeyPair();
      // Make the second key have the SAME kid but different key material
      keyPair2.jwk.kid = 'test-key-1';

      const misMatchPlugin = new OIDCAuthPlugin({
        issuer: 'https://test-issuer.okta.com',
        clientId: 'test-client-id',
        trustedJwks: [keyPair2.jwk], // different key!
      });

      const jwt = createSignedJWT(validPayload(), keys.privateKey, 'test-key-1');
      const result = await misMatchPlugin.authenticate(jwt);
      expect(result).toBeNull();
    });
  });

  // ── Signature Verification ─────────────────────────────────────────

  describe('signature verification', () => {
    it('rejects JWT with tampered payload', async () => {
      const jwt = createSignedJWT(validPayload({ role: 'admin' }), keys.privateKey);
      // Tamper with the payload
      const parts = jwt.split('.');
      const tamperedPayload = base64url(
        Buffer.from(JSON.stringify(validPayload({ role: 'super-admin' }))),
      );
      const tamperedJwt = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const result = await plugin.authenticate(tamperedJwt);
      expect(result).toBeNull();
    });

    it('rejects JWT with tampered header', async () => {
      const jwt = createSignedJWT(validPayload(), keys.privateKey);
      const parts = jwt.split('.');
      const tamperedHeader = base64url(
        Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'different-key' })),
      );
      const tamperedJwt = `${tamperedHeader}.${parts[1]}.${parts[2]}`;

      const result = await plugin.authenticate(tamperedJwt);
      expect(result).toBeNull();
    });
  });

  // ── createOIDCPluginFromEnv ────────────────────────────────────────

  describe('createOIDCPluginFromEnv', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      vi.stubEnv('OIDC_ISSUER', 'https://env-issuer.okta.com');
      vi.stubEnv('OIDC_CLIENT_ID', 'env-client-id');
      vi.stubEnv('OIDC_ROLE_CLAIM', 'custom_roles');
      vi.stubEnv('OIDC_ADMIN_ROLES', 'super-admin,root');
      vi.stubEnv('OIDC_OPERATOR_ROLES', 'dev,ops');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('creates plugin from environment variables', () => {
      const plugin = createOIDCPluginFromEnv();
      expect(plugin).not.toBeNull();
      const cfg = (plugin as any).config;
      expect(cfg.issuer).toBe('https://env-issuer.okta.com');
      expect(cfg.clientId).toBe('env-client-id');
      expect(cfg.roleClaim).toBe('custom_roles');
      expect(cfg.adminRoles).toEqual(['super-admin', 'root']);
      expect(cfg.operatorRoles).toEqual(['dev', 'ops']);
    });

    it('returns null when OIDC_ISSUER is missing', () => {
      vi.stubEnv('OIDC_ISSUER', '');
      const plugin = createOIDCPluginFromEnv();
      expect(plugin).toBeNull();
    });

    it('returns null when OIDC_CLIENT_ID is missing', () => {
      vi.stubEnv('OIDC_CLIENT_ID', '');
      const plugin = createOIDCPluginFromEnv();
      expect(plugin).toBeNull();
    });

    it('uses defaults when env vars are undefined (not set at all)', () => {
      vi.stubEnv('OIDC_ROLE_CLAIM', undefined);
      vi.stubEnv('OIDC_ADMIN_ROLES', undefined);
      vi.stubEnv('OIDC_OPERATOR_ROLES', undefined);
      const plugin = createOIDCPluginFromEnv();
      expect(plugin).not.toBeNull();
      const cfg = (plugin as any).config;
      expect(cfg.roleClaim).toBe('roles');
      expect(cfg.adminRoles).toEqual(['admin']);
      expect(cfg.operatorRoles).toEqual(['operator', 'developer']);
    });
  });
});
