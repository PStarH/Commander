import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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
      roles.map((role) => [`COMMANDER_PREFLIGHT_${role}_DATABASE_URL`, `postgres://${role}`]),
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
      [{ name: 'RUNTIME', connectionString: 'postgres://runtime' }],
    );
  });

  it('parses only an exact descriptor-to-checksum object', () => {
    const checksum = 'a'.repeat(64);
    assert.deepEqual(parseExpectedMigrationDescriptors('{}'), {});
    assert.deepEqual(parseExpectedMigrationDescriptors(`{"migration.1":"${checksum}"}`), {
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
      roles.map((role) => [`COMMANDER_PREFLIGHT_${role}_DATABASE_URL`, `postgres://${role}`]),
    );
    await runMigrationGateAttempt('preflight', env, async (target, descriptors) => {
      calls.push(target.name);
      assert.deepEqual(descriptors, {});
    });
    assert.deepEqual(calls.sort(), [...roles].sort());
  });
});
