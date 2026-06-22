/**
 * FederatedIdentity — Cross-organization trust delegation for multi-enterprise
 * Commander deployments (Phase 3).
 *
 * Enables Tenant A (issuer) to delegate limited capabilities to Tenant B
 * (audience) so that Tenant B's agents can execute scoped tools within
 * Tenant A's workspace. Every federated action is cryptographically signed
 * with dual HMAC + OIDC JWT signatures, fully audited in the hash-chained
 * ledger, and constrained by capability tokens derived from the trust scope.
 *
 * Design
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ 1. FederationTrust document:                                           │
 * │    { trustId, issuerTenant, audienceTenant, resourceScopes,            │
 * │      maxDepth, expiresAt, issuedAt, metadata }                         │
 * │                                                                        │
 * │ 2. Dual signing:                                                       │
 * │    - HMAC-SHA-256(issuerKey, canonicalJSON) → for fast intra-org       │
 * │    - OIDC JWT (RS256) using issuer's private key → for cross-org       │
 * │      standards compliance (Okta, Auth0, Azure AD can verify)           │
 * │                                                                        │
 * │ 3. exchange(trustToken):                                               │
 * │    Audience tenant validates the trust (HMAC or JWT), creates a        │
 * │    local agent identity, issues narrow capability tokens constrained   │
 * │    by resourceScopes, and records everything in the audit chain        │
 * │    with both originTenantId + hostTenantId for data sovereignty.       │
 * │                                                                        │
 * │ 4. Revocation:                                                         │
 * │    revokeTrust(trustId) cascades to all capability tokens + lineage    │
 * │    nodes derived from this trust. The "500ms kill switch" for remote   │
 * │    agent access.                                                        │
 * │                                                                        │
 * │ 5. Scope enforcement:                                                  │
 * │    verifyFederationScope(trustId, toolName) checks tool membership     │
 * │    against resourceScopes. Called before every federated tool call.   │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Resource scope format:
 *   'read:<resource>'     — read-only access (reports, logs, metrics)
 *   'call:<tool>'         — invoke a specific tool
 *   'manage:<resource>'   — CRUD on a resource
 *   'admin:<subsystem>'   — full admin access to a subsystem
 *
 * Usage:
 *   // Issuer tenant (Tenant A):
 *   const issuer = getFederatedIdentity();
 *   const trustToken = issuer.issueTrust({
 *     audienceTenant: 'tenant-b',
 *     resourceScopes: ['call:web_fetch', 'read:reports'],
 *     ttlSeconds: 3600,
 *   });
 *
 *   // Audience tenant (Tenant B):
 *   const audience = getFederatedIdentity();
 *   const result = audience.exchange(trustToken);
 *   // result.agentId = local agent registration
 *   // result.capabilityToken = scoped capability token for tool calls
 *
 *   // Tool call enforcement:
 *   const allowed = audience.verifyFederationScope(
 *     result.trustId, 'web_fetch'
 *   );
 */

import * as crypto from 'crypto';
import { getAuditChainLedger } from './auditChainLedger';
import type { SecurityEvent } from './securityAuditLogger';
import { getCurrentTenantId } from '../runtime/tenantContext';
import { createTenantAwareSingleton } from '../runtime/tenantAwareSingleton';
import { getGlobalTenantProvider } from '../runtime/tenantProvider';
import { recordSinkFailure } from '../observability/sinkFailureCounter';
import { getMetricsCollector } from '../runtime/metricsCollector';
import { getCapabilityTokenIssuer, decode } from './capabilityToken';
import { getAgentLineage } from './agentLineage';

/** Module-level revocation set shared across all FederatedIdentity instances. */
const REVOKED_TRUST_IDS = new Set<string>();

// ============================================================================
// Public Types
// ============================================================================

/** Resource scope granularity for federation trust. */
export type ResourceScope =
  | `read:${string}`
  | `call:${string}`
  | `manage:${string}`
  | `admin:${string}`;

/** A single federation trust relationship. */
export interface FederationTrust {
  /** Unique trust identifier (UUID, no dashes). */
  trustId: string;
  /** Tenant that created the trust (the resource owner). */
  issuerTenant: string;
  /** Tenant allowed to use the trust (the remote agent owner). */
  audienceTenant: string;
  /** What the audience tenant is allowed to do. */
  resourceScopes: ResourceScope[];
  /** Maximum delegation depth for sub-agents spawned by the audience. */
  maxDepth: number;
  /** Unix timestamp when the trust expires. */
  expiresAt: number;
  /** Unix timestamp when the trust was issued. */
  issuedAt: number;
  /** Arbitrary metadata (purpose, billing code, approval reference). */
  metadata?: Record<string, unknown>;
  /** HMAC-SHA-256 signature over canonical JSON. */
  hmacSignature: string;
  /** Optional OIDC JWT for cross-org verification. */
  jwtToken?: string;
}

/** Parameters for issuing a federation trust. */
export interface IssueTrustParams {
  /** Target tenant that will receive the delegated trust. */
  audienceTenant: string;
  /** Resource scopes delegated to the audience. */
  resourceScopes: ResourceScope[];
  /** TTL in seconds (default: 3600 = 1 hour). */
  ttlSeconds?: number;
  /** Maximum sub-agent delegation depth (default: 1). */
  maxDepth?: number;
  /** Optional metadata. */
  metadata?: Record<string, unknown>;
  /** Override trustId (for deterministic testing). */
  trustId?: string;
}

/** Result of audience.exchange() — maps a trust to local identities. */
export interface FederatedExchangeResult {
  /** Whether the exchange was accepted. */
  accepted: true;
  /** The validated trust document. */
  trust: FederationTrust;
  /** Local agent ID created for the federated agent. */
  agentId: string;
  /** Capability token scoped to the trust's resourceScopes. */
  capabilityToken: string;
  /** Lineage instance ID for the federated agent. */
  lineageInstanceId: string;
  /** Expiry of the issued capability token (unix timestamp). */
  tokenExpiresAt: number;
}

export interface FederatedExchangeRejection {
  accepted: false;
  reason: FederationRejectReason;
  detail?: string;
}

export type FederatedExchangeOutcome = FederatedExchangeResult | FederatedExchangeRejection;

export type FederationRejectReason =
  | 'invalid_signature'
  | 'hmac_mismatch'
  | 'jwt_verification_failed'
  | 'trust_expired'
  | 'trust_not_yet_valid'
  | 'audience_mismatch'
  | 'issuer_unknown'
  | 'empty_scope'
  | 'trust_revoked'
  | 'depth_exceeded'
  | 'malformed_trust';

/** Active trust registry entry. */
interface TrustEntry {
  trust: FederationTrust;
  derivedTokens: Set<string>; // capability token JTIs
  derivedInstances: Set<string>; // lineage instance IDs
  revokedAt?: number;
  revokeReason?: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Env var for the federation HMAC key (≥ 32 chars). */
export const FEDERATION_KEY_ENV = 'COMMANDER_FEDERATION_KEY';
/** Env var for the OIDC RS256 private key (PEM format). */
export const FEDERATION_OIDC_KEY_ENV = 'COMMANDER_FEDERATION_OIDC_KEY';
/** Default TTL for federation trusts (1 hour). */
const DEFAULT_TRUST_TTL_SECONDS = 3600;
/** Protocol version for the trust format. */
const TRUST_PROTOCOL_VERSION = 1;
/** Hard cap on trust TTL (24 hours). */
const MAX_TRUST_TTL_SECONDS = 86400;

// ============================================================================
// Key Resolution
// ============================================================================

export function resolveFederationKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const v = env[FEDERATION_KEY_ENV];
  if (v && v.length >= 32) return Buffer.from(v, 'utf-8');
  if (env.NODE_ENV === 'production') {
    throw new Error(
      `[federatedIdentity] ${FEDERATION_KEY_ENV} must be set (>= 32 chars) in production. ` +
        'Refusing to issue federation trusts with a default key.',
    );
  }
  // eslint-disable-next-line no-console
  console.error(
    `[federatedIdentity] WARNING: ${FEDERATION_KEY_ENV} not set in non-production. ` +
      'Using insecure dev key. Trusts are NOT cryptographically valid. Set the env var before shipping.',
  );
  return crypto
    .createHash('sha256')
    .update('commander-federation-dev-key-DO-NOT-USE-IN-PROD-v1')
    .digest();
}

export function resolveFederationOIDCKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[FEDERATION_OIDC_KEY_ENV];
  if (v && v.length > 0) return v;
  return null;
}

// ============================================================================
// Canonical JSON (deterministic serialization for HMAC input)
// ============================================================================

function deterministicStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonical-encode non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map(deterministicStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + deterministicStringify(obj[k])).join(',') +
      '}'
    );
  }
  throw new TypeError(`Cannot canonical-encode value of type ${typeof value}`);
}

// ============================================================================
// Base64 URL helpers
// ============================================================================

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf-8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlDecode(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(pad);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// ============================================================================
// FederatedIdentity
// ============================================================================

export class FederatedIdentity {
  private readonly hmacKey: Buffer;
  private readonly oidcPrivateKey: string | null;
  private readonly activeTrusts: Map<string, TrustEntry> = new Map();
  private readonly revokedTrusts: Set<string> = new Set();

  constructor(options?: { hmacKey?: Buffer; oidcPrivateKey?: string }) {
    this.hmacKey = options?.hmacKey ?? resolveFederationKey();
    this.oidcPrivateKey = options?.oidcPrivateKey ?? resolveFederationOIDCKey();
  }

  // ── Issue Trust (Issuer Tenant) ────────────────────────────────────────

  /**
   * Issue a federation trust document from the current tenant to an audience
   * tenant. Signs with HMAC (always) and optionally with OIDC JWT (if a
   * private key is configured).
   *
   * The caller MUST be in the issuer tenant's context (via runWithTenant).
   */
  issueTrust(params: IssueTrustParams): FederationTrust {
    const issuerTenant = getCurrentTenantId();
    if (!issuerTenant) {
      throw new Error(
        '[federatedIdentity] Cannot issue trust without an active tenant context. ' +
          'Wrap the call in runWithTenant(issuerTenantId, () => ...)',
      );
    }

    if (!params.resourceScopes || params.resourceScopes.length === 0) {
      throw new Error('[federatedIdentity] resourceScopes must contain at least one entry');
    }

    const ttl = Math.min(params.ttlSeconds ?? DEFAULT_TRUST_TTL_SECONDS, MAX_TRUST_TTL_SECONDS);
    if (ttl <= 0) {
      throw new Error(`[federatedIdentity] ttlSeconds must be > 0 (got ${ttl})`);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const trustId = params.trustId ?? crypto.randomUUID().replace(/-/g, '');

    const trustPayload: Omit<FederationTrust, 'hmacSignature' | 'jwtToken'> = {
      trustId,
      issuerTenant,
      audienceTenant: params.audienceTenant,
      resourceScopes: [...params.resourceScopes].sort(),
      maxDepth: params.maxDepth ?? 1,
      expiresAt: nowSec + ttl,
      issuedAt: nowSec,
      metadata: params.metadata,
    };

    // HMAC sign the trust document
    const canonicalPayload = deterministicStringify({
      v: TRUST_PROTOCOL_VERSION,
      ...trustPayload,
    });
    const hmacSignature = crypto
      .createHmac('sha256', this.hmacKey)
      .update(canonicalPayload)
      .digest('hex');

    const trust: FederationTrust = {
      ...trustPayload,
      hmacSignature,
    };

    // OIDC JWT signing (cross-org standard)
    if (this.oidcPrivateKey) {
      try {
        trust.jwtToken = this.signOIDCJWT(trustPayload, this.oidcPrivateKey);
      } catch (err) {
        // JWT signing is best-effort — the HMAC signature is always present
        // eslint-disable-next-line no-console
        console.error(
          `[federatedIdentity] OIDC JWT signing failed (HMAC signature still valid): ${(err as Error)?.message}`,
        );
      }
    }

    // Register in active trusts
    this.activeTrusts.set(trustId, {
      trust,
      derivedTokens: new Set(),
      derivedInstances: new Set(),
    });

    // Audit
    this.auditFederationEvent('federation_trust_issued', trust);

    // Metrics
    try {
      getMetricsCollector().incrementCounter(
        'federation_trusts_issued_total',
        'Total federation trusts issued',
        1,
        [
          { name: 'issuer_tenant', value: issuerTenant },
          { name: 'audience_tenant', value: params.audienceTenant },
        ],
      );
    } catch {
      /* metrics unavailable — non-critical */
    }

    return trust;
  }

  // ── Exchange Trust (Audience Tenant) ──────────────────────────────────

  /**
   * Exchange a federation trust token for local agent identities.
   * The audience tenant validates the trust, creates a local agent
   * registration, and issues scoped capability tokens.
   *
   * The caller MUST be in the audience tenant's context.
   */
  exchange(trustedEncoded: string): FederatedExchangeOutcome {
    const audienceTenant = getCurrentTenantId();
    if (!audienceTenant) {
      return {
        accepted: false,
        reason: 'audience_mismatch',
        detail: 'No active tenant context — audience tenant must be set',
      };
    }

    // Decode and validate the trust document
    let trust: FederationTrust;
    try {
      const parsed = JSON.parse(trustedEncoded) as FederationTrust;
      if (
        !parsed.trustId ||
        !parsed.issuerTenant ||
        !parsed.audienceTenant ||
        !parsed.resourceScopes ||
        !parsed.hmacSignature
      ) {
        return { accepted: false, reason: 'malformed_trust', detail: 'missing required fields' };
      }
      trust = parsed;
    } catch {
      return { accepted: false, reason: 'malformed_trust', detail: 'JSON parse failed' };
    }

    // Audience must match
    if (trust.audienceTenant !== audienceTenant) {
      return {
        accepted: false,
        reason: 'audience_mismatch',
        detail: `trust audience=${trust.audienceTenant}, current tenant=${audienceTenant}`,
      };
    }

    // Check revocation
    if (REVOKED_TRUST_IDS.has(trust.trustId)) {
      return {
        accepted: false,
        reason: 'trust_revoked',
        detail: `trust ${trust.trustId.slice(0, 12)}… has been revoked`,
      };
    }

    // Validate expiry
    const nowSec = Math.floor(Date.now() / 1000);
    if (trust.expiresAt < nowSec) {
      return {
        accepted: false,
        reason: 'trust_expired',
        detail: `trust expired at ${trust.expiresAt} (now=${nowSec})`,
      };
    }
    if (trust.issuedAt - 5 > nowSec) {
      return {
        accepted: false,
        reason: 'trust_not_yet_valid',
        detail: `trust issuedAt=${trust.issuedAt} is in the future`,
      };
    }

    // Validate issuer tenant is known
    const tenantProvider = getGlobalTenantProvider();
    const issuerConfig = tenantProvider.getTenantConfig(trust.issuerTenant);
    if (!issuerConfig) {
      this.auditFederationEvent('federation_trust_rejected', trust, {
        reason: 'issuer_unknown',
        detail: `issuer tenant ${trust.issuerTenant} not configured`,
      });
      return {
        accepted: false,
        reason: 'issuer_unknown',
        detail: `issuer tenant ${trust.issuerTenant} is not known to this deployment`,
      };
    }

    // Empty scope check
    if (trust.resourceScopes.length === 0) {
      return { accepted: false, reason: 'empty_scope', detail: 'trust has no resource scopes' };
    }

    // Verify HMAC signature
    const hmacValid = this.verifyHmacSignature(trust);
    if (!hmacValid) {
      // If HMAC fails, try OIDC JWT verification
      const jwtValid = trust.jwtToken ? this.verifyOIDCJWT(trust) : false;
      if (!jwtValid) {
        this.auditFederationEvent('federation_trust_rejected', trust, {
          reason: 'invalid_signature',
          detail: 'both HMAC and JWT verification failed',
        });
        return {
          accepted: false,
          reason: 'invalid_signature',
          detail: 'trust signature verification failed (HMAC and JWT)',
        };
      }
    }

    // Issue local agent identity and capability token
    const agentId = `fed_${trust.issuerTenant}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const lineageInstanceId = crypto.randomUUID().replace(/-/g, '');

    // Map resource scopes to tool names for capability token
    // 'call:web_fetch' → tool 'web_fetch'
    // 'read:reports' → tool 'report_read'
    const tools: string[] = [];
    for (const scope of trust.resourceScopes) {
      if (scope.startsWith('call:')) {
        tools.push(scope.slice(5));
      } else if (scope.startsWith('read:')) {
        tools.push(`${scope.slice(5)}_read`);
      } else if (scope.startsWith('manage:')) {
        tools.push(`${scope.slice(7)}_manage`);
      } else if (scope.startsWith('admin:')) {
        tools.push(`${scope.slice(6)}_admin`);
      }
    }

    // Issue capability token scoped to the trust
    let capabilityToken: string;
    let tokenJti: string;
    try {
      capabilityToken = getCapabilityTokenIssuer().issue({
        sub: agentId,
        aud: trust.issuerTenant,
        tools,
        risk: 'medium',
        ttlSeconds: Math.min(trust.expiresAt - nowSec, 300), // 5 min max
      });
      // Extract the JTI for cascade revocation tracking
      tokenJti = decode(capabilityToken).payload.jti;
    } catch (err) {
      return {
        accepted: false,
        reason: 'malformed_trust',
        detail: `failed to issue capability token: ${(err as Error)?.message}`,
      };
    }

    // Register the trust and derived tokens
    this.activeTrusts.set(trust.trustId, {
      trust,
      derivedTokens: new Set([tokenJti]),
      derivedInstances: new Set([lineageInstanceId]),
    });

    // Record in agent lineage
    try {
      getAgentLineage().spawnChild(
        null, // root-level federated agent (no local parent)
        agentId,
        {
          instanceId: lineageInstanceId,
          role: 'federated',
          runId: `fed_${trust.trustId.slice(0, 12)}`,
          scope: { tools },
          capabilityTokenJti: tokenJti,
          metadata: {
            originTenantId: trust.issuerTenant,
            hostTenantId: audienceTenant,
            trustId: trust.trustId,
            resourceScopes: trust.resourceScopes,
          },
        },
      );
    } catch {
      /* best-effort — lineage is secondary to exchange */
    }

    // Audit (audience tenant context for exchange events)
    this.auditFederationEvent('federation_trust_exchanged', trust, {
      agentId,
      lineageInstanceId,
      derivedTools: tools,
      hostTenantId: audienceTenant,
    });

    // Metrics
    try {
      getMetricsCollector().incrementCounter(
        'federation_trusts_exchanged_total',
        'Total federation trusts exchanged',
        1,
        [
          { name: 'issuer_tenant', value: trust.issuerTenant },
          { name: 'audience_tenant', value: audienceTenant },
        ],
      );
    } catch {
      /* metrics unavailable */
    }

    return {
      accepted: true,
      trust,
      agentId,
      capabilityToken,
      lineageInstanceId,
      tokenExpiresAt: nowSec + Math.min(trust.expiresAt - nowSec, 300),
    };
  }

  // ── Scope Enforcement ──────────────────────────────────────────────────

  /**
   * Verify that a proposed tool call is within the scope of a federation trust.
   * Called by the tool approval system before every federated tool invocation.
   */
  verifyFederationScope(trustId: string, toolName: string): boolean {
    const entry = this.activeTrusts.get(trustId);
    if (!entry) return false;

    // Check revocation (local entry or global revocation set)
    if (entry.revokedAt || REVOKED_TRUST_IDS.has(trustId)) return false;

    // Check expiry
    if (entry.trust.expiresAt < Math.floor(Date.now() / 1000)) return false;

    // Check scope membership
    // Scopes map to tool names: 'call:X' → 'X', 'read:X' → 'X_read', etc.
    // 'admin:*' is a wildcard that grants access to all tools.
    for (const scope of entry.trust.resourceScopes) {
      if (scope === 'admin:*') return true;
      if (scope.startsWith('call:') && scope.slice(5) === toolName) return true;
      if (scope.startsWith('read:') && `${scope.slice(5)}_read` === toolName) return true;
      if (scope.startsWith('manage:') && `${scope.slice(7)}_manage` === toolName) return true;
      if (scope.startsWith('admin:') && `${scope.slice(6)}_admin` === toolName) return true;
    }

    return false;
  }

  /**
   * Get the trust metadata for a given trust ID (origin tenant, scopes, etc.).
   */
  getTrust(trustId: string): FederationTrust | undefined {
    return this.activeTrusts.get(trustId)?.trust;
  }

  // ── Revocation ─────────────────────────────────────────────────────────

  /**
   * Revoke a federation trust and cascade-revoke all derived tokens.
   * This is the "500ms kill switch" for remote agent access.
   *
   * @returns Number of capability tokens and lineage instances revoked.
   */
  revokeTrust(
    trustId: string,
    reason: string = 'manual_revoke',
  ): {
    revoked: boolean;
    tokensRevoked: number;
    instancesKilled: number;
  } {
    const entry = this.activeTrusts.get(trustId);
    if (!entry || entry.revokedAt) {
      return { revoked: false, tokensRevoked: 0, instancesKilled: 0 };
    }

    // Mark trust as revoked
    entry.revokedAt = Date.now();
    entry.revokeReason = reason;
    this.revokedTrusts.add(trustId);
    REVOKED_TRUST_IDS.add(trustId);

    // Cascade-revoke all derived capability tokens
    let tokensRevoked = 0;
    try {
      for (const jti of entry.derivedTokens) {
        if (getCapabilityTokenIssuer().revoke(jti, `federation_revoke: ${reason}`)) {
          tokensRevoked++;
        }
      }
    } catch {
      /* best-effort — token revocation */
    }

    // Cascade-terminate all derived lineage instances
    let instancesKilled = 0;
    try {
      for (const instanceId of entry.derivedInstances) {
        if (getAgentLineage().terminate(instanceId, `federation_revoke: ${reason}`)) {
          instancesKilled++;
        }
      }
    } catch {
      /* best-effort — lineage marking */
    }

    // Audit
    this.auditFederationEvent('federation_trust_revoked', entry.trust, {
      revokeReason: reason,
      tokensRevoked,
      instancesKilled,
    });

    // Metrics
    try {
      getMetricsCollector().incrementCounter(
        'federation_trusts_revoked_total',
        'Total federation trusts revoked',
        1,
        [
          { name: 'issuer_tenant', value: entry.trust.issuerTenant },
          { name: 'audience_tenant', value: entry.trust.audienceTenant },
        ],
      );
    } catch {
      /* metrics unavailable */
    }

    return { revoked: true, tokensRevoked, instancesKilled };
  }

  // ── Query API ──────────────────────────────────────────────────────────

  /** List all active (non-revoked, non-expired) trusts. */
  listActiveTrusts(): FederationTrust[] {
    const nowSec = Math.floor(Date.now() / 1000);
    const result: FederationTrust[] = [];
    for (const entry of this.activeTrusts.values()) {
      if (!entry.revokedAt && entry.trust.expiresAt >= nowSec) {
        result.push(entry.trust);
      }
    }
    return result;
  }

  /** Get the trust entry for a given trust ID (full details). */
  getTrustEntry(trustId: string): TrustEntry | undefined {
    return this.activeTrusts.get(trustId);
  }

  /** Associate a derived capability token JTI with a trust. */
  trackDerivedToken(trustId: string, tokenJti: string): boolean {
    const entry = this.activeTrusts.get(trustId);
    if (!entry) return false;
    entry.derivedTokens.add(tokenJti);
    return true;
  }

  /** Associate a derived lineage instance with a trust. */
  trackDerivedInstance(trustId: string, instanceId: string): boolean {
    const entry = this.activeTrusts.get(trustId);
    if (!entry) return false;
    entry.derivedInstances.add(instanceId);
    return true;
  }

  /** Clear all state. Test isolation only. */
  reset(): void {
    this.activeTrusts.clear();
    this.revokedTrusts.clear();
    REVOKED_TRUST_IDS.clear();
  }

  // ── Crypto Internals ───────────────────────────────────────────────────

  /**
   * Verify the HMAC signature on a trust document.
   * Note: HMAC verification assumes a shared keychain (intra-org).
   * For true cross-org federation, the OIDC JWT path with RS256
   * public-key cryptography must be used (see verifyOIDCJWT below).
   */
  private verifyHmacSignature(trust: FederationTrust): boolean {
    const canonicalPayload = deterministicStringify({
      v: TRUST_PROTOCOL_VERSION,
      trustId: trust.trustId,
      issuerTenant: trust.issuerTenant,
      audienceTenant: trust.audienceTenant,
      resourceScopes: trust.resourceScopes,
      maxDepth: trust.maxDepth,
      expiresAt: trust.expiresAt,
      issuedAt: trust.issuedAt,
      metadata: trust.metadata ?? null,
    });

    const expected = crypto
      .createHmac('sha256', this.hmacKey)
      .update(canonicalPayload)
      .digest('hex');

    if (expected.length !== trust.hmacSignature.length) return false;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected, 'utf-8'),
        Buffer.from(trust.hmacSignature, 'utf-8'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Verify the OIDC JWT signature on a trust document.
   */
  private verifyOIDCJWT(trust: FederationTrust): boolean {
    if (!trust.jwtToken) return false;
    try {
      const parts = trust.jwtToken.split('.');
      if (parts.length !== 3) return false;

      const payload = JSON.parse(b64urlDecode(parts[1]!));
      // Verify the JWT payload matches the trust document
      if (payload.sub !== trust.trustId) return false;
      if (payload.aud !== trust.audienceTenant) return false;

      // Full JWT verification requires the issuer's public key.
      // In production, this would call the OIDCAuthPlugin to verify.
      // For now, we check structural validity when a private key is configured.
      if (!this.oidcPrivateKey) {
        // Without a private key, we can't verify RS256 signatures.
        // The HMAC signature is the primary trust mechanism.
        return false;
      }

      // Decode base64url signature directly to raw binary Buffer.
      // Note: uses the issuer's *public* key for verification (derived from
      // the private key for intra-org setups). True cross-org federation
      // requires the issuer's public key via JWKS or direct configuration.
      try {
        const data = `${parts[0]}.${parts[1]}`;
        const rawSig = parts[2]!.replace(/-/g, '+').replace(/_/g, '/');
        const pad = (4 - (rawSig.length % 4)) % 4;
        const signature = Buffer.from(rawSig + '='.repeat(pad), 'base64');
        const privateKey = crypto.createPrivateKey(this.oidcPrivateKey);
        const publicKey = crypto.createPublicKey(privateKey);
        return crypto.verify('sha256', Buffer.from(data, 'utf-8'), publicKey, signature);
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Sign the trust payload as an OIDC JWT (RS256).
   * The JWT is a standard JWT with `iss: issuerTenant`, `sub: trustId`,
   * `aud: audienceTenant`, and custom claims for scopes and depth.
   */
  private signOIDCJWT(
    trust: Omit<FederationTrust, 'hmacSignature' | 'jwtToken'>,
    privateKeyPem: string,
  ): string {
    const header = { alg: 'RS256', typ: 'JWT' };
    const headerB64 = b64urlEncode(JSON.stringify(header));

    const payload = {
      iss: trust.issuerTenant,
      sub: trust.trustId,
      aud: trust.audienceTenant,
      iat: trust.issuedAt,
      exp: trust.expiresAt,
      resourceScopes: trust.resourceScopes,
      maxDepth: trust.maxDepth,
      ...trust.metadata,
    };
    const payloadB64 = b64urlEncode(JSON.stringify(payload));

    const data = `${headerB64}.${payloadB64}`;
    const key = crypto.createPrivateKey(privateKeyPem);
    const rawSignature = crypto.sign('sha256', Buffer.from(data, 'utf-8'), key);
    // Encode raw binary signature directly to base64url (not double-encoded)
    const signatureB64 = rawSignature
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    return `${data}.${signatureB64}`;
  }

  // ── Audit ──────────────────────────────────────────────────────────────

  private auditFederationEvent(
    type:
      | 'federation_trust_issued'
      | 'federation_trust_exchanged'
      | 'federation_trust_revoked'
      | 'federation_trust_rejected',
    trust: FederationTrust,
    extra?: Record<string, unknown>,
  ): void {
    const severity: SecurityEvent['severity'] =
      type === 'federation_trust_revoked' ? 'high' : 'medium';

    const event: SecurityEvent = {
      id: `fed_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      type: 'config_change', // federation events are configuration-layer changes
      severity,
      source: 'FederatedIdentity',
      message: `${type}: ${trust.issuerTenant} → ${trust.audienceTenant} (${trust.trustId.slice(0, 12)}…)`,
      details: {
        federationEventType: type,
        trustId: trust.trustId,
        issuerTenant: trust.issuerTenant,
        audienceTenant: trust.audienceTenant,
        resourceScopes: trust.resourceScopes,
        maxDepth: trust.maxDepth,
        expiresAt: trust.expiresAt,
        ...extra,
      },
      context: {
        tenantId: trust.issuerTenant,
      },
    };

    try {
      getAuditChainLedger().logEvent(event);
    } catch (err) {
      recordSinkFailure('federatedIdentity');
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[federatedIdentity] audit chain unavailable: ${(err as Error)?.message ?? String(err)}`,
        );
      } catch {
        /* stderr inaccessible */
      }
    }
  }
}

// ============================================================================
// Tenant-aware singleton
// ============================================================================

const federatedIdentitySingleton = createTenantAwareSingleton(() => new FederatedIdentity());

/** Resolve the active FederatedIdentity via the current tenant context. */
export function getFederatedIdentity(): FederatedIdentity {
  return federatedIdentitySingleton.get();
}

/** Reset all federation instances. Test isolation only. */
export function resetFederatedIdentity(): void {
  federatedIdentitySingleton.reset();
}
