/**
 * OIDC Authentication Plugin — JWT-based SSO for Commander.
 *
 * Validates OIDC ID tokens (RS256 JWTs) from Okta, Auth0, Google Workspace,
 * or any standard OIDC provider. Maps OIDC claims to Commander AuthRole.
 *
 * Works alongside the existing API key auth (CommanderHttpServer.authenticate).
 * When OIDC is configured, the Authorization: Bearer <token> flow accepts both
 * Commander API keys and OIDC JWTs — the server tries API key auth first,
 * then falls back to OIDC JWT validation.
 *
 * Usage:
 *   const oidc = new OIDCAuthPlugin({
 *     issuer: 'https://your-tenant.okta.com/oauth2/default',
 *     clientId: '0abc123...',
 *     roleClaim: 'commander_role',     // optional, default 'roles'
 *     adminRoles: ['admin', 'commander-admin'],
 *     operatorRoles: ['developer', 'commander-operator'],
 *   });
 *   httpServer.registerAuthPlugin(oidc);
 *
 * Environment variable fallback:
 *   OIDC_ISSUER=https://...
 *   OIDC_CLIENT_ID=...
 *   OIDC_ROLE_CLAIM=commander_role
 */

import { reportSilentFailure } from '../silentFailureReporter';
import * as crypto from 'node:crypto';
import * as https from 'node:https';
import { getGlobalLogger } from '../logging';
import { getSecurityAuditLogger } from '../security/securityAuditLogger';
import type { AuthRole } from './authManager';

// ============================================================================
// Types
// ============================================================================

/** JWK with optional kid — Node.js types omit it but OIDC requires it */
export interface JWKWithKid extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

export interface OIDCPluginConfig {
  /** OIDC issuer URL (e.g. https://your-tenant.okta.com/oauth2/default) */
  issuer: string;
  /** OIDC client ID (audience claim must match) */
  clientId: string;
  /** JWT claim containing role information (default: 'roles') */
  roleClaim?: string;
  /** Claim values that map to admin role (default: ['admin']) */
  adminRoles?: string[];
  /** Claim values that map to operator role (default: ['operator', 'developer']) */
  operatorRoles?: string[];
  /** JWKS cache TTL in ms (default: 3600000 = 1 hour) */
  jwksCacheTtlMs?: number;
  /** Max clock skew in seconds for JWT validation (default: 60) */
  clockSkewSeconds?: number;
  /** Optional: explicitly trust these JWK keys instead of fetching from JWKS URI */
  trustedJwks?: JWKWithKid[];
  /**
   * Allowed JWT algorithms. Prevents algorithm confusion attacks.
   * Default: ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512']
   */
  allowedAlgorithms?: string[];
}

export interface AuthPlugin {
  /** Unique name for this plugin */
  readonly name: string;
  /** Authenticate a Bearer token. Returns user info + role on success, null on failure. */
  authenticate(bearerToken: string): Promise<AuthPluginResult | null>;
}

export interface AuthPluginResult {
  /** Stable user identifier from the OIDC provider */
  userId: string;
  /** Human-readable username/email */
  username: string;
  /** Commander role mapped from OIDC claims */
  role: AuthRole;
  /** Optional tenant ID for multi-tenant mapping */
  tenantId?: string;
  /** Raw claims from the JWT (for audit) */
  claims?: Record<string, unknown>;
}

// ============================================================================
// JWKS Cache
// ============================================================================

interface CachedJWKS {
  keys: JWKWithKid[];
  fetchedAt: number;
}

// ============================================================================
// OIDC Auth Plugin
// ============================================================================

/**
 * Validates OIDC JWTs using JWKS (JSON Web Key Set) from the issuer's
 * well-known endpoint. Supports RS256, RS384, RS512, ES256, ES384, ES512.
 *
 * No external dependencies — uses Node.js built-in crypto for JWT verification.
 */
export class OIDCAuthPlugin implements AuthPlugin {
  readonly name = 'oidc';
  private config: OIDCPluginConfig;
  private jwksCache: CachedJWKS | null = null;
  private jwksFetchPromise: Promise<JWKWithKid[]> | null = null;

  private static readonly SUPPORTED_ALGORITHMS = [
    'RS256',
    'RS384',
    'RS512',
    'ES256',
    'ES384',
    'ES512',
  ];

  constructor(config: Partial<OIDCPluginConfig> & { issuer: string; clientId: string }) {
    this.config = {
      roleClaim: 'roles',
      adminRoles: ['admin'],
      operatorRoles: ['operator', 'developer'],
      jwksCacheTtlMs: 3600_000, // 1 hour
      clockSkewSeconds: 60,
      allowedAlgorithms: OIDCAuthPlugin.SUPPORTED_ALGORITHMS,
      ...config,
    };
  }

  /**
   * Authenticate a Bearer token by validating it as an OIDC JWT.
   * Returns null if the token is not a valid JWT or validation fails.
   */
  async authenticate(bearerToken: string): Promise<AuthPluginResult | null> {
    const audit = getSecurityAuditLogger();

    // Parse the JWT
    const parts = bearerToken.split('.');
    if (parts.length !== 3) {
      return null; // Not a JWT
    }

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(base64UrlDecode(parts[0]));
      payload = JSON.parse(base64UrlDecode(parts[1]));
    } catch (err) {
      reportSilentFailure(err, 'oidcAuthPlugin:155');
      return null; // Malformed JWT
    }

    // Validate required claims
    const iss = payload.iss as string | undefined;
    const aud = payload.aud as string | string[] | undefined;
    const exp = payload.exp as number | undefined;
    const iat = payload.iat as number | undefined;
    const sub = payload.sub as string | undefined;

    if (!iss || !aud || !exp || !sub) {
      audit.logAuthFailure('OIDCAuthPlugin', 'JWT missing required claims (iss, aud, exp, sub)', {
        missingClaims: ['iss', 'aud', 'exp', 'sub'].filter((c) => !payload[c]),
      });
      return null;
    }

    // Validate issuer
    if (iss !== this.config.issuer) {
      return null; // Silent fail — not our issuer
    }

    // Validate audience
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.config.clientId)) {
      audit.logAuthFailure('OIDCAuthPlugin', 'JWT audience does not match client ID', {
        expected: this.config.clientId,
        actual: audiences,
      });
      return null;
    }

    // Validate expiration with clock skew
    const now = Math.floor(Date.now() / 1000);
    if (exp + (this.config.clockSkewSeconds ?? 60) < now) {
      audit.logAuthFailure('OIDCAuthPlugin', 'JWT expired', {
        exp,
        now,
        clockSkew: this.config.clockSkewSeconds,
      });
      return null;
    }

    // Validate not-before with clock skew
    if (iat && iat - (this.config.clockSkewSeconds ?? 60) > now) {
      audit.logAuthFailure('OIDCAuthPlugin', 'JWT used before iat', { iat, now });
      return null;
    }

    // Get the key ID from header
    const kid = header.kid as string | undefined;
    const alg = header.alg as string | undefined;
    if (!kid || !alg) {
      return null;
    }

    // Algorithm whitelist: prevent algorithm confusion attacks
    const allowedAlgorithms = this.config.allowedAlgorithms ?? OIDCAuthPlugin.SUPPORTED_ALGORITHMS;
    if (!allowedAlgorithms.includes(alg)) {
      audit.logAuthFailure('OIDCAuthPlugin', 'JWT algorithm not in allowlist', {
        alg,
        allowedAlgorithms,
      });
      return null;
    }

    // Fetch JWKS and find matching key
    let jwk: JWKWithKid | undefined;
    try {
      jwk = await this.findKey(kid);
    } catch (err) {
      getGlobalLogger().error('OIDCAuthPlugin', 'Failed to fetch JWKS', err as Error);
      return null;
    }

    if (!jwk) {
      audit.logAuthFailure('OIDCAuthPlugin', 'No matching JWK found for key ID', { kid });
      return null;
    }

    // Verify signature
    const signature = base64UrlDecodeToBuffer(parts[2]);
    const data = `${parts[0]}.${parts[1]}`;

    try {
      const verified = this.verifySignature(alg, data, signature, jwk);
      if (!verified) {
        audit.logAuthFailure('OIDCAuthPlugin', 'JWT signature verification failed', { kid, alg });
        return null;
      }
    } catch (err) {
      audit.logAuthFailure('OIDCAuthPlugin', 'JWT signature verification threw', {
        kid,
        alg,
        error: (err as Error)?.message,
      });
      return null;
    }

    // Map roles from claims
    const roleClaimName = this.config.roleClaim ?? 'roles';
    const rawRoles = payload[roleClaimName] as string | string[] | undefined;
    const roles = rawRoles ? (Array.isArray(rawRoles) ? rawRoles : [rawRoles]) : [];

    let role: AuthRole = 'viewer'; // default
    if (roles.some((r) => this.config.adminRoles?.includes(r))) {
      role = 'admin';
    } else if (roles.some((r) => this.config.operatorRoles?.includes(r))) {
      role = 'operator';
    }

    // Extract tenant mapping (optional — from claim or sub issuer)
    const tenantId = this.resolveTenant(payload);

    audit.logAuthSuccess('OIDCAuthPlugin', `OIDC user authenticated: ${payload.sub}`, {
      sub: payload.sub as string,
      issuer: iss,
      role,
      tenantId,
    });

    return {
      userId: payload.sub as string,
      username:
        (payload.email as string) ||
        (payload.preferred_username as string) ||
        (payload.sub as string),
      role,
      tenantId,
      claims: payload,
    };
  }

  /**
   * Refresh JWKS cache. Useful for testing or forcing cache refresh.
   */
  async refreshJWKS(): Promise<void> {
    this.jwksCache = null;
    this.jwksFetchPromise = null;
    await this.fetchJWKS();
  }

  // ── Private ──────────────────────────────────────────────────────

  private async findKey(kid: string): Promise<JWKWithKid | undefined> {
    // Check cache
    if (this.jwksCache) {
      const age = Date.now() - this.jwksCache.fetchedAt;
      if (age < (this.config.jwksCacheTtlMs ?? 3600_000)) {
        return this.jwksCache.keys.find((k) => k.kid === kid);
      }
    }

    // Fetch fresh JWKS
    const keys = await this.fetchJWKS();
    return keys.find((k) => k.kid === kid);
  }

  private async fetchJWKS(): Promise<JWKWithKid[]> {
    // Deduplicate concurrent fetches
    if (this.jwksFetchPromise) {
      return this.jwksFetchPromise;
    }

    // Use trusted keys if provided (no network call)
    if (this.config.trustedJwks && this.config.trustedJwks.length > 0) {
      this.jwksCache = { keys: this.config.trustedJwks, fetchedAt: Date.now() };
      return this.config.trustedJwks;
    }

    this.jwksFetchPromise = this.fetchJWKSFromIssuer();
    try {
      const keys = await this.jwksFetchPromise;
      this.jwksCache = { keys, fetchedAt: Date.now() };
      return keys;
    } finally {
      this.jwksFetchPromise = null;
    }
  }

  private fetchJWKSFromIssuer(): Promise<JWKWithKid[]> {
    return new Promise((resolve, reject) => {
      const issuer = this.config.issuer.replace(/\/$/, '');
      const jwksUri = `${issuer}/.well-known/openid-configuration`;

      // First fetch OIDC discovery document to get jwks_uri
      https
        .get(jwksUri, { timeout: 10000 }, (discoveryRes) => {
          let body = '';
          discoveryRes.on('data', (chunk: string) => {
            body += chunk;
          });
          discoveryRes.on('end', () => {
            if (discoveryRes.statusCode !== 200) {
              // Fallback: try common JWKS URI
              this.fetchJWKSFromUrl(`${issuer}/.well-known/jwks.json`).then(resolve).catch(reject);
              return;
            }
            try {
              const discovery = JSON.parse(body);
              const jwksUrl = discovery.jwks_uri;
              if (!jwksUrl) {
                reject(new Error('No jwks_uri in OIDC discovery document'));
                return;
              }
              this.fetchJWKSFromUrl(jwksUrl).then(resolve).catch(reject);
            } catch (err) {
              reportSilentFailure(err, 'oidcAuthPlugin:363');
              reject(new Error('Failed to parse OIDC discovery document'));
            }
          });
        })
        .on('error', reject)
        .on('timeout', function (this: import('http').ClientRequest) {
          this.destroy();
          reject(new Error('OIDC discovery timeout'));
        });
    });
  }

  private fetchJWKSFromUrl(url: string): Promise<JWKWithKid[]> {
    return new Promise((resolve, reject) => {
      https
        .get(url, { timeout: 10000 }, (res: import('http').IncomingMessage) => {
          let body = '';
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`JWKS fetch failed: ${res.statusCode}`));
              return;
            }
            try {
              const parsed = JSON.parse(body);
              const keys = parsed.keys as JWKWithKid[];
              if (!keys || !Array.isArray(keys)) {
                reject(new Error('Invalid JWKS response'));
                return;
              }
              resolve(keys);
            } catch (err) {
              reportSilentFailure(err, 'oidcAuthPlugin:398');
              reject(new Error('Failed to parse JWKS response'));
            }
          });
        })
        .on('error', reject)
        .on('timeout', function (this: import('http').ClientRequest) {
          this.destroy();
          reject(new Error('JWKS fetch timeout'));
        });
    });
  }

  /**
   * Verify JWT signature using the JWK.
   * Supports RS256, RS384, RS512, ES256, ES384, ES512.
   */
  private verifySignature(alg: string, data: string, signature: Buffer, jwk: JWKWithKid): boolean {
    // Import the JWK as a public key
    const keyObject = crypto.createPublicKey({
      key: jwk as unknown as JsonWebKey,
      format: 'jwk',
    });

    // Map JWT algorithm to crypto algorithm name
    const cryptoAlg = this.jwtAlgToCrypto(alg);
    if (!cryptoAlg) {
      throw new Error(`Unsupported algorithm: ${alg}`);
    }

    return crypto.verify(cryptoAlg, Buffer.from(data, 'utf-8'), keyObject, signature);
  }

  private jwtAlgToCrypto(alg: string): string | null {
    switch (alg) {
      case 'RS256':
        return 'sha256';
      case 'RS384':
        return 'sha384';
      case 'RS512':
        return 'sha512';
      case 'ES256':
        return 'sha256';
      case 'ES384':
        return 'sha384';
      case 'ES512':
        return 'sha512';
      default:
        return null;
    }
  }

  /**
   * Resolve tenant ID from JWT claims.
   * Override this method to implement custom tenant mapping.
   */
  protected resolveTenant(payload: Record<string, unknown>): string | undefined {
    // Check for a custom tenant claim
    const tenantClaim = payload.tenant_id as string | undefined;
    if (tenantClaim) return tenantClaim;

    // Check the issuer URL for tenant hints (Okta: {tenant}.okta.com)
    const iss = payload.iss as string | undefined;
    if (iss) {
      const match = iss.match(/https:\/\/([^.]+)\.okta\.com/);
      if (match) return match[1];
    }

    return undefined;
  }
}

// ============================================================================
// Base64 URL decoding (no external dependencies)
// ============================================================================

function base64UrlDecode(input: string): string {
  // Replace URL-safe characters and add padding
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Base64URL decode returning a Buffer (for JWT signature verification). */
function base64UrlDecodeToBuffer(input: string): Buffer {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  return Buffer.from(base64, 'base64');
}

// ============================================================================
// Helper: create from env vars
// ============================================================================

/**
 * Create OIDCAuthPlugin from environment variables.
 * Returns null if OIDC_ISSUER or OIDC_CLIENT_ID is not set.
 */
export function createOIDCPluginFromEnv(): OIDCAuthPlugin | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) return null;

  return new OIDCAuthPlugin({
    issuer,
    clientId,
    roleClaim: process.env.OIDC_ROLE_CLAIM ?? 'roles',
    adminRoles: (process.env.OIDC_ADMIN_ROLES?.split(',') ?? ['admin']).map((s) => s.trim()),
    operatorRoles: (process.env.OIDC_OPERATOR_ROLES?.split(',') ?? ['operator', 'developer']).map(
      (s) => s.trim(),
    ),
  });
}
