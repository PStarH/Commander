import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it, before, after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { IntegrityLayer } from '../packages/core/src/security/securityPrimitives.js';
import {
  AUDIT_ERROR_CODES,
  buildReport,
  evaluate,
  parseFlags,
  parseNonNegativeInt,
  resolveThreshold,
  writeReportAtomic,
} from './audit-report.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'audit-report.ts');

/** Run the real CLI in a subprocess with a controlled environment. */
function runCli(
  args: string[],
  options: {
    databaseUrl?: string;
    integrityKey?: string;
    extraEnv?: Record<string, string>;
  } = {},
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  delete env.COMMANDER_KERNEL_DATABASE_URL;
  delete env.OWNER_DSN;
  delete env.COMMANDER_INTEGRITY_KEY;
  delete env.AUDIT_DLQ_DEPTH_THRESHOLD;
  delete env.AUDIT_WORKER_STALE_MS;
  if (options.databaseUrl !== undefined) env.DATABASE_URL = options.databaseUrl;
  if (options.integrityKey !== undefined) env.COMMANDER_INTEGRITY_KEY = options.integrityKey;
  Object.assign(env, options.extraEnv ?? {});
  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

let workDir: string;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'audit-report-contract-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function outPath(name: string): string {
  return join(workDir, name);
}

describe('audit-report CLI — production mode must not fall back to the in-memory fixture', () => {
  it('fails closed with AUDIT_DATABASE_REQUIRED and writes nothing when DATABASE_URL is absent', () => {
    const target = outPath('missing-db.json');
    const { status, stderr, stdout } = runCli(['--output', target]);

    assert.equal(status, 1);
    assert.match(stderr, new RegExp(AUDIT_ERROR_CODES.databaseRequired));
    // Zero file, zero signature, zero report on stdout.
    assert.throws(() => statSync(target));
    assert.doesNotMatch(stdout, /_sig/);
    assert.doesNotMatch(stdout, /"status"/);
  });

  it('fails closed with AUDIT_DATABASE_UNREACHABLE and writes nothing when the DB cannot be queried', () => {
    const target = outPath('unreachable-db.json');
    const { status, stderr } = runCli(['--output', target], {
      databaseUrl: 'postgresql://nobody:nopass@127.0.0.1:1/nope',
    });

    assert.equal(status, 1);
    assert.match(stderr, new RegExp(AUDIT_ERROR_CODES.databaseUnreachable));
    assert.throws(() => statSync(target));
    // The DSN password must never appear in the diagnostic output.
    assert.doesNotMatch(stderr, /nopass/);
    assert.match(stderr, /nobody:\*\*\*@/);
  });

  it('treats an empty DATABASE_URL as absent rather than as test mode', () => {
    const target = outPath('empty-db.json');
    const { status, stderr } = runCli(['--output', target], { databaseUrl: '' });

    assert.equal(status, 1);
    assert.match(stderr, new RegExp(AUDIT_ERROR_CODES.databaseRequired));
    assert.throws(() => statSync(target));
  });
});

describe('audit-report CLI — explicit --test produces a non-production artifact', () => {
  it('labels the artifact simulated/NOT_EVALUATED and never as a production PASS', () => {
    const target = outPath('test-mode.json');
    const { status, stdout } = runCli(['--test', '--output', target]);

    assert.equal(status, 0);
    assert.match(stdout, /Audit NOT_EVALUATED/);

    const report = JSON.parse(readFileSync(target, 'utf-8')) as Record<string, unknown>;
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.executionMode, 'test');
    assert.equal(report.evidenceLevel, 'simulated');
    assert.equal(report.measurementStatus, 'SIMULATED');
    assert.equal(report.integrityClaim, 'SEQUENCE_ONLY');
    assert.equal(report.status, 'NOT_EVALUATED');
    assert.notEqual(report.status, 'PASS');
    assert.equal(report.fixtureChecksPassed, true);
    assert.ok(typeof report._sig === 'string' && report._sig.length > 0);
  });

  it('refuses to overwrite an existing report', () => {
    const target = outPath('no-overwrite.json');
    const first = runCli(['--test', '--output', target]);
    assert.equal(first.status, 0);

    const second = runCli(['--test', '--output', target]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, new RegExp(AUDIT_ERROR_CODES.outputExists));
  });

  it('--json prints the report and writes no file', () => {
    const { status, stdout } = runCli(['--test', '--json']);
    assert.equal(status, 0);
    const report = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(report.status, 'NOT_EVALUATED');
    assert.equal(report.executionMode, 'test');
  });
});

describe('audit-report — the signature covers the execution labels', () => {
  const metrics = {
    runsByState: {},
    stepsByState: {},
    dlqDepth: 0,
    dlqOldestEntry: null,
    outboxPending: 0,
    eventLogSize: 0,
    eventSequenceContiguity: 'CONTIGUOUS' as const,
    cryptographicChainIntegrity: 'EMPTY' as const,
    workerCount: 1,
    workerHeartbeatsHealthy: true,
    staleWorkerCount: 0,
    interactionPending: 0,
    walSizeMb: 0,
    tenantCount: 1,
  };

  function verifyArtifact(report: Record<string, unknown>, key: string): boolean {
    const { _sig, ...rest } = report as { _sig: string } & Record<string, unknown>;
    return new IntegrityLayer(key).verify({
      data: rest,
      _sig,
      _ts: rest._ts as number,
    });
  }

  it('signs the labels, so re-labelling a fixture as production breaks verification', () => {
    const key = 'contract-test-integrity-key';
    const previous = process.env.COMMANDER_INTEGRITY_KEY;
    process.env.COMMANDER_INTEGRITY_KEY = key;
    let report: Record<string, unknown>;
    try {
      report = buildReport('in-memory', '', metrics, true) as unknown as Record<string, unknown>;
    } finally {
      if (previous === undefined) delete process.env.COMMANDER_INTEGRITY_KEY;
      else process.env.COMMANDER_INTEGRITY_KEY = previous;
    }

    assert.equal(verifyArtifact(report, key), true);

    // Rewriting the label without re-signing must invalidate the signature.
    const tampered = { ...report, executionMode: 'production', status: 'PASS' };
    assert.equal(verifyArtifact(tampered, key), false);
  });

  it('marks production artifacts as measured/live', () => {
    const report = buildReport(
      'postgresql',
      'postgresql://u:***@h/db',
      metrics,
      false,
    ) as unknown as Record<string, unknown>;
    assert.equal(report.executionMode, 'production');
    assert.equal(report.evidenceLevel, 'live');
    assert.equal(report.measurementStatus, 'MEASURED');
    assert.equal(report.status, 'PASS');
    assert.equal(report.fixtureChecksPassed, undefined);
  });
});

describe('audit-report — sequence contiguity is not cryptographic integrity', () => {
  const base = {
    runsByState: {},
    stepsByState: {},
    dlqDepth: 0,
    dlqOldestEntry: null,
    outboxPending: 0,
    eventLogSize: 10,
    eventSequenceContiguity: 'CONTIGUOUS' as const,
    cryptographicChainIntegrity: 'NOT_VERIFIED' as const,
    workerCount: 1,
    workerHeartbeatsHealthy: true,
    staleWorkerCount: 0,
    interactionPending: 0,
    walSizeMb: 0,
    tenantCount: 1,
  };

  it('does not treat contiguous sequence numbers as a verified hash chain', () => {
    const result = evaluate(base, false);
    assert.equal(result.status, 'FAIL');
    assert.ok(
      result.failures.some((f) => f.includes('cryptographic chain integrity is NOT_VERIFIED')),
      `expected a NOT_VERIFIED failure, got: ${result.failures.join(' | ')}`,
    );
  });

  it('fails when the sequence query could not be evaluated at all', () => {
    const result = evaluate({ ...base, eventSequenceContiguity: 'UNKNOWN' }, false);
    assert.equal(result.status, 'FAIL');
    assert.ok(result.failures.some((f) => f.includes('could not be measured (UNKNOWN)')));
  });

  it('fails when sequence gaps are detected', () => {
    const result = evaluate({ ...base, eventSequenceContiguity: 'GAPS_DETECTED' }, false);
    assert.equal(result.status, 'FAIL');
    assert.ok(result.failures.some((f) => f.includes('sequence contiguity FAILED')));
  });

  it('passes only when contiguity holds and the chain is genuinely empty', () => {
    const result = evaluate(
      { ...base, eventLogSize: 0, cryptographicChainIntegrity: 'EMPTY' },
      false,
    );
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.failures, []);
  });
});

describe('audit-report helpers', () => {
  it('parseNonNegativeInt rejects absent, non-numeric, negative and non-integer input', () => {
    assert.equal(parseNonNegativeInt(undefined), undefined);
    assert.equal(parseNonNegativeInt(''), undefined);
    assert.equal(parseNonNegativeInt('   '), undefined);
    assert.equal(parseNonNegativeInt('abc'), undefined);
    assert.equal(parseNonNegativeInt('-1'), undefined);
    assert.equal(parseNonNegativeInt('1.5'), undefined);
    assert.equal(parseNonNegativeInt('NaN'), undefined);
    assert.equal(parseNonNegativeInt('0'), 0);
    assert.equal(parseNonNegativeInt(' 12 '), 12);
  });

  it('parseFlags reads --output in both forms and rejects a missing value', () => {
    assert.equal(parseFlags(['--output', '/tmp/x.json']).output, '/tmp/x.json');
    assert.equal(parseFlags(['--output=/tmp/y.json']).output, '/tmp/y.json');
    assert.equal(parseFlags(['--output']).output, undefined);
    assert.equal(parseFlags(['--output', '--json']).output, undefined);
    assert.equal(parseFlags(['--test', '--json']).test, true);
    assert.equal(parseFlags([]).test, false);
  });

  it('writeReportAtomic is 0600, atomic, and never overwrites', () => {
    const dir = join(workDir, 'atomic');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'report.json');

    writeReportAtomic(target, '{"a":1}\n');
    assert.equal(readFileSync(target, 'utf-8'), '{"a":1}\n');
    assert.equal(statSync(target).mode & 0o777, 0o600);

    assert.throws(
      () => writeReportAtomic(target, '{"a":2}\n'),
      new RegExp(AUDIT_ERROR_CODES.outputExists),
    );
    assert.equal(readFileSync(target, 'utf-8'), '{"a":1}\n');
  });

  it('writeReportAtomic leaves no temp file behind on success', () => {
    const dir = join(workDir, 'atomic-clean');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'report.json');
    writeReportAtomic(target, '{}\n');
    assert.deepEqual(readdirSync(dir), ['report.json']);
  });

  it('a pre-existing unrelated file does not block a differently named report', () => {
    const dir = join(workDir, 'unrelated');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'other.txt'), 'x');
    writeReportAtomic(join(dir, 'report.json'), '{}\n');
    assert.ok(statSync(join(dir, 'report.json')).isFile());
  });
});

describe('audit-report — a malformed threshold can never disable its check', () => {
  it('resolveThreshold rejects NaN-producing input and keeps the documented default', () => {
    assert.equal(resolveThreshold(undefined, 100), 100);
    assert.equal(resolveThreshold('', 100), 100);
    assert.equal(resolveThreshold('abc', 100), 100);
    assert.equal(resolveThreshold('1e3', 100), 100);
    assert.equal(resolveThreshold('-5', 100), 100);
    assert.equal(resolveThreshold('1.5', 100), 100);
    assert.equal(resolveThreshold('NaN', 100), 100);
    assert.equal(resolveThreshold('0', 100), 0);
    assert.equal(resolveThreshold('250', 100), 250);
  });

  it('the signed report carries a usable DLQ threshold when the env var is malformed', () => {
    const target = outPath('bad-threshold.json');
    const { status } = runCli(['--test', '--output', target], {
      extraEnv: { AUDIT_DLQ_DEPTH_THRESHOLD: 'abc' },
    });
    assert.equal(status, 0);
    const report = JSON.parse(readFileSync(target, 'utf-8')) as {
      thresholds: { dlqDepth: unknown; workerStaleMs: unknown };
    };
    // Pre-fix this was NaN, i.e. `null` after JSON serialisation: every
    // `dlqDepth > threshold` comparison was false, so the CRITICAL DLQ check
    // could not fire at all.
    assert.equal(report.thresholds.dlqDepth, 100);
    assert.equal(typeof report.thresholds.dlqDepth, 'number');
  });

  it('the CRITICAL DLQ check still fires on a depth above the default threshold', () => {
    const result = evaluate(
      {
        runsByState: {},
        stepsByState: {},
        dlqDepth: 500,
        dlqOldestEntry: null,
        outboxPending: 0,
        eventLogSize: 0,
        eventSequenceContiguity: 'CONTIGUOUS' as const,
        cryptographicChainIntegrity: 'EMPTY' as const,
        workerCount: 1,
        workerHeartbeatsHealthy: true,
        staleWorkerCount: 0,
        interactionPending: 0,
        walSizeMb: 0,
        tenantCount: 1,
      },
      false,
    );
    assert.ok(
      result.failures.some((failure) => failure.includes('CRITICAL: DLQ depth 500')),
      result.failures.join('\n'),
    );
  });
});
