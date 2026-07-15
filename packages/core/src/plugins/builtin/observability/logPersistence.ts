/**
 * Re-export of canonical `observability/logPersistence.ts` (was a verbatim duplicate).
 * Collapsed 2026-07-15 for PRINCIPLES §3 / DRY.
 */
export {
  LogPersistence,
  getGlobalLogPersistence,
  type PersistedLogLevel,
  type PersistedLogEntry,
  type LogQueryOptions,
  type LogQueryResult,
} from '../../../observability/logPersistence';
