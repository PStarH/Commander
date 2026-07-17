/** Shared identity, policy, audit, and plugin-sandbox contracts. */

export interface WorkloadIdentity {
  workloadId: string;
  tenantId: string;
  /** Present for step-scoped identities issued at kernel claim time. */
  runId?: string;
  stepId?: string;
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

/** Versioned resource names used by Gateway routing. */
export const CONTROL_PLANE_RESOURCES = [
  'identity',
  'tenant',
  'policy',
  'audit',
  'registry',
] as const;

export type ControlPlaneResource = (typeof CONTROL_PLANE_RESOURCES)[number];

export const CONTROL_PLANE_API_VERSION = 'v2' as const;

/** Plugin sandbox modes enforced at the package boundary. */
export type PluginSandboxMode = 'in_process' | 'subprocess' | 'required';
