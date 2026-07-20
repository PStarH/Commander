/**
 * @deprecated Compatibility shim — TTL curator merged into memory/curator.ts
 * MemoryCurator. Prefer importing from ./curator or the memory barrel.
 *
 * This file re-exports only; it must NOT declare a second product class
 * (PRINCIPLES section 3 memory allowlist).
 */

export {
  MemoryCurator,
  DEFAULT_CURATOR_CONFIG,
  DEFAULT_TTL_CURATOR_CONFIG,
  TtlMemoryCurator,
  getMemoryCurator,
  resetMemoryCurator,
} from './curator';
export type {
  CuratorConfig,
  CurationResult,
  CuratorMemoryItem,
  TtlMemoryCuratorConfig,
} from './curator';

/** @deprecated Use CuratorConfig */
export type MemoryCuratorConfig = import('./curator').CuratorConfig;
