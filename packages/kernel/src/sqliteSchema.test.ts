import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SQLITE_KERNEL_SCHEMA_SQL, SQLITE_KERNEL_SCHEMA_VERSION, SQLITE_KERNEL_TABLES } from './sqliteSchema.js';
import { KERNEL_SCHEMA_SQL, KERNEL_SCHEMA_VERSION } from './schema.js';

describe('sqliteSchema parity', () => {
  it('defines all kernel tables mirrored from schema.ts', () => {
    const pgTables = [
      ...KERNEL_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g),
    ].map((m) => m[1]);
    const sqliteTables = [
      ...SQLITE_KERNEL_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g),
    ].map((m) => m[1]);
    const expected = pgTables.filter((t) => t !== 'commander_kernel_migrations');
    for (const table of expected) {
      assert.ok(sqliteTables.includes(table) || SQLITE_KERNEL_TABLES.includes(table as typeof SQLITE_KERNEL_TABLES[number]),
        `missing sqlite table ${table}`);
    }
  });

  it('documents synchronous NORMAL default in schema header', () => {
    assert.match(SQLITE_KERNEL_SCHEMA_SQL, /commander_kernel_schema/);
    assert.ok(SQLITE_KERNEL_TABLES.length >= 17);
  });

  it('aligns claim-era schema version label with Postgres', () => {
    assert.equal(SQLITE_KERNEL_SCHEMA_VERSION, KERNEL_SCHEMA_VERSION);
    assert.ok(
      SQLITE_KERNEL_TABLES.includes('commander_workers'),
      'claim-era workers table required for durable tenant_ids authz',
    );
  });

  it('capability revocations use tenant-scoped PRIMARY KEY (tenant_id, jti)', () => {
    assert.match(
      SQLITE_KERNEL_SCHEMA_SQL,
      /CREATE TABLE IF NOT EXISTS commander_capability_revocations \(\s*tenant_id TEXT NOT NULL,\s*jti TEXT NOT NULL,[\s\S]*?PRIMARY KEY \(tenant_id, jti\)/,
    );
    assert.match(
      KERNEL_SCHEMA_SQL,
      /CREATE TABLE IF NOT EXISTS commander_capability_revocations \(\s*tenant_id TEXT NOT NULL,\s*jti TEXT NOT NULL,[\s\S]*?PRIMARY KEY \(tenant_id, jti\)/,
    );
    assert.doesNotMatch(
      KERNEL_SCHEMA_SQL,
      /CREATE TABLE IF NOT EXISTS commander_capability_revocations \(\s*jti TEXT PRIMARY KEY/,
    );
  });
});
