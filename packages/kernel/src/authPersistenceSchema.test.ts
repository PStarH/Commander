import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { KERNEL_AUTH_PERSISTENCE_SQL } from './authPersistenceSchema.js';
import {
  KERNEL_AUTH_PERSISTENCE_CHECKSUM,
  KERNEL_AUTH_PERSISTENCE_MIGRATIONS,
  KERNEL_MIGRATIONS,
} from './migrations.js';

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

test('auth persistence migration checksum is pinned (source changes need a new descriptor)', () => {
  // This pins the shipped SQL to the registered descriptor. Any edit to
  // KERNEL_AUTH_PERSISTENCE_SQL without bumping the descriptor fails here.
  assert.equal(checksum(KERNEL_AUTH_PERSISTENCE_SQL), KERNEL_AUTH_PERSISTENCE_CHECKSUM);
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
