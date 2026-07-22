/**
 * ApiKeyWorkerAuthenticator — production-grade worker authentication.
 *
 * Validates worker identity using a pre-shared API key. This is the simplest
 * production-grade authenticator suitable for single-cluster deployments.
 * For multi-cluster or zero-trust environments, replace with a JWT/OIDC
 * or SPIFFE-based authenticator.
 *
 * The authenticator enforces:
 * 1. Token validity — rejected keys are denied
 * 2. Tenant scope — workers can only claim steps for authorized tenants
 * 3. Capability scope — workers can only execute steps matching their capabilities
 * 4. Token expiry — expired identities are rejected
 */

import { timingSafeEqual } from 'node:crypto';
import type { WorkerAuthenticator, WorkerAuthorization, WorkerDefinition, WorkerIdentity } from './types.js';

export interface ApiKeyAuthenticatorConfig {
  /** Set of valid API keys. */
  validTokens: Set<string>;
  /** Default tenant IDs if not encoded in the token. */
  defaultTenantIds: string[];
  /** Default capabilities if not encoded in the token. */
  defaultCapabilities: string[];
  /** Optional: map from token → specific tenant IDs (overrides default). */
  tokenTenants?: Map<string, string[]>;
  /** Optional: map from token → specific capabilities (overrides default). */
  tokenCapabilities?: Map<string, string[]>;
}

export class ApiKeyWorkerAuthenticator implements WorkerAuthenticator {
  private readonly config: ApiKeyAuthenticatorConfig;

  constructor(config: ApiKeyAuthenticatorConfig) {
    this.config = config;
  }

  async authenticate(
    identity: WorkerIdentity,
    definition: WorkerDefinition,
  ): Promise<WorkerAuthorization> {
    // 1. Check token expiry
    if (Date.parse(identity.expiresAt) <= Date.now()) {
      throw new WorkerAuthError('TOKEN_EXPIRED', 'Worker identity token has expired');
    }

    // 2. Validate token using timing-safe comparison
    const token = identity.token;
    let tokenValid = false;
    for (const validToken of this.config.validTokens) {
      if (token.length === validToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(validToken))) {
        tokenValid = true;
        break;
      }
    }
    if (!tokenValid) {
      throw new WorkerAuthError('TOKEN_INVALID', 'Worker API key is not recognized');
    }

    // 3. Resolve tenant scope — tokenTenants may only narrow defaultTenantIds, never widen.
    const ceiling = this.config.defaultTenantIds;
    const requested = this.config.tokenTenants?.get(token) ?? ceiling;
    const ceilingSet = new Set(ceiling);
    const tenantIds = requested.filter((t) => ceilingSet.has(t));
    if (tenantIds.length === 0) {
      throw new WorkerAuthError(
        'TENANT_SCOPE_DENIED',
        'Worker token tenants are empty after intersecting with defaultTenantIds ceiling',
      );
    }
    if (requested.some((t) => !ceilingSet.has(t))) {
      throw new WorkerAuthError(
        'TENANT_SCOPE_DENIED',
        `Worker token tenants exceed defaultTenantIds ceiling [${ceiling.join(', ')}]`,
      );
    }

    // 4. Resolve capability scope
    const allowedCapabilities = this.config.tokenCapabilities?.get(token) ?? this.config.defaultCapabilities;

    // 5. Verify that the worker's declared capabilities are all authorized
    if (!allowedCapabilities.includes('*')) {
      for (const cap of definition.capabilities) {
        if (!allowedCapabilities.includes(cap)) {
          throw new WorkerAuthError(
            'CAPABILITY_DENIED',
            `Worker declares capability '${cap}' but token only authorizes [${allowedCapabilities.join(', ')}]`,
          );
        }
      }
    }

    return {
      tenantIds,
      capabilities: allowedCapabilities,
    };
  }
}

export class WorkerAuthError extends Error {
  constructor(
    readonly code: 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'CAPABILITY_DENIED' | 'TENANT_SCOPE_DENIED',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerAuthError';
  }
}
