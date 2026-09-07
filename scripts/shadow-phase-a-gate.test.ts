import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SHADOW_PHASE_A_DATABASE_PREREQUISITE_CODE,
  runBoundedShadowPhaseAChild,
  runShadowPhaseAGate,
  type ShadowPhaseACommand,
} from './shadow-phase-a-gate.js';

const revision = 'cd3ea635e7971c121cdbabdf20687691e2ae83c9';

function successfulRunner(calls: ShadowPhaseACommand[]) {
  return async (command: ShadowPhaseACommand) => {
    calls.push(command);
    return {
      exitCode: 0,
      stdout:
        command.id === 'shadow-package-contents'
          ? 'package/dist/index.js\npackage/dist/cli.js\n'
          : 'x'.repeat(64),
      stderr: '',
    };
  };
}

describe('Shadow Phase A release gate', () => {
  it('drains verbose successful child output without treating truncation as a failure', async () => {
    const result = await runBoundedShadowPhaseAChild({
      id: 'contracts',
      file: process.execPath,
      args: ['--eval', "process.stdout.write('x'.repeat(32 * 1024))"],
    });

    assert.equal(result.exitCode, 0);
    assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024);
    assert.equal(result.stderr, '');
  });

  it('runs every safe suite before reporting the local PostgreSQL prerequisite', async () => {
    const calls: ShadowPhaseACommand[] = [];
    const result = await runShadowPhaseAGate({
      ci: false,
      databaseUrl: undefined,
      sourceRevision: revision,
      run: successfulRunner(calls),
    });

    assert.deepEqual(result, {
      exitCode: 1,
      code: SHADOW_PHASE_A_DATABASE_PREREQUISITE_CODE,
      sourceRevision: revision,
      passed: 10,
      total: 11,
    });
    assert.deepEqual(
      calls.map((command) => command.id),
      [
        'contracts',
        'architecture',
        'shadow-tests',
        'shadow-typecheck',
        'shadow-clean',
        'shadow-build',
        'shadow-package',
        'shadow-package-contents',
        'shadow-package-import',
        'customer-pack',
      ],
    );
    assert.equal(
      calls.some((command) => command.id === 'postgres-live'),
      false,
    );
  });

  it('imports the tarball with its declared production dependencies resolved', async () => {
    const calls: ShadowPhaseACommand[] = [];
    await runShadowPhaseAGate({
      ci: false,
      databaseUrl: undefined,
      sourceRevision: revision,
      run: successfulRunner(calls),
    });

    const importCommand = calls.find((command) => command.id === 'shadow-package-import');
    assert.ok(importCommand);
    assert.match(importCommand.args[1]!, /ln -s/);
    assert.match(importCommand.args[1]!, /json-canonicalize/);
    assert.match(importCommand.args[1]!, /@commander\/contracts/);
    assert.match(importCommand.args[1]!, /@commander\/postgres-runtime/);
    assert.match(importCommand.args[1]!, /\bpg\b/);
  });

  it('removes prior package output before producing the tarball build', async () => {
    const calls: ShadowPhaseACommand[] = [];
    await runShadowPhaseAGate({
      ci: false,
      databaseUrl: undefined,
      sourceRevision: revision,
      run: successfulRunner(calls),
    });

    const cleanIndex = calls.findIndex((command) => command.id === 'shadow-clean');
    const buildIndex = calls.findIndex((command) => command.id === 'shadow-build');
    assert.ok(cleanIndex >= 0);
    assert.ok(cleanIndex < buildIndex);
    assert.match(calls[cleanIndex]!.args.join(' '), /rm\(/);
    assert.match(calls[cleanIndex]!.cwd ?? '', /packages\/shadow-plane$/);
  });

  it('runs the PostgreSQL authority suite when the approved environment is configured', async () => {
    const calls: ShadowPhaseACommand[] = [];
    const result = await runShadowPhaseAGate({
      ci: true,
      databaseUrl: 'postgres://commander:commander@localhost:5432/commander',
      sourceRevision: revision,
      run: successfulRunner(calls),
    });

    assert.deepEqual(result, {
      exitCode: 0,
      code: 'SHADOW_PHASE_A_GATE_PASSED',
      sourceRevision: revision,
      passed: 11,
      total: 11,
    });
    assert.equal(calls[calls.length - 1]?.id, 'postgres-live');
  });

  it('hard fails in CI when PostgreSQL configuration is missing', async () => {
    const calls: ShadowPhaseACommand[] = [];
    const result = await runShadowPhaseAGate({
      ci: true,
      databaseUrl: undefined,
      sourceRevision: revision,
      run: successfulRunner(calls),
    });

    assert.deepEqual(result, {
      exitCode: 1,
      code: SHADOW_PHASE_A_DATABASE_PREREQUISITE_CODE,
      sourceRevision: revision,
      passed: 10,
      total: 11,
    });
    assert.equal(
      calls.some((command) => command.id === 'postgres-live'),
      false,
    );
  });

  it('fails closed with a stable suite code and does not expose child output', async () => {
    const calls: ShadowPhaseACommand[] = [];
    const result = await runShadowPhaseAGate({
      ci: false,
      databaseUrl: undefined,
      sourceRevision: revision,
      run: async (command) => {
        calls.push(command);
        return command.id === 'architecture'
          ? { exitCode: 1, stdout: 'password=not-for-output', stderr: 'postgres://secret@db' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    assert.deepEqual(result, {
      exitCode: 1,
      code: 'SHADOW_PHASE_A_ARCHITECTURE_FAILED',
      sourceRevision: revision,
      passed: 1,
      total: 11,
    });
    assert.equal(calls.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /password|postgres:|secret/);
  });
});
