import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { KERNEL_MIGRATIONS } from './migrations.js';

const MIGRATION_ID = '2026-08-21.1.p0_auth_persistence';

function authMigrationSql(): string {
  const migration = KERNEL_MIGRATIONS.find((candidate) => candidate.id === MIGRATION_ID);
  assert.ok(migration, 'missing migration descriptor: ' + MIGRATION_ID);
  assert.equal(migration.checksum, createHash('sha256').update(migration.sql).digest('hex'));
  return migration.sql;
}

describe('PostgreSQL-authoritative authentication schema', () => {
  it('publishes a checksummed user-tenant membership migration', () => {
    const migration = KERNEL_MIGRATIONS.find(
      (candidate) => candidate.id === '2026-08-22.1.p0_auth_user_tenant_membership',
    );
    assert.ok(migration);
    assert.equal(migration.checksum, createHash('sha256').update(migration.sql).digest('hex'));
    assert.match(migration.sql, /CREATE TABLE commander_auth_user_tenants/i);
    assert.match(migration.sql, /PRIMARY KEY \(user_id, tenant_id\)/i);
    assert.match(migration.sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE commander_auth_user_tenants TO commander_app/i);
  });
  it('publishes one checksummed forward migration descriptor', () => {
    const matching = KERNEL_MIGRATIONS.filter((migration) => migration.id === MIGRATION_ID);
    assert.equal(matching.length, 1);
    assert.equal(
      matching[0]?.checksum,
      createHash('sha256')
        .update(matching[0]?.sql ?? '')
        .digest('hex'),
    );
  });

  it('defines durable users, API keys, refresh tokens, failures, and rate-limit buckets', () => {
    const sql = authMigrationSql();

    for (const table of [
      'commander_auth_users',
      'commander_auth_api_keys',
      'commander_auth_refresh_tokens',
      'commander_auth_failures',
      'commander_auth_rate_limits',
    ]) {
      assert.match(sql, new RegExp('CREATE TABLE ' + table + ' \\(', 'i'));
    }

    assert.match(
      sql,
      /role TEXT NOT NULL CHECK \(role IN \('super_admin','admin','developer','operator','auditor','viewer'\)\)/i,
    );
    assert.match(sql, /CHECK \(\(oidc_issuer IS NULL\) = \(oidc_subject IS NULL\)\)/i);
    assert.match(
      sql,
      /UNIQUE INDEX commander_auth_users_username_ci_uidx[\s\S]*lower\(username\)/i,
    );
    assert.match(sql, /UNIQUE INDEX commander_auth_users_email_ci_uidx[\s\S]*lower\(email\)/i);
    assert.match(
      sql,
      /UNIQUE INDEX commander_auth_users_oidc_uidx[\s\S]*oidc_issuer, oidc_subject[\s\S]*WHERE oidc_issuer IS NOT NULL/i,
    );
    assert.match(sql, /key_hash TEXT NOT NULL UNIQUE/i);
    assert.match(sql, /scopes TEXT\[\] NOT NULL/i);
    assert.match(
      sql,
      /user_id TEXT NOT NULL REFERENCES commander_auth_users\(id\) ON DELETE CASCADE/i,
    );
    assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
    assert.match(sql, /count INTEGER NOT NULL CHECK \(count (?:>|>=) 0\)/i);
  });

  it('indexes authentication lookup and expiry cleanup paths', () => {
    const sql = authMigrationSql();

    for (const index of [
      'commander_auth_refresh_tokens_user_idx',
      'commander_auth_refresh_tokens_expiry_idx',
      'commander_auth_failures_cleanup_idx',
      'commander_auth_rate_limits_expiry_idx',
    ]) {
      assert.match(sql, new RegExp('CREATE (?:UNIQUE )?INDEX ' + index, 'i'));
    }
  });

  it('assigns every authentication table to the migration owner', () => {
    const sql = authMigrationSql();

    for (const table of [
      'commander_auth_users',
      'commander_auth_api_keys',
      'commander_auth_refresh_tokens',
      'commander_auth_failures',
      'commander_auth_rate_limits',
    ]) {
      assert.match(sql, new RegExp('ALTER TABLE ' + table + ' OWNER TO commander_owner', 'i'));
    }
  });

  it('allows only the API role to access authentication rows', () => {
    const sql = authMigrationSql();
    const tables =
      'commander_auth_users,\\s*commander_auth_api_keys,\\s*commander_auth_refresh_tokens,\\s*commander_auth_failures,\\s*commander_auth_rate_limits';

    assert.match(
      sql,
      new RegExp(
        'REVOKE ALL PRIVILEGES ON TABLE\\s+' +
          tables +
          '\\s+FROM PUBLIC, commander_scheduler, commander_worker, commander_adapter_ops',
        'i',
      ),
    );
    assert.match(
      sql,
      /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'commander_tenant_authority'\)[\s\S]*REVOKE ALL PRIVILEGES ON TABLE[\s\S]*FROM commander_tenant_authority/i,
    );
    assert.match(
      sql,
      new RegExp(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\\s+' + tables + '\\s+TO commander_app',
        'i',
      ),
    );
    assert.doesNotMatch(
      sql,
      /GRANT [^;]+ ON TABLE[\s\S]*? TO commander_(?:scheduler|worker|adapter_ops|tenant_authority)/i,
    );
  });
});
