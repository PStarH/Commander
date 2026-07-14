/**
 * Control plane facade — Architecture V2.
 *
 * Identity, tenancy, policy PDP, and audit sink entry points.
 * Implementations currently delegate to existing core modules; this
 * boundary is the future @commander/control-plane package surface.
 */

import { getSideEffectGate, type SideEffectGate } from '../runtime/sideEffectGate';
import { getExecutionScheduler } from '../atr/scheduler';
import { getGlobalTenantProvider } from '../runtime/tenantProvider';
import { getSecurityAuditLogger } from '../security/securityAuditLogger';
import { createHash, randomUUID } from 'node:crypto';

export interface WorkloadIdentity {
  /** Stable workload id (agent / service account). */
  workloadId: string;
  tenantId: string;
  /** Optional user that initiated the workload. */
  userId?: string;
  /** Capability scopes granted to this workload. */
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  /** Opaque token material (HMAC/capability). */
  token: string;
}

export interface ControlPlaneConfig {
  defaultScopes?: string[];
  tokenTtlSeconds?: number;
}

export class ControlPlane {
  private readonly defaultScopes: string[];
  private readonly tokenTtlSeconds: number;
  private readonly identities = new Map<string, WorkloadIdentity>();

  constructor(config: ControlPlaneConfig = {}) {
    this.defaultScopes = config.defaultScopes ?? ['agent.execute', 'tool.invoke'];
    this.tokenTtlSeconds = config.tokenTtlSeconds ?? 3600;
  }

  /** Issue a workload identity for an agent run. */
  issueIdentity(input: {
    tenantId: string;
    userId?: string;
    scopes?: string[];
    workloadId?: string;
  }): WorkloadIdentity {
    const now = Date.now();
    const workloadId = input.workloadId ?? `wl_${randomUUID()}`;
    const token = createHash('sha256')
      .update(`${workloadId}:${input.tenantId}:${now}:${randomUUID()}`)
      .digest('hex');
    const identity: WorkloadIdentity = {
      workloadId,
      tenantId: input.tenantId,
      userId: input.userId,
      scopes: input.scopes ?? this.defaultScopes,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.tokenTtlSeconds * 1000).toISOString(),
      token,
    };
    this.identities.set(workloadId, identity);
    this.audit('identity.issued', {
      workloadId,
      tenantId: input.tenantId,
      scopes: identity.scopes,
    });
    return identity;
  }

  getIdentity(workloadId: string): WorkloadIdentity | undefined {
    const id = this.identities.get(workloadId);
    if (!id) return undefined;
    if (Date.parse(id.expiresAt) < Date.now()) {
      this.identities.delete(workloadId);
      return undefined;
    }
    return id;
  }

  /** Resolve tenant config via existing tenant provider. */
  resolveTenant(tenantId: string) {
    return getGlobalTenantProvider().getTenantConfig(tenantId);
  }

  /** Policy enforcement point — SideEffectGate. */
  policyPep(): SideEffectGate {
    return getSideEffectGate();
  }

  /** Kernel scheduler (data-plane claim surface exposed for control ops). */
  scheduler() {
    return getExecutionScheduler();
  }

  audit(type: string, details: Record<string, unknown>): void {
    try {
      getSecurityAuditLogger().logEvent({
        type: type as never,
        severity: 'low',
        source: 'ControlPlane',
        message: type,
        details,
      });
    } catch {
      /* audit must never break control plane */
    }
  }
}

let controlPlaneSingleton: ControlPlane | null = null;

export function getControlPlane(): ControlPlane {
  if (!controlPlaneSingleton) controlPlaneSingleton = new ControlPlane();
  return controlPlaneSingleton;
}

export function resetControlPlane(): void {
  controlPlaneSingleton = null;
}
