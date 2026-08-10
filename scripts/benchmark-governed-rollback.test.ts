import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DESIGN_PARTNER_FAULT_POINTS,
  DESIGN_PARTNER_SCENARIOS,
  type DesignPartnerCampaignObservation,
} from './design-partner-faults.js';
import {
  aggregateGovernedRollbackObservations,
  buildGovernedRollbackRepetitionPlan,
  parseGovernedRollbackBenchmarkArgs,
  runGovernedRollbackBenchmark,
  sanitizeGovernedRollbackArtifact,
  writeGovernedRollbackBenchmarkArtifacts,
} from './benchmark-governed-rollback.js';

const digest = (character: string): string => character.repeat(64);

function observation(overrides: Partial<DesignPartnerCampaignObservation> = {}) {
  return {
    schema: 'commander-design-partner-campaign/v1',
    startedAt: '2026-08-10T00:00:00.000Z',
    endedAt: '2026-08-10T00:00:01.000Z',
    driver: { boundary: 'external-process' as const, identity: 'driver:1' },
    topology: {
      backend: 'postgresql',
      processIdentities: {
        gateway: 'gateway:1',
        kernelOps: 'kernel-ops:1',
        adapterOps: 'adapter-ops:1',
        worker: 'worker:1',
        verifier: 'verifier:1',
      },
      databaseRoles: ['commander_app', 'commander_adapter_ops', 'commander_owner'],
      externalSystem: { mode: 'real' as const, identitySha256: digest('a') },
      standardClientPath: true,
    },
    faultPoints: [...DESIGN_PARTNER_FAULT_POINTS],
    scenarios: DESIGN_PARTNER_SCENARIOS.map((definition) => ({
      id: definition.id,
      passed: true,
      expectedExternalWrites: definition.expectedExternalWrites,
      observedExternalWrites: definition.expectedExternalWrites,
      observedOutcomeQueries: definition.requiresOutcomeQuery ? 1 : 0,
      terminalDisposition: definition.allowedTerminalDispositions[0]!,
      receiptVerified: true,
      evidencePersisted: true,
      reconciliationLatencyMs: definition.requiresOutcomeQuery ? 25 : 0,
    })),
    ...overrides,
  } satisfies DesignPartnerCampaignObservation;
}

describe('governed rollback benchmark aggregation', () => {
  it('parses the canonical kind command arguments', () => {
    assert.deepEqual(
      parseGovernedRollbackBenchmarkArgs([
        '--',
        '--environment',
        'kind',
        '--repetitions',
        '100',
        '--output',
        'artifacts/governed-rollback',
      ]),
      { environment: 'kind', repetitions: 100, output: 'artifacts/governed-rollback' },
    );
    assert.throws(
      () =>
        parseGovernedRollbackBenchmarkArgs([
          '--environment',
          'docker',
          '--repetitions',
          '100',
          '--output',
          'out',
        ]),
      /--environment must be kind/,
    );
    assert.throws(
      () =>
        parseGovernedRollbackBenchmarkArgs([
          '--environment',
          'kind',
          '--repetitions',
          '0',
          '--output',
          'out',
        ]),
      /--repetitions must be a positive integer/,
    );
    assert.throws(
      () =>
        parseGovernedRollbackBenchmarkArgs([
          '--environment',
          'kind',
          '--repetitions',
          '1.5',
          '--output',
          'out',
        ]),
      /--repetitions must be a positive integer/,
    );
  });

  it('splits one hundred repetitions across three fresh environments', () => {
    const plan = buildGovernedRollbackRepetitionPlan(100);
    assert.equal(plan.length, 100);
    assert.deepEqual([...new Set(plan.map((entry) => entry.environmentRebuild))], [0, 1, 2]);
    assert.deepEqual(
      [0, 1, 2].map(
        (rebuild) => plan.filter((entry) => entry.environmentRebuild === rebuild).length,
      ),
      [34, 33, 33],
    );
  });

  it('aggregates every scenario with exact write and evidence thresholds', () => {
    const result = aggregateGovernedRollbackObservations(
      [observation(), observation(), observation()],
      3,
    );

    assert.equal(result.verdict, 'PROVEN');
    assert.deepEqual(result.failures, []);
    assert.equal(result.metrics.totalTrials, 45);
    assert.equal(result.metrics.duplicateWrites, 0);
    assert.equal(result.metrics.deniedScenarioExternalWrites, 0);
    assert.deepEqual(
      Object.values(result.metrics.scenarios).map((scenario) => scenario.trials),
      Array.from({ length: 15 }, () => 3),
    );
  });

  it('rejects an extra external write in a denied scenario', () => {
    const invalid = observation();
    invalid.scenarios.find(({ id }) => id === 'tenant_isolation')!.observedExternalWrites = 1;
    const result = aggregateGovernedRollbackObservations([invalid], 1);

    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('DENIED_SCENARIO_EXTERNAL_WRITES:tenant_isolation'));
    assert.equal(result.metrics.deniedScenarioExternalWrites, 1);
  });

  it('rejects retained artifacts containing secret-bearing fields', () => {
    assert.equal(
      sanitizeGovernedRollbackArtifact('metrics.json', '{"ok":true}\n'),
      '{"ok":true}\n',
    );
    assert.throws(
      () => sanitizeGovernedRollbackArtifact('events.ndjson', '{"password":"secret"}\n'),
      /RETAINED_ARTIFACT_UNSAFE:events\.ndjson/,
    );
    assert.throws(
      () =>
        sanitizeGovernedRollbackArtifact('receipt.json', '{"dsn":"postgres:\/\/user:pass@db"}\n'),
      /RETAINED_ARTIFACT_UNSAFE:receipt\.json/,
    );
    assert.throws(
      () => sanitizeGovernedRollbackArtifact('../outside.json', '{"ok":true}\n'),
      /RETAINED_ARTIFACT_UNSAFE:\.\.\/outside\.json/,
    );
  });

  it('runs each repetition through the external boundary and writes hashed aggregate artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commander-governed-rollback-'));
    const calls: Array<{ repetition: number; environmentRebuild: number }> = [];
    try {
      const result = await runGovernedRollbackBenchmark(
        { environment: 'kind', repetitions: 3, output: directory },
        {
          captureSource: async () => ({
            commit: digest('b').slice(0, 40),
            dirty: false,
            dependencyLockSha256: digest('c'),
          }),
          runTrial: async ({ repetition, environmentRebuild }) => {
            calls.push({ repetition, environmentRebuild });
            return {
              observation: observation(),
              artifacts: {
                'events.ndjson': '{"type":"transition"}\n',
                'receipt.json': '{"verified":true}\n',
                'verification.json': '{"verified":true}\n',
                'metrics.json': '{"duplicateWrites":0}\n',
              },
            };
          },
        },
      );

      assert.equal(result.verdict, 'PROVEN');
      assert.deepEqual(calls, [
        { repetition: 1, environmentRebuild: 0 },
        { repetition: 2, environmentRebuild: 1 },
        { repetition: 3, environmentRebuild: 2 },
      ]);
      await writeGovernedRollbackBenchmarkArtifacts(
        directory,
        {
          environment: 'kind',
          repetitions: 3,
          output: directory,
        },
        result,
      );
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
        verdict: string;
        totalTrials: number;
        artifacts: Array<{ path: string; sha256: string }>;
      };
      assert.equal(manifest.verdict, 'PROVEN');
      assert.equal(manifest.totalTrials, 45);
      assert.ok(manifest.artifacts.some(({ path }) => path === 'metrics.json'));
      assert.match(
        await readFile(join(directory, 'raw-events.ndjson'), 'utf8'),
        /tenant_isolation/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not invoke the campaign driver for a dirty source checkout', async () => {
    let calls = 0;
    const result = await runGovernedRollbackBenchmark(
      { environment: 'kind', repetitions: 3, output: 'artifacts/test-governed-rollback' },
      {
        captureSource: async () => ({
          commit: digest('b').slice(0, 40),
          dirty: true,
          dependencyLockSha256: digest('c'),
        }),
        runTrial: async () => {
          calls += 1;
          throw new Error('driver must not run');
        },
      },
    );
    assert.equal(calls, 0);
    assert.equal(result.verdict, 'NOT_READY');
    assert.ok(result.failures.includes('SOURCE_DIRTY'));
  });
});
