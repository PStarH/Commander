import type { ArtifactV2 } from './resources.js';
import { ARTIFACT_CONTRACT_VERSION, type VersionedContract } from './versioned.js';

export { ARTIFACT_CONTRACT_VERSION };

export interface ArtifactDigestV1 {
  algorithm: 'sha-256' | 'sha-512' | 'blake3';
  value: string;
}

export interface ArtifactPayloadV1 {
  id: string;
  contentType: string;
  sizeBytes: number;
  digest: ArtifactDigestV1;
  uri: string;
  tenantId: string;
  runId: string;
  createdAt: string;
  schemaVersion: typeof ARTIFACT_CONTRACT_VERSION;
}

export type ArtifactContractV1 = VersionedContract<'artifact', typeof ARTIFACT_CONTRACT_VERSION, ArtifactPayloadV1>;

export function wrapArtifactV1(payload: ArtifactPayloadV1): ArtifactContractV1 {
  return { kind: 'artifact', schemaVersion: ARTIFACT_CONTRACT_VERSION, payload };
}

/** 无 digest 的 ArtifactV2 仅作 legacy view，不得进入 verifiedArtifacts。 */
export function toArtifactContractV1(legacy: ArtifactV2): ArtifactContractV1 | null {
  if (!legacy.digest || !legacy.uri) return null;
  return wrapArtifactV1({
    id: legacy.id,
    contentType: legacy.contentType,
    sizeBytes: 0,
    digest: { algorithm: 'sha-256', value: legacy.digest },
    uri: legacy.uri,
    tenantId: legacy.tenantId,
    runId: legacy.runId,
    createdAt: legacy.createdAt,
    schemaVersion: ARTIFACT_CONTRACT_VERSION,
  });
}
