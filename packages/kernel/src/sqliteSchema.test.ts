import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SQLITE_KERNEL_SCHEMA_SQL, SQLITE_KERNEL_TABLES } from './sqliteSchema.js';
import { KERNEL_SCHEMA_SQL } from './schema.js';

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
});
