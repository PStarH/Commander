/**
 * @commander/control-plane — Architecture V2 control-plane contracts.
 *
 * Stable types for identity / policy / audit. Runtime wiring remains in
 * @commander/core during strangler migration; this package is the public
 * contract surface for Gateway and SDK consumers.
 */

export interface WorkloadIdentity {
  workloadId: string;
  tenantId: string;
  userId?: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  token: string;
}

export type PolicyEffect = 'allow' | 'deny' | 'require_approval' | 'deny_class';

export interface PolicyDecisionV2 {
  effect: PolicyEffect;
  decisionId: string;
  reason: string;
  matchedRule: string | null;
  runId: string;
  tenantId: string | null;
}

export interface AuditEventV2 {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  message: string;
  details?: Record<string, unknown>;
  tenantId?: string;
  runId?: string;
  at: string;
}

/** Versioned control-plane resource names for Gateway routing. */
export const CONTROL_PLANE_RESOURCES = [
  'identity',
  'tenant',
  'policy',
  'audit',
  'registry',
] as const;

export type ControlPlaneResource = (typeof CONTROL_PLANE_RESOURCES)[number];

export const CONTROL_PLANE_API_VERSION = 'v2' as const;

/** Plugin sandbox modes enforced by the control plane. */
export type PluginSandboxMode = 'in_process' | 'subprocess' | 'required';
