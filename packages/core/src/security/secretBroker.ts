/**
 * SecretBroker — Architecture V2 short-lived credential management.
 *
 * Design principles:
 * - Credentials are NEVER passed as raw strings across trust boundaries.
 *   Instead, a `SecretHandle` (opaque reference) is issued with a TTL.
 * - The broker delegates the actual secret material retrieval to a pluggable
 *   `KmsAdapter` (AWS KMS, GCP KMS, HashiCorp Vault, or env-var fallback).
 * - All `issue()` / `access()` / `revoke()` calls are recorded in an audit log.
 * - Expired handles are automatically rejected; a background sweep cleans them.
 *
 * This is the "Containment" layer of the 3-layer defense architecture:
 * even if an attacker obtains a SecretHandle, it expires within minutes and
 * carries a narrow scope, limiting the blast radius.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type SecretScope = string;

export interface SecretRequest {
  /** The connector or service name (e.g., "slack", "github", "openai"). */
  connector: string;
  /** Scopes required (e.g., ["chat:write", "repo:read"]). */
  scopes: SecretScope[];
  /** Tenant requesting the secret. */
  tenantId: string;
  /** Run that needs the secret. */
  runId: string;
  /** Step that needs the secret. */
  stepId: string;
  /** TTL in seconds. Default: 300 (5 min). Max: 3600 (1 hour). */
  ttlSeconds?: number;
}

export interface SecretHandle {
  /** Opaque handle ID — NOT the secret material. */
  handleId: string;
  /** HMAC signature proving the handle was issued by this broker. */
  signature: string;
  /** Connector this handle is valid for. */
  connector: string;
  /** Scopes granted. */
  scopes: SecretScope[];
  /** Tenant that owns this handle. */
  tenantId: string;
  /** Run that requested this handle. */
  runId: string;
  /** Step that requested this handle. */
  stepId: string;
  /** ISO timestamp when the handle expires. */
  expiresAt: string;
  /** ISO timestamp when the handle was issued. */
  issuedAt: string;
}

export interface SecretMaterial {
  /** The actual credential value (API key, OAuth token, etc.). */
  credential: string;
  /** Optional additional metadata from the KMS. */
  metadata?: Record<string, string>;
  /** The handle that authorized this access. */
  handleId: string;
}

export interface KmsAdapter {
  readonly name: string;
  /**
   * Retrieve the raw secret material for a connector + scopes.
   * The adapter is responsible for any KMS-specific logic (Decrypt, AssumeRole, etc.).
   */
  retrieve(input: {
    connector: string;
    scopes: SecretScope[];
    tenantId: string;
  }): Promise<{ credential: string; metadata?: Record<string, string> }>;
}

export interface SecretAuditEntry {
  type: 'issued' | 'accessed' | 'revoked' | 'expired' | 'denied';
  handleId: string;
  connector: string;
  tenantId: string;
  runId: string;
  stepId: string;
  at: string;
  reason?: string;
}

export interface SecretBrokerConfig {
  /** HMAC signing key for handles. Must be >= 32 chars. */
  signingKey: string;
  /** Default TTL in seconds. */
  defaultTtlSeconds: number;
  /** Maximum TTL allowed. */
  maxTtlSeconds: number;
  /** Whether to audit all operations. */
  auditEnabled: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Environment-variable fallback KMS adapter
// ──────────────────────────────────────────────────────────────────────────

/**
 * A simple KMS adapter that reads credentials from environment variables.
 * This is the default fallback for local/dev deployments. In production,
 * a real KMS adapter (AWS KMS, Vault, etc.) should be used.
 *
 * Env var convention: COMMANDER_SECRET_{CONNECTOR_UPPER}
 * e.g., COMMANDER_SECRET_SLACK → slack API token
 */
export class EnvVarKmsAdapter implements KmsAdapter {
  readonly name = 'env-var';

  async retrieve(input: {
    connector: string;
    scopes: SecretScope[];
    tenantId: string;
  }): Promise<{ credential: string; metadata?: Record<string, string> }> {
    const envKey = `COMMANDER_SECRET_${input.connector.toUpperCase().replace(/-/g, '_')}`;
    const credential = process.env[envKey];
    if (!credential) {
      throw new SecretBrokerError(
        `SECRET_NOT_FOUND`,
        `No secret found for connector '${input.connector}'. Set ${envKey} or configure a KMS adapter.`,
      );
    }
    return { credential };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────

export class SecretBrokerError extends Error {
  constructor(
    readonly code:
      | 'SECRET_NOT_FOUND'
      | 'HANDLE_EXPIRED'
      | 'HANDLE_REVOKED'
      | 'HANDLE_INVALID'
      | 'SCOPE_DENIED'
      | 'TENANT_MISMATCH'
      | 'CONFIG_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'SecretBrokerError';
  }
}

// ──────────────────────────────────────────────────────────────────────────
// SecretBroker
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<SecretBrokerConfig> = {
  defaultTtlSeconds: 300,
  maxTtlSeconds: 3600,
  auditEnabled: true,
};

export class SecretBroker {
  private readonly config: SecretBrokerConfig;
  private readonly kms: KmsAdapter;
  private readonly activeHandles = new Map<string, { handle: SecretHandle; revoked: boolean }>();
  private readonly auditLog: SecretAuditEntry[] = [];
  private static readonly MAX_AUDIT_LOGS = 10_000;

  constructor(kms: KmsAdapter = new EnvVarKmsAdapter(), config: Partial<SecretBrokerConfig> = {}) {
    if (!config.signingKey || config.signingKey.length < 32) {
      // Auto-generate a random key if not provided (dev only)
      config.signingKey = config.signingKey ?? randomBytes(32).toString('hex');
      if (config.signingKey.length < 32) {
        throw new SecretBrokerError('CONFIG_ERROR', 'Signing key must be at least 32 characters');
      }
    }
    this.config = { ...DEFAULT_CONFIG, ...config } as SecretBrokerConfig;
    this.kms = kms;
  }

  /**
   * Issue a short-lived SecretHandle for a connector.
   * The handle does NOT contain the secret material — only a reference.
   */
  async issue(request: SecretRequest): Promise<SecretHandle> {
    const ttl = Math.min(
      request.ttlSeconds ?? this.config.defaultTtlSeconds,
      this.config.maxTtlSeconds,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    const handleId = `sh_${now.getTime().toString(36)}_${randomBytes(4).toString('hex')}`;
    const handle: SecretHandle = {
      handleId,
      signature: this.signHandle(
        handleId,
        request.connector,
        request.tenantId,
        expiresAt.toISOString(),
      ),
      connector: request.connector,
      scopes: [...request.scopes],
      tenantId: request.tenantId,
      runId: request.runId,
      stepId: request.stepId,
      expiresAt: expiresAt.toISOString(),
      issuedAt: now.toISOString(),
    };

    this.activeHandles.set(handleId, { handle, revoked: false });
    this.audit({
      type: 'issued',
      handleId,
      connector: request.connector,
      tenantId: request.tenantId,
      runId: request.runId,
      stepId: request.stepId,
      at: now.toISOString(),
    });

    return handle;
  }

  /**
   * Access the secret material using a previously issued handle.
   * The handle must be valid (not expired, not revoked, tenant must match).
   */
  async access(handle: SecretHandle, tenantId: string): Promise<SecretMaterial> {
    // Verify handle integrity
    const expectedSig = this.signHandle(
      handle.handleId,
      handle.connector,
      handle.tenantId,
      handle.expiresAt,
    );
    if (
      handle.signature.length !== expectedSig.length ||
      !timingSafeEqual(Buffer.from(handle.signature), Buffer.from(expectedSig))
    ) {
      this.audit({
        type: 'denied',
        handleId: handle.handleId,
        connector: handle.connector,
        tenantId,
        runId: handle.runId,
        stepId: handle.stepId,
        at: new Date().toISOString(),
        reason: 'invalid_signature',
      });
      throw new SecretBrokerError('HANDLE_INVALID', 'Handle signature verification failed');
    }

    // Check tenant match
    if (handle.tenantId !== tenantId) {
      this.audit({
        type: 'denied',
        handleId: handle.handleId,
        connector: handle.connector,
        tenantId,
        runId: handle.runId,
        stepId: handle.stepId,
        at: new Date().toISOString(),
        reason: 'tenant_mismatch',
      });
      throw new SecretBrokerError(
        'TENANT_MISMATCH',
        'Handle tenant does not match requesting tenant',
      );
    }

    // Check expiry
    if (Date.parse(handle.expiresAt) <= Date.now()) {
      this.audit({
        type: 'expired',
        handleId: handle.handleId,
        connector: handle.connector,
        tenantId,
        runId: handle.runId,
        stepId: handle.stepId,
        at: new Date().toISOString(),
      });
      throw new SecretBrokerError('HANDLE_EXPIRED', 'Handle has expired');
    }

    // Check revocation
    const entry = this.activeHandles.get(handle.handleId);
    if (entry?.revoked) {
      this.audit({
        type: 'denied',
        handleId: handle.handleId,
        connector: handle.connector,
        tenantId,
        runId: handle.runId,
        stepId: handle.stepId,
        at: new Date().toISOString(),
        reason: 'revoked',
      });
      throw new SecretBrokerError('HANDLE_REVOKED', 'Handle has been revoked');
    }

    // Retrieve secret material from KMS
    const material = await this.kms.retrieve({
      connector: handle.connector,
      scopes: handle.scopes,
      tenantId: handle.tenantId,
    });

    this.audit({
      type: 'accessed',
      handleId: handle.handleId,
      connector: handle.connector,
      tenantId,
      runId: handle.runId,
      stepId: handle.stepId,
      at: new Date().toISOString(),
    });

    return {
      credential: material.credential,
      metadata: material.metadata,
      handleId: handle.handleId,
    };
  }

  /**
   * Revoke a handle before its natural expiry.
   */
  revoke(handleId: string, tenantId: string): void {
    const entry = this.activeHandles.get(handleId);
    if (!entry) return;
    if (entry.handle.tenantId !== tenantId) {
      throw new SecretBrokerError('TENANT_MISMATCH', 'Cannot revoke handle from different tenant');
    }
    entry.revoked = true;
    this.audit({
      type: 'revoked',
      handleId,
      connector: entry.handle.connector,
      tenantId,
      runId: entry.handle.runId,
      stepId: entry.handle.stepId,
      at: new Date().toISOString(),
    });
  }

  /**
   * Revoke all handles for a given run (e.g., when a run completes or fails).
   */
  revokeRun(runId: string, tenantId: string): number {
    let count = 0;
    for (const [handleId, entry] of this.activeHandles) {
      if (entry.handle.runId === runId && entry.handle.tenantId === tenantId) {
        entry.revoked = true;
        count++;
        this.audit({
          type: 'revoked',
          handleId,
          connector: entry.handle.connector,
          tenantId,
          runId,
          stepId: entry.handle.stepId,
          at: new Date().toISOString(),
          reason: 'run_revocation',
        });
      }
    }
    return count;
  }

  /**
   * Sweep expired handles from the active set.
   * Returns the number of handles removed.
   */
  sweep(): number {
    let removed = 0;
    const now = Date.now();
    for (const [handleId, entry] of this.activeHandles) {
      if (Date.parse(entry.handle.expiresAt) <= now) {
        this.activeHandles.delete(handleId);
        removed++;
        this.audit({
          type: 'expired',
          handleId,
          connector: entry.handle.connector,
          tenantId: entry.handle.tenantId,
          runId: entry.handle.runId,
          stepId: entry.handle.stepId,
          at: new Date().toISOString(),
        });
      }
    }
    return removed;
  }

  /**
   * Get the audit log for inspection.
   */
  getAuditLog(limit = 100): SecretAuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  /**
   * Get the number of active (non-expired, non-revoked) handles.
   */
  getActiveHandleCount(): number {
    let count = 0;
    const now = Date.now();
    for (const entry of this.activeHandles.values()) {
      if (!entry.revoked && Date.parse(entry.handle.expiresAt) > now) {
        count++;
      }
    }
    return count;
  }

  // ── Internal ──

  private signHandle(
    handleId: string,
    connector: string,
    tenantId: string,
    expiresAt: string,
  ): string {
    const payload = `${handleId}:${connector}:${tenantId}:${expiresAt}`;
    return createHmac('sha256', this.config.signingKey).update(payload).digest('hex');
  }

  private audit(entry: SecretAuditEntry): void {
    if (!this.config.auditEnabled) return;
    this.auditLog.push(entry);
    if (this.auditLog.length > SecretBroker.MAX_AUDIT_LOGS) {
      this.auditLog.shift();
    }
    try {
      const logger = getGlobalLogger();
      if (entry.type === 'denied' || entry.type === 'expired') {
        logger.warn('SecretBroker', `Secret ${entry.type}`, { ...entry });
      } else {
        logger.info('SecretBroker', `Secret ${entry.type}`, { ...entry });
      }
    } catch (err) {
      reportSilentFailure(err, 'secretBroker:audit');
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton
// ──────────────────────────────────────────────────────────────────────────

let brokerInstance: SecretBroker | null = null;

export function getSecretBroker(
  config?: Partial<SecretBrokerConfig>,
  kms?: KmsAdapter,
): SecretBroker {
  if (!brokerInstance || config) {
    brokerInstance = new SecretBroker(kms, config);
  }
  return brokerInstance;
}

export function resetSecretBroker(): void {
  brokerInstance = null;
}
