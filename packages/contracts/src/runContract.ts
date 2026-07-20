import type { RunState } from './states.js';
import { RUN_CONTRACT_VERSION, type VersionedContract } from './versioned.js';

export { RUN_CONTRACT_VERSION };

export interface RunPayloadV2 {
  id: string;
  tenantId: string;
  state: RunState;
  version: number;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  policySnapshotId: string;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  terminalAt?: string;
  metadata: Record<string, unknown>;
}

export type RunContractV2 = VersionedContract<'run', typeof RUN_CONTRACT_VERSION, RunPayloadV2>;

export function wrapRunV2(payload: RunPayloadV2): RunContractV2 {
  return { kind: 'run', schemaVersion: RUN_CONTRACT_VERSION, payload };
}
