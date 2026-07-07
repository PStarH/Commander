/**
 * Storage module (Phase 1 of iss-001).
 *
 * Public surface:
 *   - PersistentDriver / PersistentTable / TableSchema / ColumnSpec types
 *   - createDriver / createDriverSoft factory functions
 *   - SqliteDriver, JsonDriver, InMemoryDriver implementations
 *   - applyMigrations runner
 *   - probeSqlite / isSqliteUsable (for soft-fallback gating)
 *
 * Plus the legacy DataRetentionJanitor (kept for SOC2 closure).
 */

export {
  ColumnSpec,
  ColumnType,
  DriverBackend,
  DriverConfig,
  DriverDescription,
  PersistentDriver,
  PersistentTable,
  QueryOptions,
  TableSchema,
} from './types';

export type { ApplyMigrationsResult, MigrationStep, FallbackInfo } from './types';

export {
  matchesFilter,
  isCompatibleWithSpec,
  shortHash,
  canonicalJson,
  nextId,
  coerceColumn,
} from './utils';
export type { DriverBackend as DriverBackendType } from './types';

export { InMemoryDriver } from './inMemoryDriver';
export { JsonDriver } from './jsonDriver';
export {
  SqliteDriver,
  SqliteOpenError,
  probeSqlite,
  _resetSqliteProbeForTesting,
} from './sqliteDriver';
export { PostgresDriver, probePostgres } from './postgresDriver';
export type { SqliteAvailability, SqliteAvailable, SqliteUnavailable } from './sqliteDriver';

export { createDriver, createDriverSoft, isSqliteUsable, listAvailableBackends } from './factory';
export type { CreateDriverResult } from './factory';

export { applyMigrations } from './migration';

// Legacy — backward compatibility for SOC2/GDPR retention flows.
export {
  DataRetentionJanitor,
  DEFAULT_RETENTION_TABLE,
  getDataRetentionJanitor,
  resetDataRetentionJanitor,
} from './dataRetention';

export type {
  DataRetentionConfig,
  RetentionRule,
  RetentionPolicy,
  RetentionRunResult,
} from './dataRetention';
