/**
 * KeyProvider — SPI for signing/verification key material.
 *
 * LocalJwksKeyProvider simulates JWKS key rotation in-memory. It is marked
 * with `keySource: 'simulated'` so all consumers know these keys are not backed
 * by a cloud KMS/HSM. Rotation supports a grace window during which the previous
 * active key remains available as a retiring verification key. Revocation is
 * immediate and permanent.
 */

import * as crypto from 'node:crypto';

/** A single key record returned by a {@link KeyProvider}. */
export interface KeyMaterial {
  /** Key identifier, globally unique within the provider. */
  kid: string;
  /** JWS/JWT algorithm this key is intended for. */
  algorithm: 'HS256';
  /** Raw key bytes. */
  key: Buffer;
  /** Lifecycle status of the key. */
  status: 'active' | 'retiring' | 'revoked';
  /** When the key was issued. */
  issuedAt: Date;
  /** When a retiring key expires and must no longer be used for verification. */
  expiresAt?: Date;
}

/** Source of truth for signing and verification keys. */
export interface KeyProvider {
  /** Identifies the key backend. All local-JWKS results must be `simulated`. */
  readonly keySource: 'simulated' | 'aws_kms' | 'gcp_kms' | 'azure_keyvault';

  /** Prepare the provider (generate initial keys, load JWKS, etc.). */
  initialize(): Promise<void>;

  /** Returns the current active signing key. */
  currentSigningKey(): Promise<KeyMaterial>;

  /** Returns all non-revoked keys suitable for verifying existing signatures. */
  verificationKeys(): Promise<KeyMaterial[]>;

  /** Rotates to a new active key, demoting the previous active key to retiring. */
  rotate(): Promise<KeyMaterial>;

  /** Revokes a key by kid. Unknown kid throws. */
  revoke(kid: string): Promise<void>;
}

/** In-memory JWKS simulator with rotation, grace window, and revocation. */
export class LocalJwksKeyProvider implements KeyProvider {
  readonly keySource = 'simulated';
  private keys: KeyMaterial[] = [];

  constructor(
    private opts: {
      /** Path hint (reserved for future file-backed JWKS; currently unused). */
      path: string;
      /** Must be `true`; local JWKS is always simulated. */
      simulated: true;
      /** Grace window in seconds before a retiring key is no longer verifiable. */
      graceSeconds?: number;
    },
  ) {}

  async initialize(): Promise<void> {
    this.keys = [this.generateKey('active')];
  }

  async currentSigningKey(): Promise<KeyMaterial> {
    this.pruneRetiringKeys();
    const active = this.keys.find((k) => k.status === 'active');
    if (!active) {
      throw new Error('No active signing key');
    }
    return active;
  }

  async verificationKeys(): Promise<KeyMaterial[]> {
    this.pruneRetiringKeys();
    return this.keys.filter((k) => k.status !== 'revoked');
  }

  async rotate(): Promise<KeyMaterial> {
    const graceSeconds = this.opts.graceSeconds ?? 300;
    const graceExpiry = new Date(Date.now() + graceSeconds * 1000);

    for (const k of this.keys) {
      if (k.status === 'active') {
        k.status = 'retiring';
        k.expiresAt = graceExpiry;
      }
    }

    const next = this.generateKey('active');
    this.keys.push(next);
    return next;
  }

  async revoke(kid: string): Promise<void> {
    const key = this.keys.find((k) => k.kid === kid);
    if (!key) {
      throw new Error(`Unknown kid: ${kid}`);
    }
    key.status = 'revoked';
    key.expiresAt = undefined;
  }

  private generateKey(status: KeyMaterial['status']): KeyMaterial {
    return {
      kid: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      algorithm: 'HS256',
      key: crypto.randomBytes(32),
      status,
      issuedAt: new Date(),
    };
  }

  /** Promote retiring keys past their grace window to revoked. */
  private pruneRetiringKeys(): void {
    const now = Date.now();
    for (const k of this.keys) {
      if (k.status === 'retiring' && k.expiresAt && k.expiresAt.getTime() <= now) {
        k.status = 'revoked';
        k.expiresAt = undefined;
      }
    }
  }
}
