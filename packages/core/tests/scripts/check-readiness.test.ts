import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve as pathResolve, basename as pathBasename } from 'node:path';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

// The source uses spawnSync (not execSync). The mock must return the real
// shape ({status, stdout, error}) so a missing/renamed entry point cannot be
// mistaken for an expected red test.
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'abc123\n' };
    if (cmd === 'pnpm' && args[0] === '--version') return { status: 0, stdout: '9.0.0\n' };
    return { status: 1, stdout: '', error: undefined };
  }),
}));

import {
  checkBaselineFile,
  evaluateReadiness,
  loadReadinessProfile,
  main,
  getCurrentBaseline,
  PROFILE_PATH,
  type CheckResult,
} from '../../../../scripts/check-readiness.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/** Cross-platform mock root — must match path.resolve() used by checkBaselineFile. */
const MOCK_BASELINES_DIR = pathResolve('/mock/baselines');
/** main() reads the repo-relative baselines dir; register the same fixtures there. */
const MAIN_BASELINES_DIR = pathResolve('docs/baselines');

const CURRENT = getCurrentBaseline();

const BASELINE_PREFIXES = [
  'tenant-isolation.',
  'tenant-concurrency.',
  'slo-baseline.',
  'failover-rto-live.',
  'wal-baseline.',
  'recovery-baseline.',
  'replay-baseline.',
  'e2e-latency.',
  'cost-prediction.',
  'redteam-baseline.',
  'bench-v2-live.',
  'benchmark-',
] as const;

function liveHealthyBaseline(): Record<string, unknown> {
  return {
    evidenceLevel: 'live',
    baseline: {
      gitSha: CURRENT.gitSha,
      nodeVersion: CURRENT.nodeVersion,
      pnpmVersion: CURRENT.pnpmVersion,
    },
    summary: { passed: true, errors: 0, failed: 0, skipped: 0 },
  };
}

function simulatedHealthyBaseline(): Record<string, unknown> {
  return {
    evidenceLevel: 'simulated',
    baseline: { gitSha: 'fixture' },
    summary: { passed: true, errors: 0, failed: 0, skipped: 0 },
  };
}

type MockFile = {
  name: string;
  mtimeMs: number;
  content: Record<string, unknown>;
};

type FsSpec = {
  baselinesDirExists?: boolean;
  files?: Record<string, MockFile[]>;
  /** `undefined` ⇒ the profile file is absent. */
  profile?: unknown;
  /** `true` ⇒ readFileSync throws for the profile path (unreadable file). */
  profileUnreadable?: boolean;
};

function mockFs(spec: FsSpec): void {
  const filesByPrefix = spec.files ?? {};
  const allFiles: string[] = [];
  const allContents: Record<string, string> = {};

  for (const files of Object.values(filesByPrefix)) {
    for (const f of files) {
      allFiles.push(f.name);
      const body = JSON.stringify(f.content);
      allContents[pathResolve(MOCK_BASELINES_DIR, f.name)] = body;
      allContents[pathResolve(MAIN_BASELINES_DIR, f.name)] = body;
    }
  }
  const profileText = spec.profile === undefined ? undefined : JSON.stringify(spec.profile);

  vi.mocked(existsSync).mockImplementation((p) => {
    const filePath = typeof p === 'string' ? p : p.toString();
    if (filePath === PROFILE_PATH) return spec.profile !== undefined;
    if (filePath === MOCK_BASELINES_DIR || filePath === MAIN_BASELINES_DIR) {
      return spec.baselinesDirExists !== false;
    }
    return true;
  });
  vi.mocked(readdirSync).mockReturnValue(allFiles);
  vi.mocked(readFileSync).mockImplementation((p) => {
    const filePath = typeof p === 'string' ? p : p.toString();
    if (filePath === PROFILE_PATH) {
      if (spec.profileUnreadable) throw new Error(`EACCES: ${filePath}`);
      if (profileText === undefined) throw new Error(`unexpected read: ${filePath}`);
      return profileText;
    }
    if (filePath in allContents) return allContents[filePath]!;
    throw new Error(`unexpected read: ${filePath}`);
  });
  vi.mocked(statSync).mockImplementation((p) => {
    const filePath = typeof p === 'string' ? p : p.toString();
    const name = pathBasename(filePath);
    for (const files of Object.values(filesByPrefix)) {
      const found = files.find((f) => f.name === name);
      if (found) return { mtimeMs: found.mtimeMs } as ReturnType<typeof statSync>;
    }
    return { mtimeMs: 0 } as ReturnType<typeof statSync>;
  });
}

function allLiveHealthyFiles(
  overrides: Record<string, Record<string, unknown>> = {},
): Record<string, MockFile[]> {
  const filesByPrefix: Record<string, MockFile[]> = {};
  for (const prefix of BASELINE_PREFIXES) {
    filesByPrefix[prefix] = [
      {
        name: `${prefix}2026-07-13.json`,
        mtimeMs: 1000,
        content: overrides[prefix] ?? liveHealthyBaseline(),
      },
    ];
  }
  return filesByPrefix;
}

const FULL_PROFILE = {
  schema: 'commander-readiness-profile/v1',
  required: [...BASELINE_PREFIXES],
};

function mockBaselines(overrides: Record<string, Record<string, unknown>> = {}): void {
  mockFs({ files: allLiveHealthyFiles(overrides) });
}

/** Capture console.log + process.exit without letting main() run off the rails. */
function captureRun(strict: boolean): { lines: string[]; exitCode: number | undefined } {
  const lines: string[] = [];
  let exitCode: number | undefined;
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    return undefined as never;
  }) as never);
  main(strict);
  logSpy.mockRestore();
  exitSpy.mockRestore();
  return { lines, exitCode };
}

describe('checkBaselineFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes for a healthy live baseline on required', () => {
    mockFs({
      files: {
        'tenant-concurrency.': [
          {
            name: 'tenant-concurrency.2026-07-13.json',
            mtimeMs: 1000,
            content: liveHealthyBaseline(),
          },
        ],
      },
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects simulated evidence for required readiness', () => {
    mockFs({
      files: {
        'tenant-concurrency.': [
          {
            name: 'tenant-concurrency.2026-07-13.json',
            mtimeMs: 1000,
            content: simulatedHealthyBaseline(),
          },
        ],
      },
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('does not count toward required readiness');
  });

  it('marks simulated evidence non-scoring for recommended', () => {
    mockFs({
      files: {
        'tenant-concurrency.': [
          {
            name: 'tenant-concurrency.2026-07-13.json',
            mtimeMs: 1000,
            content: simulatedHealthyBaseline(),
          },
        ],
      },
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'recommended',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('non-scoring');
  });

  it('fails strict when baseline has errors', () => {
    mockFs({
      files: {
        'tenant-concurrency.': [
          {
            name: 'tenant-concurrency.2026-07-13.json',
            mtimeMs: 1000,
            content: {
              evidenceLevel: 'live',
              baseline: { gitSha: CURRENT.gitSha, nodeVersion: CURRENT.nodeVersion },
              summary: { passed: true, errors: 104, failed: 0, skipped: 0 },
            },
          },
        ],
      },
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('errors > 0');
  });

  it('fails strict when passed=false', () => {
    mockFs({
      files: {
        'tenant-concurrency.': [
          {
            name: 'tenant-concurrency.2026-07-13.json',
            mtimeMs: 1000,
            content: {
              evidenceLevel: 'live',
              baseline: { gitSha: CURRENT.gitSha, nodeVersion: CURRENT.nodeVersion },
              summary: { passed: false, errors: 0, failed: 0, skipped: 0 },
            },
          },
        ],
      },
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('summary.passed is not true');
  });

  it('fails strict when live evidence is bound to a different candidate SHA', () => {
    mockFs({
      files: {
        'tenant-concurrency.': [
          {
            name: 'tenant-concurrency.2026-07-13.json',
            mtimeMs: 1000,
            content: {
              evidenceLevel: 'live',
              baseline: { gitSha: 'stale-sha', nodeVersion: CURRENT.nodeVersion },
              summary: { passed: true, errors: 0, failed: 0, skipped: 0 },
            },
          },
        ],
      },
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('gitSha mismatch');
  });

  it('fails strict when the baseline file is not valid JSON', () => {
    mockFs({ files: {} });
    vi.mocked(readdirSync).mockReturnValue(['tenant-concurrency.2026-07-13.json']);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const filePath = typeof p === 'string' ? p : p.toString();
      if (filePath === PROFILE_PATH) throw new Error('no profile');
      return '{ not json';
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('invalid JSON');
  });

  it('fails strict when the baselines directory is missing', () => {
    mockFs({ baselinesDirExists: false, files: {} });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('missing');
  });

  it('returns the latest matching file by name order', () => {
    mockFs({
      files: {
        'tenant-concurrency.': [
          {
            name: 'tenant-concurrency.2026-07-08.json',
            mtimeMs: 500,
            content: liveHealthyBaseline(),
          },
          {
            name: 'tenant-concurrency.2026-07-13.json',
            mtimeMs: 1000,
            content: {
              evidenceLevel: 'live',
              baseline: { gitSha: CURRENT.gitSha, nodeVersion: CURRENT.nodeVersion },
              summary: { passed: false, errors: 0, failed: 0, skipped: 0 },
            },
          },
        ],
      },
    });

    const result = checkBaselineFile(
      MOCK_BASELINES_DIR,
      'tenant-concurrency.',
      'required',
      CURRENT,
    );
    expect(result.passed).toBe(false);
    expect(result.evidencePath).toContain('tenant-concurrency.2026-07-13.json');
  });
});

describe('evaluateReadiness', () => {
  const slot = (
    id: string,
    declaredStatus: 'required' | 'recommended',
    passed: boolean,
  ): CheckResult => ({ id, title: id, declaredStatus, evidenceFound: true, passed });

  it('is NOT_EVALUATED — not PASS — when nothing is required', () => {
    const evaluation = evaluateReadiness([slot('a', 'recommended', true)], undefined, 'no profile');
    expect(evaluation.status).toBe('NOT_EVALUATED');
    expect(evaluation.requiredCount).toBe(0);
    expect(evaluation.reasons.join('\n')).toContain('no required readiness slot was evaluated');
  });

  it('is NOT_EVALUATED when the profile is present but no slot was marked required', () => {
    const evaluation = evaluateReadiness([slot('a', 'recommended', false)], {
      schema: 'commander-readiness-profile/v1',
      required: ['a'],
    });
    expect(evaluation.status).toBe('NOT_EVALUATED');
  });

  it('is FAIL when a required slot did not pass', () => {
    const evaluation = evaluateReadiness(
      [slot('a', 'required', true), slot('b', 'required', false)],
      { schema: 'commander-readiness-profile/v1', required: ['a', 'b'] },
    );
    expect(evaluation.status).toBe('FAIL');
    expect(evaluation.requiredPassed).toBe(1);
    expect(evaluation.reasons.join('\n')).toContain('required slot b');
  });

  it('is PASS only when every required slot passed', () => {
    const evaluation = evaluateReadiness(
      [slot('a', 'required', true), slot('b', 'required', true)],
      { schema: 'commander-readiness-profile/v1', required: ['a', 'b'] },
    );
    expect(evaluation.status).toBe('PASS');
    expect(evaluation.reasons).toEqual([]);
  });
});

describe('loadReadinessProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a reason instead of an empty required set when the profile is absent', () => {
    mockFs({ profile: undefined });
    const { profile, reason } = loadReadinessProfile();
    expect(profile).toBeUndefined();
    expect(reason).toContain('no approved readiness profile');
  });

  it('rejects a profile with the wrong schema', () => {
    mockFs({ profile: { schema: 'something-else/v1', required: ['slo-baseline.'] } });
    const { profile, reason } = loadReadinessProfile();
    expect(profile).toBeUndefined();
    expect(reason).toContain('schema');
  });

  it('rejects unknown keys', () => {
    mockFs({
      profile: { schema: 'commander-readiness-profile/v1', required: ['slo-baseline.'], extra: 1 },
    });
    const { profile, reason } = loadReadinessProfile();
    expect(profile).toBeUndefined();
    expect(reason).toContain('unknown keys');
  });

  it('rejects a profile that names a slot the gate cannot evaluate', () => {
    mockFs({
      profile: { schema: 'commander-readiness-profile/v1', required: ['does-not-exist.'] },
    });
    const { profile, reason } = loadReadinessProfile();
    expect(profile).toBeUndefined();
    expect(reason).toContain('unknown slots');
  });

  it('rejects an empty or duplicate required list', () => {
    mockFs({ profile: { schema: 'commander-readiness-profile/v1', required: [] } });
    expect(loadReadinessProfile().reason).toContain('no required slots');

    mockFs({
      profile: {
        schema: 'commander-readiness-profile/v1',
        required: ['slo-baseline.', 'slo-baseline.'],
      },
    });
    expect(loadReadinessProfile().reason).toContain('duplicate');
  });

  it('accepts a well-formed profile', () => {
    mockFs({ profile: FULL_PROFILE });
    const { profile, reason } = loadReadinessProfile();
    expect(reason).toBeUndefined();
    expect(profile?.required).toContain('slo-baseline.');
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is NOT_EVALUATED and non-zero in strict mode with no approved profile', () => {
    mockBaselines({ 'tenant-concurrency.': simulatedHealthyBaseline() });

    const { lines, exitCode } = captureRun(true);

    expect(exitCode).toBe(1);
    expect(lines.some((l) => l.includes('READINESS NOT_EVALUATED'))).toBe(true);
    expect(lines.some((l) => l.includes('READINESS PASS'))).toBe(false);
  });

  it('is NOT_EVALUATED and non-zero in strict mode when the profile is unreadable', () => {
    mockFs({ files: allLiveHealthyFiles(), profile: FULL_PROFILE, profileUnreadable: true });

    const { lines, exitCode } = captureRun(true);

    expect(exitCode).toBe(1);
    expect(lines.some((l) => l.includes('READINESS NOT_EVALUATED'))).toBe(true);
  });

  it('passes in strict mode only when every required slot has live, candidate-bound evidence', () => {
    mockFs({ files: allLiveHealthyFiles(), profile: FULL_PROFILE });

    const { lines, exitCode } = captureRun(true);

    expect(exitCode).toBe(0);
    expect(lines.some((l) => l.includes('✅ READINESS PASS'))).toBe(true);
  });

  it('fails in strict mode when a required slot only has simulated evidence', () => {
    mockFs({
      files: allLiveHealthyFiles({ 'slo-baseline.': simulatedHealthyBaseline() }),
      profile: FULL_PROFILE,
    });

    const { lines, exitCode } = captureRun(true);

    expect(exitCode).toBe(1);
    expect(lines.some((l) => l.includes('READINESS FAIL'))).toBe(true);
    expect(lines.some((l) => l.includes('does not count toward required readiness'))).toBe(true);
  });

  it('fails in strict mode when a required slot is bound to a stale SHA', () => {
    mockFs({
      files: allLiveHealthyFiles({
        'slo-baseline.': {
          evidenceLevel: 'live',
          baseline: { gitSha: 'stale-sha', nodeVersion: CURRENT.nodeVersion },
          summary: { passed: true, errors: 0, failed: 0, skipped: 0 },
        },
      }),
      profile: FULL_PROFILE,
    });

    const { exitCode, lines } = captureRun(true);

    expect(exitCode).toBe(1);
    expect(lines.some((l) => l.includes('gitSha mismatch'))).toBe(true);
  });

  it('fails in strict mode when a required slot has no baseline at all', () => {
    mockFs({ files: {}, profile: FULL_PROFILE });

    const { exitCode, lines } = captureRun(true);

    expect(exitCode).toBe(1);
    expect(lines.some((l) => l.includes('no benchmark-*.json baseline'))).toBe(true);
  });

  it('reports DIAGNOSTIC_ONLY and never a readiness pass in non-strict mode', () => {
    mockFs({ files: allLiveHealthyFiles(), profile: FULL_PROFILE });

    const { lines, exitCode } = captureRun(false);

    expect(exitCode).toBe(0);
    expect(lines.some((l) => l.includes('DIAGNOSTIC_ONLY'))).toBe(true);
    expect(lines.some((l) => l.includes('READINESS PASS'))).toBe(false);
  });
});
