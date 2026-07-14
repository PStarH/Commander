/**
 * SignedPolicyBundle — HMAC-signed, version-pinned policy bundle wrapper.
 *
 * Design:
 * - Policy bundles are HMAC-SHA256 signed at publication time. Consumers
 *   verify the signature before loading the bundle, preventing tampering.
 * - A run "pins" to a specific policy snapshot ID at creation time. All
 *   subsequent policy decisions for that run use the pinned snapshot.
 * - Decision logs are persisted to an append-only store for audit trails.
 *
 * This implements the "PDP/PEP separation" required by WP5:
 * - PDP (Policy Decision Point): the PolicyEngine evaluates rules.
 * - PEP (Policy Enforcement Point): the EffectBroker enforces decisions.
 * - This module sits between them: it loads signed bundles, pins versions,
 *   and logs decisions for non-repudiation.
 */

import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { canonicalJson } from '../atr/policy/engine';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface PolicyBundlePayload {
  /** Bundle name (e.g., "default", "strict"). */
  name: string;
  /** Monotonically increasing version number. */
  version: number;
  /** Stable snapshot ID for pinning (e.g., "ps_20260712_v1"). */
  snapshotId: string;
  /** Default effect when no rule matches. */
  effectDefaults: {
    allow: boolean;
    requireApproval: boolean;
  };
  /** The serialized policy rules (AST or DSL). */
  rules: unknown;
  /** Schema version of the rules format. */
  schemaVersion: string;
  /** ISO timestamp of publication. */
  publishedAt: string;
}

export interface SignedPolicyBundle extends PolicyBundlePayload {
  /** Signature over the canonical JSON of PolicyBundlePayload (hex). */
  signature: string;
  /** Signing key ID (for key rotation). */
  keyId: string;
  /**
   * MCP-13: signature scheme. Defaults to 'hmac-sha256' when absent (legacy
   * bundles). 'ed25519' allows publishing a public verification key so
   * verifiers need not hold the signing secret. The manager verifies with its
   * own configured algorithm — this field is a label, not an input to scheme
   * selection, so a bundle cannot force a downgrade.
   */
  algorithm?: 'hmac-sha256' | 'ed25519';
}

export interface PinnedPolicyRef {
  /** The snapshot ID that a run is pinned to. */
  snapshotId: string;
  /** The run ID that owns this pin. */
  runId: string;
  /** Tenant that owns this run. */
  tenantId: string;
  /** ISO timestamp when the pin was created. */
  pinnedAt: string;
}

export interface PolicyDecisionLogEntry {
  decisionId: string;
  tenantId: string;
  runId: string;
  stepId: string;
  effect: 'allow' | 'deny' | 'require_approval';
  reason: string;
  snapshotId: string;
  packVersion: number;
  riskScore: number;
  latencyMs: number;
  decidedAt: string;
}

export interface DecisionLogStore {
  append(entry: PolicyDecisionLogEntry): Promise<void>;
  query(input: {
    runId?: string;
    tenantId?: string;
    limit?: number;
  }): Promise<PolicyDecisionLogEntry[]>;
}

// ──────────────────────────────────────────────────────────────────────────
// In-memory decision log (default; production should use PostgreSQL)
// ──────────────────────────────────────────────────────────────────────────

export class InMemoryDecisionLog implements DecisionLogStore {
  private readonly entries: PolicyDecisionLogEntry[] = [];
  private static readonly MAX = 50_000;

  async append(entry: PolicyDecisionLogEntry): Promise<void> {
    this.entries.push(entry);
    if (this.entries.length > InMemoryDecisionLog.MAX) {
      this.entries.shift();
    }
  }

  async query(input: {
    runId?: string;
    tenantId?: string;
    limit?: number;
  }): Promise<PolicyDecisionLogEntry[]> {
    let result = this.entries;
    if (input.runId) {
      result = result.filter((e) => e.runId === input.runId);
    }
    if (input.tenantId) {
      result = result.filter((e) => e.tenantId === input.tenantId);
    }
    const limit = input.limit ?? 100;
    return result.slice(-limit);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SignedPolicyBundleManager
// ──────────────────────────────────────────────────────────────────────────

export class SignedPolicyBundleManager {
  private signingKey: string;
  private keyId: string;
  private readonly algorithm: 'hmac-sha256' | 'ed25519';
  private privateKey: KeyObject | null = null;
  private publicKey: KeyObject | null = null;
  private readonly bundles = new Map<string, SignedPolicyBundle>();
  private readonly pins = new Map<string, PinnedPolicyRef>();
  private readonly decisionLog: DecisionLogStore;

  constructor(config: {
    /** HMAC secret (hmac-sha256 mode). Required unless an ed25519 key is supplied. */
    signingKey?: string;
    keyId?: string;
    decisionLog?: DecisionLogStore;
    /** MCP-13: signature scheme. Inferred from the supplied keys when omitted. */
    algorithm?: 'hmac-sha256' | 'ed25519';
    /** Ed25519 private key (PEM/DER) — required to publish/sign in ed25519 mode. */
    ed25519PrivateKeyPem?: string;
    /** Ed25519 public key (PEM/DER) — required to verify in ed25519 mode. */
    ed25519PublicKeyPem?: string;
  }) {
    this.algorithm =
      config.algorithm ??
      (config.ed25519PrivateKeyPem || config.ed25519PublicKeyPem ? 'ed25519' : 'hmac-sha256');
    this.keyId =
      config.keyId ?? (this.algorithm === 'ed25519' ? 'spk_ed25519' : 'spk_default');
    this.decisionLog = config.decisionLog ?? new InMemoryDecisionLog();

    if (this.algorithm === 'ed25519') {
      // A signer needs the private key; a verify-only replica may hold only the
      // public key. At least one must be present.
      if (config.ed25519PrivateKeyPem) {
        this.privateKey = createPrivateKey(config.ed25519PrivateKeyPem);
        // Derive the matching public key so a signer can also self-verify.
        this.publicKey = config.ed25519PublicKeyPem
          ? createPublicKey(config.ed25519PublicKeyPem)
          : createPublicKey(this.privateKey);
      } else if (config.ed25519PublicKeyPem) {
        this.publicKey = createPublicKey(config.ed25519PublicKeyPem);
      } else {
        throw new Error(
          'SignedPolicyBundle ed25519 mode requires ed25519PrivateKeyPem (signer) or ed25519PublicKeyPem (verifier)',
        );
      }
      this.signingKey = ''; // unused in asymmetric mode
    } else {
      if (!config.signingKey || config.signingKey.length < 32) {
        throw new Error('SignedPolicyBundle signing key must be at least 32 characters');
      }
      this.signingKey = config.signingKey;
    }
  }

  /** Compute a signature over the canonical payload using the configured scheme. */
  private computeSignature(canonical: string): string {
    if (this.algorithm === 'ed25519') {
      if (!this.privateKey) {
        throw new Error('SignedPolicyBundle: cannot sign in ed25519 mode without a private key');
      }
      return cryptoSign(null, Buffer.from(canonical), this.privateKey).toString('hex');
    }
    return createHmac('sha256', this.signingKey).update(canonical).digest('hex');
  }

  /** Constant-time / cryptographic verification of a hex signature. Never throws. */
  private verifySignature(canonical: string, signatureHex: string): boolean {
    try {
      if (this.algorithm === 'ed25519') {
        if (!this.publicKey) return false;
        const sig = Buffer.from(signatureHex, 'hex');
        return cryptoVerify(null, Buffer.from(canonical), this.publicKey, sig);
      }
      const expected = createHmac('sha256', this.signingKey).update(canonical).digest('hex');
      const a = Buffer.from(signatureHex);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch (err) {
      reportSilentFailure(err, 'signedPolicyBundle:verifySignature');
      return false;
    }
  }

  /**
   * Sign a policy bundle payload and register it.
   */
  publish(payload: PolicyBundlePayload): SignedPolicyBundle {
    const canonical = canonicalJson(payload);
    const signature = this.computeSignature(canonical);
    const bundle: SignedPolicyBundle = {
      ...payload,
      signature,
      keyId: this.keyId,
      algorithm: this.algorithm,
    };
    this.bundles.set(bundle.snapshotId, bundle);
    try {
      getGlobalLogger().info('SignedPolicyBundle', 'Published', {
        snapshotId: bundle.snapshotId,
        version: bundle.version,
        name: bundle.name,
      });
    } catch (err) {
      reportSilentFailure(err, 'signedPolicyBundle:publish');
    }
    return bundle;
  }

  /**
   * Verify a signed bundle's signature and load it.
   * Throws if the signature is invalid.
   */
  verifyAndLoad(bundle: SignedPolicyBundle): void {
    const { signature, keyId, algorithm: _algorithm, ...payload } = bundle;
    const canonical = canonicalJson(payload);
    if (!this.verifySignature(canonical, signature)) {
      throw new SignedPolicyBundleError(
        'SIGNATURE_INVALID',
        'Bundle signature verification failed',
      );
    }
    if (keyId !== this.keyId) {
      throw new SignedPolicyBundleError(
        'KEY_MISMATCH',
        `Bundle keyId '${keyId}' does not match '${this.keyId}'`,
      );
    }
    this.bundles.set(bundle.snapshotId, bundle);
  }

  /**
   * Rotate the active signing key. Bundles signed with the previous key
   * will fail signature verification against the new key, enabling old-key
   * revocation after a rotation.
   */
  setActiveKey(key: string, keyId: string): void {
    if (this.algorithm !== 'hmac-sha256') {
      throw new Error('setActiveKey is only valid in hmac-sha256 mode');
    }
    if (key.length < 32) {
      throw new Error('SignedPolicyBundle signing key must be at least 32 characters');
    }
    this.signingKey = key;
    this.keyId = keyId;
  }

  /** The active signature scheme. */
  getAlgorithm(): 'hmac-sha256' | 'ed25519' {
    return this.algorithm;
  }

  /**
   * MCP-13: export the Ed25519 public verification key (SPKI PEM) so it can be
   * published for offline/third-party verification. Returns null in HMAC mode
   * (a symmetric secret must never be published).
   */
  getPublicKeyPem(): string | null {
    if (this.algorithm !== 'ed25519' || !this.publicKey) return null;
    return this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /**
   * Retrieve a stored bundle, re-verifying its signature and keyId against
   * the current active signing key. Throws SIGNATURE_INVALID or KEY_MISMATCH
   * if the bundle was signed with a rotated-out key.
   */
  retrieve(snapshotId: string): SignedPolicyBundle {
    const bundle = this.bundles.get(snapshotId);
    if (!bundle) {
      throw new SignedPolicyBundleError('SNAPSHOT_NOT_FOUND', `Snapshot '${snapshotId}' not found`);
    }
    const { signature, keyId, algorithm: _algorithm, ...payload } = bundle;
    const canonical = canonicalJson(payload);
    if (!this.verifySignature(canonical, signature)) {
      throw new SignedPolicyBundleError(
        'SIGNATURE_INVALID',
        `Bundle '${snapshotId}' signature verification failed (active key may have rotated)`,
      );
    }
    if (keyId !== this.keyId) {
      throw new SignedPolicyBundleError(
        'KEY_MISMATCH',
        `Bundle keyId '${keyId}' does not match active keyId '${this.keyId}'`,
      );
    }
    return bundle;
  }

  /**
   * Pin a run to a specific policy snapshot.
   * All subsequent decisions for this run will use the pinned snapshot.
   */
  pin(runId: string, tenantId: string, snapshotId: string): PinnedPolicyRef {
    const bundle = this.bundles.get(snapshotId);
    if (!bundle) {
      throw new SignedPolicyBundleError('SNAPSHOT_NOT_FOUND', `Snapshot '${snapshotId}' not found`);
    }
    const ref: PinnedPolicyRef = {
      snapshotId,
      runId,
      tenantId,
      pinnedAt: new Date().toISOString(),
    };
    this.pins.set(runId, ref);
    return ref;
  }

  /**
   * Get the pinned snapshot for a run, or null if not pinned.
   */
  getPin(runId: string): PinnedPolicyRef | null {
    return this.pins.get(runId) ?? null;
  }

  /**
   * Resolve the policy bundle for a run (uses pinned snapshot if available,
   * otherwise returns the latest bundle).
   *
   * When `tenantId` is provided and the run is pinned, the caller's tenant
   * must match the pin's tenant — otherwise a TENANT_MISMATCH error is thrown,
   * preventing cross-tenant pin forgery.
   */
  resolveForRun(runId: string, tenantId?: string): SignedPolicyBundle {
    const pin = this.pins.get(runId);
    if (pin) {
      if (tenantId !== undefined && pin.tenantId !== tenantId) {
        throw new SignedPolicyBundleError(
          'TENANT_MISMATCH',
          `Run '${runId}' is pinned by tenant '${pin.tenantId}', not '${tenantId}'`,
        );
      }
      const bundle = this.bundles.get(pin.snapshotId);
      if (bundle) return bundle;
      throw new SignedPolicyBundleError(
        'PINNED_BUNDLE_MISSING',
        `Pinned bundle '${pin.snapshotId}' not found`,
      );
    }
    // Fall back to the most recently published bundle
    const bundles = [...this.bundles.values()].sort((a, b) => b.version - a.version);
    if (bundles.length === 0) {
      throw new SignedPolicyBundleError('NO_BUNDLES', 'No policy bundles have been published');
    }
    return bundles[0]!;
  }

  /**
   * Unpin a run (e.g., when the run completes or is cancelled).
   */
  unpin(runId: string): void {
    this.pins.delete(runId);
  }

  /**
   * Log a policy decision for audit/non-repudiation.
   */
  async logDecision(entry: Omit<PolicyDecisionLogEntry, 'decidedAt'>): Promise<void> {
    const fullEntry: PolicyDecisionLogEntry = {
      ...entry,
      decidedAt: new Date().toISOString(),
    };
    await this.decisionLog.append(fullEntry);
  }

  /**
   * Query decision log entries.
   */
  async queryDecisions(input: {
    runId?: string;
    tenantId?: string;
    limit?: number;
  }): Promise<PolicyDecisionLogEntry[]> {
    return this.decisionLog.query(input);
  }

  /**
   * Get all registered bundles (for inspection).
   */
  getBundles(): SignedPolicyBundle[] {
    return [...this.bundles.values()];
  }

  /**
   * Verify that a given bundle is still registered and its signature is valid.
   */
  verifyIntegrity(snapshotId: string): boolean {
    const bundle = this.bundles.get(snapshotId);
    if (!bundle) return false;
    const { signature, keyId: _keyId, algorithm: _algorithm, ...payload } = bundle;
    const canonical = canonicalJson(payload);
    return this.verifySignature(canonical, signature);
  }
}

export class SignedPolicyBundleError extends Error {
  constructor(
    readonly code:
      | 'SIGNATURE_INVALID'
      | 'KEY_MISMATCH'
      | 'SNAPSHOT_NOT_FOUND'
      | 'PINNED_BUNDLE_MISSING'
      | 'NO_BUNDLES'
      | 'TENANT_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'SignedPolicyBundleError';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let bundleManagerInstance: SignedPolicyBundleManager | null = null;

export function getSignedPolicyBundleManager(config?: {
  signingKey: string;
  keyId?: string;
  decisionLog?: DecisionLogStore;
}): SignedPolicyBundleManager {
  if (!bundleManagerInstance || config) {
    // MCP-13: prefer asymmetric (Ed25519) signing when configured via env, so a
    // public verification key can be distributed to replicas / auditors without
    // sharing the signing secret. Falls back to HMAC otherwise.
    const ed25519Private = process.env.COMMANDER_POLICY_ED25519_PRIVATE_KEY;
    const ed25519Public = process.env.COMMANDER_POLICY_ED25519_PUBLIC_KEY;
    if (!config && (ed25519Private || ed25519Public)) {
      bundleManagerInstance = new SignedPolicyBundleManager({
        algorithm: 'ed25519',
        ed25519PrivateKeyPem: ed25519Private,
        ed25519PublicKeyPem: ed25519Public,
        keyId: process.env.COMMANDER_POLICY_SIGNING_KEY_ID,
      });
      return bundleManagerInstance;
    }
    const signingKey =
      config?.signingKey ?? process.env.COMMANDER_POLICY_SIGNING_KEY ?? randomFallbackKey();
    bundleManagerInstance = new SignedPolicyBundleManager({
      signingKey,
      keyId: config?.keyId,
      decisionLog: config?.decisionLog,
    });
  }
  return bundleManagerInstance;
}

export function resetSignedPolicyBundleManager(): void {
  bundleManagerInstance = null;
}

function randomFallbackKey(): string {
  // MCP-13: a random per-process key silently breaks cross-process/replica
  // verification and non-repudiation. Fail closed in production rather than
  // fabricate a throwaway key; only dev/test may fall back.
  if (
    process.env.NODE_ENV === 'production' &&
    !['1', 'true', 'yes'].includes(
      (process.env.COMMANDER_ALLOW_EPHEMERAL_POLICY_KEY ?? '').toLowerCase(),
    )
  ) {
    throw new Error(
      'COMMANDER_POLICY_SIGNING_KEY must be set in production. Refusing to sign policy ' +
        'bundles with a random per-process key (breaks cross-replica verification and ' +
        'non-repudiation). Set COMMANDER_ALLOW_EPHEMERAL_POLICY_KEY=1 to override for a ' +
        'single-process deployment.',
    );
  }
  const key = randomBytes(32).toString('hex');
  try {
    getGlobalLogger().warn(
      'SignedPolicyBundle',
      'Using random fallback signing key (dev only). Set COMMANDER_POLICY_SIGNING_KEY for production.',
    );
  } catch {
    // ignore
  }
  return key;
}
