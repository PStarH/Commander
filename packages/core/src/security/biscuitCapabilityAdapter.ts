/**
 * Biscuit Capability Token Adapter
 *
 * Bridges the BiscuitToken (Ed25519 + Datalog) system to the same API
 * as the HMAC-based CapabilityTokenIssuer, allowing the runtime to
 * upgrade to asymmetric Ed25519 signatures without changing callers.
 *
 * Key differences from HMAC:
 * - Ed25519 asymmetric signatures (no shared secret for verification)
 * - Datalog policy expressions (not just scope lists)
 * - Block chain attenuation (each block signed by previous block's key)
 * - Offline verification (verifier only needs public key, not master key)
 *
 * Wire format: base64-encoded BiscuitCapabilityToken serialize() output.
 * Detection: tokens starting with 'bsc_' are Biscuit tokens; others are HMAC.
 *
 * Per constraint NFR-SEC-02, tokens SHALL be unforgeable.
 */

import * as crypto from 'node:crypto';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import {
  BiscuitTokenIssuer,
  BiscuitTokenVerifier,
  BiscuitCapabilityToken,
  allow,
  type DatalogFact,
} from './biscuitToken';

// ============================================================================
// Types (matching the HMAC capabilityToken.ts interfaces)
// ============================================================================

export interface BiscuitIssueOptions {
  sub: string;
  aud: string;
  tools: string[];
  ttlSeconds?: number;
  risk?: string;
}

export interface BiscuitVerifyRequest {
  tool: string;
  args: Record<string, unknown>;
}

export interface BiscuitVerifyResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  jti?: string;
}

// ============================================================================
// Biscuit Capability Token Adapter
// ============================================================================

/** Prefix for Biscuit tokens (to distinguish from HMAC tokens). */
export const BISCUIT_TOKEN_PREFIX = 'bsc_';

/**
 * Adapter that wraps BiscuitTokenIssuer to expose the same API as
 * CapabilityTokenIssuer (issue/verify via separate Verifier).
 *
 * The adapter translates HMAC-style claims (sub, aud, tools, ttl) into
 * Biscuit Datalog facts (allow("tool_name") for each tool).
 */
export class BiscuitCapabilityAdapter {
  private issuer: BiscuitTokenIssuer;
  private verifier: BiscuitTokenVerifier;
  private maxTtlSeconds: number;

  constructor(options?: { maxTtlSeconds?: number }) {
    this.issuer = new BiscuitTokenIssuer();
    this.verifier = new BiscuitTokenVerifier(this.issuer.getIssuerPublicKey());
    this.maxTtlSeconds = options?.maxTtlSeconds ?? 300;
  }

  /**
   * Issue a capability token backed by Ed25519 signatures.
   *
   * Creates a Biscuit root token with:
   * - One `allow("tool_name")` fact per tool in the scope
   * - An expiry fact for TTL enforcement
   * - A `subject("agent_id")` fact for identity binding
   * - A `tenant("tenant_id")` fact for audience checking
   */
  issue(opts: BiscuitIssueOptions): string {
    if (!opts.tools || opts.tools.length === 0) {
      throw new Error('tools array must contain at least one entry');
    }

    const ttl = opts.ttlSeconds ?? this.maxTtlSeconds;
    if (ttl <= 0) {
      throw new Error(`ttlSeconds must be > 0 (got ${ttl})`);
    }

    // Build Datalog facts for the token
    const facts: DatalogFact[] = [
      // Subject (agent identity)
      { predicate: 'subject', args: [opts.sub] },
      // Tenant (audience)
      { predicate: 'tenant', args: [opts.aud] },
      // TTL expiry
      { predicate: 'expiry', args: [Math.floor(Date.now() / 1000) + ttl] },
    ];

    // Add allow facts for each tool
    for (const tool of opts.tools) {
      facts.push(allow(tool));
    }

    // Issue the Biscuit token
    const token = this.issuer.issue({
      expiry: Math.floor(Date.now() / 1000) + ttl,
      facts,
      tokenId: `bsc_${crypto.randomBytes(8).toString('hex')}`,
    });

    // Serialize and prefix for detection
    const serialized = Buffer.from(token.serialize()).toString('base64');
    return BISCUIT_TOKEN_PREFIX + serialized;
  }

  /**
   * Create a verifier for a specific tenant.
   * The verifier checks that the token's tenant fact matches the expected audience.
   */
  createVerifier(expectedAud?: string): BiscuitCapabilityVerifier {
    return new BiscuitCapabilityVerifier(this.verifier, expectedAud);
  }

  /**
   * Get the issuer's public key (for offline verification distribution).
   */
  getIssuerPublicKey(): string {
    return this.issuer.getIssuerPublicKey();
  }

  /**
   * Check if a token string is a Biscuit token (vs HMAC).
   */
  static isBiscuitToken(token: string): boolean {
    return token.startsWith(BISCUIT_TOKEN_PREFIX);
  }
}

// ============================================================================
// Biscuit Capability Verifier
// ============================================================================

/**
 * Verifier for Biscuit capability tokens.
 * Implements the same verify() interface as CapabilityTokenVerifier.
 */
export class BiscuitCapabilityVerifier {
  private biscuitVerifier: BiscuitTokenVerifier;
  private expectedAud?: string;

  constructor(biscuitVerifier: BiscuitTokenVerifier, expectedAud?: string) {
    this.biscuitVerifier = biscuitVerifier;
    this.expectedAud = expectedAud;
  }

  /**
   * Verify a Biscuit capability token.
   *
   * Checks:
   * 1. Token format (must start with 'bsc_')
   * 2. Ed25519 signature chain (all blocks)
   * 3. Expiry (not expired)
   * 4. Authorization (allow("tool") fact exists for the requested tool)
   * 5. Tenant matching (if expectedAud is set)
   */
  verify(encoded: string, req: BiscuitVerifyRequest): BiscuitVerifyResult {
    // Check format
    if (!BiscuitCapabilityAdapter.isBiscuitToken(encoded)) {
      return {
        ok: false,
        reason: 'malformed_encoding',
        detail: 'not a Biscuit token (missing bsc_ prefix)',
      };
    }

    // Decode
    const b64Data = encoded.slice(BISCUIT_TOKEN_PREFIX.length);
    let token: BiscuitCapabilityToken;
    try {
      const bytes = new Uint8Array(Buffer.from(b64Data, 'base64'));
      token = BiscuitCapabilityToken.deserialize(bytes);
    } catch (err) {
      reportSilentFailure(err, 'biscuitCapability:decode');
      return {
        ok: false,
        reason: 'malformed_payload',
        detail: 'failed to deserialize Biscuit token',
      };
    }

    // Verify signatures against the TRUSTED issuer public key (via the
    // configured verifier). Never call token.verify() with no key — that would
    // trust the token's own embedded key and accept any self-signed forgery.
    if (!this.biscuitVerifier.verify(token)) {
      return {
        ok: false,
        reason: 'signature_mismatch',
        detail: 'Ed25519 signature verification failed',
      };
    }

    // Check authorization: is this tool allowed?
    const authorized = token.authorize({
      predicate: 'allow',
      args: [req.tool],
    });

    if (!authorized) {
      return {
        ok: false,
        reason: 'scope_violation',
        detail: `tool '${req.tool}' is not in the token's allow scope`,
      };
    }

    // Check tenant (audience) if expectedAud is set
    if (this.expectedAud && this.expectedAud !== '*') {
      const tenantAuthorized = token.authorize({
        predicate: 'tenant',
        args: [this.expectedAud],
      });
      if (!tenantAuthorized) {
        return {
          ok: false,
          reason: 'aud_mismatch',
          detail: `token tenant does not match expected audience '${this.expectedAud}'`,
        };
      }
    }

    // Extract a pseudo-jti from the token's first block
    const jti = crypto.createHash('sha256').update(b64Data.slice(0, 64)).digest('hex').slice(0, 32);

    getGlobalLogger().debug('BiscuitCapability', 'Token verified', {
      tool: req.tool,
      jti: jti.slice(0, 12) + '...',
    });

    return { ok: true, jti };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalBiscuitAdapter: BiscuitCapabilityAdapter | null = null;

export function getGlobalBiscuitCapabilityAdapter(): BiscuitCapabilityAdapter {
  if (!globalBiscuitAdapter) {
    globalBiscuitAdapter = new BiscuitCapabilityAdapter();
  }
  return globalBiscuitAdapter;
}
