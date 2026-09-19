import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  probeMigrationGateTarget,
  migrationGatePoolConfig,
  migrationGateTargets,
  parseExpectedMigrationDescriptors,
  parseMigrationGateMode,
  runMigrationGateAttempt,
} from './migrationGate.js';

const roles = ['OWNER', 'APP', 'TENANT_AUTHORITY', 'SCHEDULER', 'WORKER', 'ADAPTER_OPS'];

describe('migration gate', () => {
  it('accepts only the preflight and await entrypoint modes', () => {
    assert.equal(parseMigrationGateMode(['preflight']), 'preflight');
    assert.equal(parseMigrationGateMode(['await']), 'await');
    assert.throws(() => parseMigrationGateMode([]), /MIGRATION_GATE_MODE_INVALID/);
    assert.throws(
      () => parseMigrationGateMode(['preflight', 'extra']),
      /MIGRATION_GATE_MODE_INVALID/,
    );
  });

  it('requires all six sealed database roles during migration preflight', () => {
    const env = Object.fromEntries(
      roles.map((role) => ['COMMANDER_PREFLIGHT_' + role + '_DATABASE_URL', 'postgres://' + role]),
    );
    assert.deepEqual(
      migrationGateTargets('preflight', env).map(({ name }) => name),
      roles,
    );
    delete env.COMMANDER_PREFLIGHT_WORKER_DATABASE_URL;
    assert.throws(
      () => migrationGateTargets('preflight', env),
      /MIGRATION_GATE_DATABASE_URL_MISSING/,
    );
  });

  it('uses only the runtime role connection while awaiting migrations', () => {
    assert.deepEqual(
      migrationGateTargets('await', {
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://runtime',
        COMMANDER_PREFLIGHT_OWNER_DATABASE_URL: 'postgres://owner',
      }),
      [{ name: 'RUNTIME', connectionString: 'postgres://runtime', verifyDescriptors: true }],
    );
  });

  it('bounds every database probe within the migration wait budget', () => {
    assert.deepEqual(
      migrationGatePoolConfig('postgres://owner:secret@db.internal/commander?sslmode=verify-full'),
      {
        connectionString: 'postgres://owner:secret@db.internal/commander?sslmode=verify-full',
        max: 1,
        connectionTimeoutMillis: 5_000,
        query_timeout: 5_000,
        statement_timeout: 4_500,
      },
    );
  });

  it('parses only an exact descriptor-to-checksum object', () => {
    const checksum = 'a'.repeat(64);
    assert.deepEqual(parseExpectedMigrationDescriptors('{}'), {});
    assert.deepEqual(parseExpectedMigrationDescriptors('{"migration.1":"' + checksum + '"}'), {
      'migration.1': checksum,
    });
    assert.throws(
      () => parseExpectedMigrationDescriptors('{"migration.1":"secret"}'),
      /MIGRATION_GATE_DESCRIPTORS_INVALID/,
    );
  });

  it('probes every selected database without exposing connection strings', async () => {
    const calls: string[] = [];
    const env = Object.fromEntries(
      roles.map((role) => ['COMMANDER_PREFLIGHT_' + role + '_DATABASE_URL', 'postgres://' + role]),
    );
    await runMigrationGateAttempt('preflight', env, async (target, descriptors) => {
      calls.push(target.name);
      assert.deepEqual(descriptors, {});
    });
    assert.deepEqual(calls.sort(), [...roles].sort());
  });

  it('fails closed when the runtime role cannot read the applied descriptor state', async () => {
    const queries: string[] = [];
    await assert.rejects(
      () =>
        probeMigrationGateTarget(
          { name: 'RUNTIME', connectionString: 'postgres://runtime', verifyDescriptors: true },
          { 'migration.1': 'a'.repeat(64) },
          () => ({
            async query(sql: string) {
              queries.push(sql);
              if (/commander_applied_migration_descriptors/.test(sql)) {
                throw new Error(
                  'permission denied for function commander_applied_migration_descriptors',
                );
              }
              return { rows: [] };
            },
            async end() {},
          }),
        ),
      /MIGRATION_GATE_DESCRIPTOR_STATE_MISSING/,
    );
    assert.equal(queries[0], 'SELECT 1');
    assert.match(queries[1]!, /^SELECT id::text AS id, checksum::text AS checksum FROM /);
  });

  it('accepts an applied descriptor set that matches the release descriptors', async () => {
    const checksum = 'a'.repeat(64);
    const queries: string[] = [];
    await probeMigrationGateTarget(
      { name: 'RUNTIME', connectionString: 'postgres://runtime', verifyDescriptors: true },
      { 'migration.1': checksum },
      () => ({
        async query<T>(sql: string) {
          queries.push(sql);
          if (/commander_applied_migration_descriptors/.test(sql)) {
            return { rows: [{ id: 'migration.1', checksum }] as T[] };
          }
          return { rows: [] as T[] };
        },
        async end() {},
      }),
    );
    assert.equal(queries.length, 2);
    assert.equal(queries[0], 'SELECT 1');
    assert.match(queries[1]!, /commander_applied_migration_descriptors\(\)/);
  });

  it('rejects an expected descriptor that is missing from the applied ledger', async () => {
    await assert.rejects(
      () =>
        probeMigrationGateTarget(
          { name: 'RUNTIME', connectionString: 'postgres://runtime', verifyDescriptors: true },
          { 'migration.1': 'a'.repeat(64), 'migration.2': 'b'.repeat(64) },
          () => ({
            async query<T>(sql: string) {
              if (/commander_applied_migration_descriptors/.test(sql)) {
                return { rows: [{ id: 'migration.1', checksum: 'a'.repeat(64) }] as T[] };
              }
              return { rows: [] as T[] };
            },
            async end() {},
          }),
        ),
      /MIGRATION_GATE_DESCRIPTORS_MISMATCH/,
    );
  });

  it('rejects an applied descriptor whose checksum is not the published checksum', async () => {
    await assert.rejects(
      () =>
        probeMigrationGateTarget(
          { name: 'RUNTIME', connectionString: 'postgres://runtime', verifyDescriptors: true },
          { 'migration.1': 'a'.repeat(64) },
          () => ({
            async query<T>(sql: string) {
              if (/commander_applied_migration_descriptors/.test(sql)) {
                return { rows: [{ id: 'migration.1', checksum: 'c'.repeat(64) }] as T[] };
              }
              return { rows: [] as T[] };
            },
            async end() {},
          }),
        ),
      /MIGRATION_GATE_DESCRIPTORS_MISMATCH/,
    );
  });

  it('keeps the pre-migration preflight to connectivity only', async () => {
    const queries: string[] = [];
    await probeMigrationGateTarget(
      { name: 'APP', connectionString: 'postgres://app', verifyDescriptors: false },
      { 'migration.1': 'a'.repeat(64) },
      () => ({
        async query(sql: string) {
          queries.push(sql);
          return { rows: [] };
        },
        async end() {},
      }),
    );
    assert.deepEqual(queries, ['SELECT 1']);
  });
});
