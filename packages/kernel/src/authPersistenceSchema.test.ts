import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  KERNEL_AUTH_ACCESS_TOKEN_AUTHORITY_SQL,
  KERNEL_AUTH_PERSISTENCE_LEGACY_PREFLIGHT_SQL,
  KERNEL_AUTH_PERSISTENCE_SQL,
} from './authPersistenceSchema.js';
import {
  KERNEL_AUTH_PERSISTENCE_CHECKSUM,
  KERNEL_AUTH_PERSISTENCE_MIGRATIONS,
  KERNEL_MIGRATIONS,
} from './migrations.js';

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

test('auth persistence migration checksum is pinned (source changes need a new descriptor)', () => {
  const historicalChecksum = '50940ca741be4505f6c741b80a1aebaa04e6d1082db0bc215884f64680401abc';
  assert.equal(checksum(KERNEL_AUTH_PERSISTENCE_SQL), historicalChecksum);
  assert.equal(KERNEL_AUTH_PERSISTENCE_CHECKSUM, historicalChecksum);
});

test('auth persistence upgrade wraps the historical schema migration', () => {
  const ids = KERNEL_MIGRATIONS.map((migration) => migration.id);
  const preflight = ids.indexOf('2026-09-06.1.auth_persistence_legacy_preflight');
  const historical = ids.indexOf('2026-08-25.1.auth_persistence_schema');
  const upgrade = ids.indexOf('2026-09-06.2.auth_access_token_authority');

  assert.ok(preflight >= 0);
  assert.ok(historical > preflight);
  assert.ok(upgrade > historical);
});

test('auth persistence migration is registered exactly once in KERNEL_MIGRATIONS', () => {
  const descriptor = KERNEL_AUTH_PERSISTENCE_MIGRATIONS[0];
  assert.ok(descriptor);
  assert.equal(descriptor.id, '2026-08-25.1.auth_persistence_schema');
  assert.equal(descriptor.checksum, KERNEL_AUTH_PERSISTENCE_CHECKSUM);
  const registered = KERNEL_MIGRATIONS.filter((m) => m.id === descriptor.id);
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.checksum, descriptor.checksum);
});

test('auth persistence schema defines all five authoritative tables', () => {
  for (const table of [
    'commander_auth_users',
    'commander_auth_api_keys',
    'commander_auth_refresh_tokens',
    'commander_auth_failures',
    'commander_auth_rate_limits',
  ]) {
    assert.ok(
      KERNEL_AUTH_PERSISTENCE_SQL.includes(`CREATE TABLE ${table}`),
      `missing CREATE TABLE ${table}`,
    );
  }
});

test('auth persistence schema enforces unique constraints and FKs', () => {
  assert.ok(KERNEL_AUTH_PERSISTENCE_SQL.includes('commander_auth_users_username_ci_uidx'));
  assert.ok(KERNEL_AUTH_PERSISTENCE_SQL.includes('commander_auth_users_email_ci_uidx'));
  assert.ok(KERNEL_AUTH_PERSISTENCE_SQL.includes('commander_auth_users_oidc_uidx'));
  assert.ok(KERNEL_AUTH_PERSISTENCE_SQL.includes('key_hash TEXT NOT NULL UNIQUE'));
  assert.ok(
    KERNEL_AUTH_PERSISTENCE_SQL.includes(
      'user_id TEXT NOT NULL REFERENCES commander_auth_users(id) ON DELETE CASCADE',
    ),
  );
});

test('auth persistence schema grants DML only to commander_app', () => {
  assert.ok(
    KERNEL_AUTH_PERSISTENCE_SQL.includes(
      'FROM PUBLIC, commander_scheduler, commander_worker, commander_adapter_ops',
    ),
  );
  assert.ok(KERNEL_AUTH_PERSISTENCE_SQL.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE'));
  assert.ok(KERNEL_AUTH_PERSISTENCE_SQL.includes('TO commander_app;'));
});

test('auth persistence schema keeps the migration owner as table owner', () => {
  for (const table of [
    'commander_auth_users',
    'commander_auth_api_keys',
    'commander_auth_refresh_tokens',
    'commander_auth_failures',
    'commander_auth_rate_limits',
  ]) {
    assert.ok(
      KERNEL_AUTH_PERSISTENCE_SQL.includes(`ALTER TABLE ${table} OWNER TO commander_owner;`),
    );
  }
});

test('auth persistence schema forward-migrates active legacy lockouts', () => {
  assert.match(
    KERNEL_AUTH_PERSISTENCE_LEGACY_PREFLIGHT_SQL,
    /ALTER TABLE commander_auth_failures RENAME TO commander_auth_failures_legacy/,
  );
  assert.match(
    KERNEL_AUTH_ACCESS_TOKEN_AUTHORITY_SQL,
    /INSERT INTO commander_auth_failures \(failure_key, count, first_failure_at, last_failure_at, locked_until\)/,
  );
  for (const field of ['count', 'firstFailureAt', 'lastFailureAt', 'lockedUntil']) {
    assert.ok(
      KERNEL_AUTH_ACCESS_TOKEN_AUTHORITY_SQL.includes(`entry->>'${field}'`),
      `legacy migration must preserve ${field}`,
    );
  }
  assert.match(
    KERNEL_AUTH_ACCESS_TOKEN_AUTHORITY_SQL,
    /FROM commander_auth_failures_legacy[\s\S]*WHERE expires_at > clock_timestamp\(\)/,
  );
  assert.match(KERNEL_AUTH_ACCESS_TOKEN_AUTHORITY_SQL, /DROP TABLE commander_auth_failures_legacy/);
});

test('auth users carry a monotonic access-token authority version', () => {
  assert.match(
    KERNEL_AUTH_ACCESS_TOKEN_AUTHORITY_SQL,
    /ADD COLUMN auth_version BIGINT NOT NULL DEFAULT 1 CHECK \(auth_version > 0\)/,
  );
});
