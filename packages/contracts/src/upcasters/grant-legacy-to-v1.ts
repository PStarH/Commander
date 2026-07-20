import { GRANT_CONTRACT_VERSION, type GrantV1 } from '../grant.js';

/** Legacy token payload without schemaVersion — upcast once with audit counter. */
export interface LegacyGrantPayload {
  jti: string;
  tenantId: string;
  runId: string;
  stepId: string;
  effectTypes: string[];
  expiresAt: string;
  issuer?: string;
  audience?: string;
  issuedAt?: string;
  notBefore?: string;
  keyId?: string;
  policySnapshotId?: string;
  requestHash?: string;
  workloadId?: string;
  nonce?: string;
}

let legacyUpcastCount = 0;

export function getLegacyGrantUpcastCount(): number {
  return legacyUpcastCount;
}

export function upcastLegacyGrantToV1(
  legacy: LegacyGrantPayload,
  defaults: {
    issuer: string;
    audience: string;
    keyId: string;
    requestHash?: string;
    workloadId?: string;
    policySnapshotId?: string;
    issuedAt?: string;
    notBefore?: string;
    nonce?: string;
  },
): GrantV1 {
  legacyUpcastCount += 1;
  const issuedAt = legacy.issuedAt ?? defaults.issuedAt ?? legacy.expiresAt;
  return {
    schemaVersion: GRANT_CONTRACT_VERSION,
    jti: legacy.jti,
    tenantId: legacy.tenantId,
    runId: legacy.runId,
    stepId: legacy.stepId,
    effectTypes: legacy.effectTypes,
    expiresAt: legacy.expiresAt,
    issuer: legacy.issuer ?? defaults.issuer,
    audience: legacy.audience ?? defaults.audience,
    issuedAt,
    notBefore: legacy.notBefore ?? defaults.notBefore ?? issuedAt,
    keyId: legacy.keyId ?? defaults.keyId,
    requestHash: legacy.requestHash ?? defaults.requestHash ?? '',
    workloadId: legacy.workloadId ?? defaults.workloadId ?? '',
    policySnapshotId: legacy.policySnapshotId ?? defaults.policySnapshotId ?? '',
    nonce: legacy.nonce ?? defaults.nonce ?? legacy.jti,
  };
}

export { upcastLegacyGrantToV1 as grantLegacyToV1 };
