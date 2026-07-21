/**
 * 宪法层 VersionedContract envelope — 五项契约共享外壳。
 */

export const RUN_CONTRACT_VERSION = 'commander.run/v2' as const;
export const EVENT_CONTRACT_VERSION = 'commander.event/v2' as const;
export const EFFECT_CONTRACT_VERSION = 'commander.effect/v2' as const;
export const GRANT_CONTRACT_VERSION = 'commander.grant/v1' as const;
export const ARTIFACT_CONTRACT_VERSION = 'commander.artifact/v1' as const;

export const CONSTITUTION_CONTRACT_VERSIONS = [
  RUN_CONTRACT_VERSION,
  EVENT_CONTRACT_VERSION,
  EFFECT_CONTRACT_VERSION,
  GRANT_CONTRACT_VERSION,
  ARTIFACT_CONTRACT_VERSION,
] as const;

export type ConstitutionContractVersion = (typeof CONSTITUTION_CONTRACT_VERSIONS)[number];

export interface VersionedContract<K extends string, V extends string, P> {
  kind: K;
  schemaVersion: V;
  payload: P;
}
