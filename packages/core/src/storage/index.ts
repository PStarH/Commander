/**
 * Storage module — persistent state-store utilities.
 *
 * Exports:
 * - DataRetentionJanitor: bounded-memory TTL janitor + retention-policy
 *   applicator for NDJSON state stores. Closes SOC 2 C1.2 (data disposal)
 *   and GDPR Article 17 (right to erasure) gaps. Mandatory for production
 *   deployments; opt-in via schedule().
 */
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
