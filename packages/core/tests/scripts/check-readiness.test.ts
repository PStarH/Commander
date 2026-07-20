import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve as pathResolve, basename as pathBasename } from 'node:path';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd.startsWith('git rev-parse')) return 'abc123\n';
    if (cmd.startsWith('pnpm --version')) return '9.0.0\n';
    throw new Error(`unexpected command: ${cmd}`);
  }),
}));

import {
  checkBaselineFile,
  main,
  getCurrentBaseline,
} from '../../../../scripts/check-readiness.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const CURRENT = getCurrentBaseline();

/** Cross-platform mock root — must match path.resolve() used by checkBaselineFile. */
const MOCK_BASELINES_DIR = pathResolve('/mock/baselines');

const REQUIRED_PREFIXES = [
  'tenant-isolation.',
  'tenant-concurrency.',
  'slo-baseline.',
  'wal-baseline.',
  'recovery-baseline.',
  'replay-baseline.',
  'e2e-latency.',
  'cost-prediction.',
  'redteam-baseline.',
  'bench-v2-live.',
] as const;

function healthyBaseline(): Record<string, unknown> {
  return {
    evidenceLevel: 'simulated',
    baseline: { gitSha: CURRENT.gitSha },
    summary: { passed: true, errors: 0, failed: 0, skipped: 0 },
  };
}

type MockFile = {
  name: string;
  mtimeMs: number;
  content: Record<string, unknown>;
};

function mockBaselineFiles(filesByPrefix: Record<string, MockFile[]>): void {
  const allFiles: string[] = [];
  const allContents: Record<string, string> = {};

  for (const files of Object.values(filesByPrefix)) {
    for (const f of files) {
      const filePath = pathResolve(MOCK_BASELINES_DIR, f.name);
      allFiles.push(f.name);
      allContents[filePath] = JSON.stringify(f.content);
    }
  }

  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readdirSync).mockReturnValue(allFiles);
  vi.mocked(readFileSync).mockImplementation((p) => {
    const filePath = typeof p === 'string' ? p : p.toString();
    if (filePath in allContents) return allContents[filePath];
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

function mockBaselines(overrides: Record<string, Record<string, unknown>> = {}): void {
  const filesByPrefix: Record<string, MockFile[]> = {};
  for (const prefix of REQUIRED_PREFIXES) {
    filesByPrefix[prefix] = [
      {
        name: `${prefix}2026-07-13.json`,
        mtimeMs: 1000,
        content: overrides[prefix] ?? healthyBaseline(),
      },
    ];
  }
  mockBaselineFiles(filesByPrefix);
}

describe('checkBaselineFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes for a healthy baseline', () => {
    mockBaselineFiles({
      'tenant-concurrency.': [
        {
          name: 'tenant-concurrency.2026-07-13.json',
          mtimeMs: 1000,
          content: healthyBaseline(),
        },
      ],
    });

    const result = checkBaselineFile(MOCK_BASELINES_DIR, 'tenant-concurrency.', 'required', CURRENT);
    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails strict when baseline has errors', () => {
    mockBaselineFiles({
      'tenant-concurrency.': [
        {
          name: 'tenant-concurrency.2026-07-13.json',
          mtimeMs: 1000,
          content: {
            evidenceLevel: 'simulated',
            baseline: { gitSha: CURRENT.gitSha },
            summary: { passed: true, errors: 104, failed: 0, skipped: 0 },
          },
        },
      ],
    });

    const result = checkBaselineFile(MOCK_BASELINES_DIR, 'tenant-concurrency.', 'required', CURRENT);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('errors > 0');
  });

  it('fails strict when passed=false', () => {
    mockBaselineFiles({
      'tenant-concurrency.': [
        {
          name: 'tenant-concurrency.2026-07-13.json',
          mtimeMs: 1000,
          content: {
            evidenceLevel: 'simulated',
            baseline: { gitSha: CURRENT.gitSha },
            summary: { passed: false, errors: 0, failed: 0, skipped: 0 },
          },
        },
      ],
    });

    const result = checkBaselineFile(MOCK_BASELINES_DIR, 'tenant-concurrency.', 'required', CURRENT);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('summary.passed is not true');
  });

  it('returns the latest matching file by mtime', () => {
    mockBaselineFiles({
      'tenant-concurrency.': [
        {
          name: 'tenant-concurrency.2026-07-08.json',
          mtimeMs: 500,
          content: {
            evidenceLevel: 'simulated',
            baseline: { gitSha: CURRENT.gitSha },
            summary: { passed: true, errors: 0, failed: 0, skipped: 0 },
          },
        },
        {
          name: 'tenant-concurrency.2026-07-13.json',
          mtimeMs: 1000,
          content: {
            evidenceLevel: 'simulated',
            baseline: { gitSha: CURRENT.gitSha },
            summary: { passed: false, errors: 0, failed: 0, skipped: 0 },
          },
        },
      ],
    });

    const result = checkBaselineFile(MOCK_BASELINES_DIR, 'tenant-concurrency.', 'required', CURRENT);
    expect(result.passed).toBe(false);
    expect(result.evidencePath).toContain('tenant-concurrency.2026-07-13.json');
  });
});

describe('main', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits 1 in strict mode when a baseline fails', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockBaselines({
      'tenant-concurrency.': {
        evidenceLevel: 'simulated',
        baseline: { gitSha: CURRENT.gitSha },
        summary: { passed: false, errors: 0, failed: 0, skipped: 0 },
      },
    });

    main(true);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith('❌ READINESS FAIL');

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('exits 0 with warning in non-strict mode when a baseline fails', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    mockBaselines({
      'tenant-concurrency.': {
        evidenceLevel: 'simulated',
        baseline: { gitSha: CURRENT.gitSha },
        summary: { passed: false, errors: 0, failed: 0, skipped: 0 },
      },
    });

    main(false);

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(
      '⚠️  Readiness would fail in strict mode (running with --non-strict)',
    );

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});
