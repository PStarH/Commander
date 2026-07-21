import { GRANT_CONTRACT_VERSION, type VersionedContract } from './versioned.js';

export { GRANT_CONTRACT_VERSION };

export interface GrantV1 {
  schemaVersion: typeof GRANT_CONTRACT_VERSION;
  jti: string;
  tenantId: string;
  runId: string;
  stepId: string;
  effectTypes: string[];
  expiresAt: string;
  issuer: string;
  audience: string;
  issuedAt: string;
  notBefore: string;
  keyId: string;
  requestHash: string;
  workloadId: string;
  policySnapshotId: string;
  nonce: string;
}

export type GrantContractV1 = VersionedContract<'grant', typeof GRANT_CONTRACT_VERSION, GrantV1>;

export function wrapGrantV1(payload: GrantV1): GrantContractV1 {
  return { kind: 'grant', schemaVersion: GRANT_CONTRACT_VERSION, payload };
}
