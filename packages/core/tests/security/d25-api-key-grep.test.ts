/**
 * D2.5 hardening-sprint — plaintext API key CI gate.
 *
 * Why this exists
 * ───────────────
 * D2.5 §3 (docs/security/hardening-sprint.md) requires:
 *   "Replace hits with env-var indirection (process.env.X) — never commit
 *    plaintext. Add regression test that grep-scan is empty before commit
 *    (CI gate)."
 *
 * Earlier investigation confirmed all `sk-/ghp_/AKIA/xox` prefix hits live
 * in test fixtures (outputSanitizer.test.ts, agentjacking.test.ts) — those
 * are intentional test data, out of scan scope. apps/api/src + apps/web/src
 * MUST stay clean of plaintext.
 *
 * Design choices
 * ──────────────
 *   • Uses node's `fs.readdirSync` (recursive) instead of shelling out to
 *     `grep` — works on macOS (BSD grep) and Linux (GNU grep) without
 *     worrying about regex dialect differences or installer dependencies.
 *   • Scan scope matches what the sprint card intended: `apps/api/src`
 *     and `apps/web/src` only. The card wrote `packages/apps/api/src`
 *     but the project layout actually places apps under `apps/`.
 *   • Skip test fixtures by basename pattern (`*.test.ts`, `*.spec.ts`,
 *     `*.fixture.ts`). The current scan paths contain ZERO such files
 *     today; this rule is forward-defensive.
 *   • Skip generated/build directories (`node_modules`, `dist`, `build`,
 *     `.next`, `.git`, `.commander`) — never scan generated artifacts.
 *
 * If this test fails: read the violation message — it includes the file,
 * line number, line content, and the matched prefix pattern. Replace the
 * plaintext with `process.env.SOMETHING` and add the variable to your
 * deployment README. See docs/security/keys-rotation.md for cadence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'apps/api/src'),
  path.join(REPO_ROOT, 'apps/web/src'),
] as const;

// Basename patterns that mark test fixtures / generated / vendored files.
// Same intent as .gitignore but expressed so we don't depend on git state.
const EXCLUDED_DIR_NAMES = new Set<string>([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.commander',
  '.turbo',
  'coverage',
  '__snapshots__',
]);
const EXCLUDED_FILE_PATTERNS: RegExp[] = [
  /\.test\.(?:ts|tsx|js|jsx)$/,
  /\.spec\.(?:ts|tsx|js|jsx)$/,
  /\.fixture\.(?:ts|tsx|js|jsx)$/,
  /\.d\.ts$/,
  /\.gen\.ts$/,
];

// Detector patterns mirror SupplyChainScanner's privacy/credential concern set.
// Each pattern is paired with the env-var name the prefix is conventionally
// stored in — when remediation fires, the operator knows where to migrate.
interface PatternDef {
  readonly id: string;
  readonly prefix: string;
  readonly regex: RegExp;
  readonly exampleEnvVar: string;
}

const PATTERNS: readonly PatternDef[] = [
  {
    id: 'openai-sk',
    prefix: 'sk-',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
    exampleEnvVar: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic-sk-ant',
    prefix: 'sk-ant-',
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    exampleEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'github-gh',
    prefix: 'gh*_',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
    exampleEnvVar: 'GITHUB_TOKEN',
  },
  {
    id: 'aws-access-key',
    prefix: '(A|S)KIA',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    exampleEnvVar: 'AWS_ACCESS_KEY_ID',
  },
  {
    id: 'slack-xox',
    prefix: 'xox*-',
    regex: /\bxox[abprs]-[A-Za-z0-9-]{16,}/g,
    exampleEnvVar: 'SLACK_BOT_TOKEN',
  },
];

interface Violation {
  file: string;
  line: number;
  matched: string;
  patternId: string;
  exampleEnvVar: string;
  excerpt: string;
}

let scannedFileCount = 0;
const scannedPerRoot: Record<string, number> = {};
let violations: Violation[] = [];

function collectFiles(out: string[], dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing root = no files contributed; skip silently.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      collectFiles(out, full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
    out.push(full);
  }
}

function scanFileForPatterns(file: string): Violation[] {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const hits: Violation[] = [];
  for (const def of PATTERNS) {
    def.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = def.regex.exec(content)) !== null) {
      const before = content.slice(0, m.index);
      const lineNumber = before.split('\n').length;
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineEnd = content.indexOf('\n', m.index + m[0].length);
      const lineContent = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
      // Guard: skip obvious test-data lines that contain the word 'fixture',
      // 'mock', 'example', or are commented out with `// fake` style. The
      // test-fixture basename rule already handles *.test.ts files; this
      // catches the rare in-source mock string.
      const trimmed = lineContent.trim().toLowerCase();
      if (
        trimmed.includes('// fake') ||
        trimmed.includes('// example') ||
        trimmed.includes('// mock') ||
        (trimmed.startsWith('// ') === false && trimmed.includes('fixture:'))
      ) {
        continue;
      }
      hits.push({
        file: path.relative(REPO_ROOT, file),
        line: lineNumber,
        matched: m[0].slice(0, 32) + (m[0].length > 32 ? '…' : ''),
        patternId: def.id,
        exampleEnvVar: def.exampleEnvVar,
        excerpt: lineContent.trim().slice(0, 120),
      });
    }
  }
  return hits;
}

describe('D2.5 hardening — plaintext API key grep gate', () => {
  beforeAll(() => {
    violations = [];
    scannedFileCount = 0;
    const files: string[] = [];
    for (const root of SCAN_ROOTS) {
      const rootFiles: string[] = [];
      collectFiles(rootFiles, root);
      scannedPerRoot[path.relative(REPO_ROOT, root)] = rootFiles.length;
      files.push(...rootFiles);
    }
    scannedFileCount = files.length;
    for (const f of files) {
      violations.push(...scanFileForPatterns(f));
    }
  });

  afterAll(() => {
    // Surface per-root scan counts so an asymmetric-missing scenario
    // (e.g. apps/web/src missing on a slim CI clone) is visible in CI logs
    // even when the gate passes overall.
    for (const [root, count] of Object.entries(scannedPerRoot)) {
      // eslint-disable-next-line no-console
      console.log(`[D2.5] ${root}: ${count} files scanned`);
    }
    if (violations.length === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[D2.5] TOTAL scanned=${scannedFileCount} files across ${SCAN_ROOTS.length} roots; zero plaintext API-key hits.`,
      );
    }
  });

  it('apps/api/src + apps/web/src contain zero plaintext API keys (sk-/gh*_/AKIA/xox*)', () => {
    expect(violations, violations.map((v) => vToString(v)).join('\n')).toEqual([]);
  });

  it('regression: scan roots still resolve after re-walk', () => {
    expect(SCAN_ROOTS.length).toBe(2);
    expect(fs.existsSync(SCAN_ROOTS[0]!)).toBe(true);
    expect(fs.existsSync(SCAN_ROOTS[1]!)).toBe(true);
    expect(scannedFileCount).toBeGreaterThan(0);
  });
});

describe('D2.5 hardening — regex set sanity (positive + negative fixtures)', () => {
  // Positive fixtures confirm every regex DOES match its canonical prefix.
  // If any of these flip to FALSE the entire gate has lost coverage and
  // would silently let plaintext through.
  const POSITIVE: ReadonlyArray<[string, string]> = [
    ['openai-sk', 'sk-proj-abcdef0123456789abcdef0123456789'],
    ['openai-sk', 'sk-abcdef0123456789abcdef0123456789'],
    ['anthropic-sk-ant', 'sk-ant-abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghp_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'gho_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghu_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghs_abcdef0123456789abcdef0123456789'],
    ['github-gh', 'ghr_abcdef0123456789abcdef0123456789'],
    ['aws-access-key', 'AKIA0123456789ABCDEF'],
    ['aws-access-key', 'ASIA0123456789ABCDEF'],
    ['slack-xox', 'xox' + 'b-' + 'TEST-FIXTURE-NOT-A-REAL-SLACK-TOKEN-0123456'],
  ];
  for (const [patternId, secretFixture] of POSITIVE) {
    it(`POSITIVE: ${patternId} matches canonical fixture`, () => {
      const def = PATTERNS.find((p) => p.id === patternId);
      expect(def, `pattern id ${patternId} is defined`).toBeTruthy();
      def!.regex.lastIndex = 0;
      expect(def!.regex.test(secretFixture), `${patternId} must match ${secretFixture}`).toBe(true);
    });
  }

  // Negative fixtures guard against future regex over-tightening that would
  // suppress legitimate test-mock strings, env-var references, and short
  // named-dashed identifiers.
  const NEGATIVE: ReadonlyArray<[string, string]> = [
    ['short-prefix', 'sk-abc'],
    ['env-var-name', 'process.env.OPENAI_API_KEY'],
    ['underscores-and-digits-only', 'sk-_____12'],
    ['comment-line', '// sk-1234 is documented here as a placeholder'],
    ['spec-reference', 'expect(token).toMatch(/^sk-/i)'],
  ];
  for (const [label, shouldNotMatch] of NEGATIVE) {
    it(`NEGATIVE: ${label} does not falsely trigger any pattern`, () => {
      for (const def of PATTERNS) {
        def.regex.lastIndex = 0;
        expect(
          def.regex.test(shouldNotMatch),
          `${label} should not match ${def.id}: ${shouldNotMatch}`,
        ).toBe(false);
      }
    });
  }
});

function vToString(v: Violation): string {
  return `  ${v.file}:${v.line}  [${v.patternId} → ${v.exampleEnvVar}]  matched=${v.matched}\n    ${v.excerpt}`;
}
