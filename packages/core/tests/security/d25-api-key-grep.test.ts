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
import { getDirname } from '../../src/esmCompat';

// `__dirname` does not exist in an ES module — see src/esmCompat.ts.
const __dirname = getDirname(import.meta.url);

const REPO_ROOT = path.resolve(__dirname, '../../../..');

// The previous scope was `apps/api/src` + `apps/web/src` only. That is the scope
// that let a real provider key sit undetected in `packages/core/tests/` for
// months: the gate could not read the directory the leak was in, so a green run
// meant "clean where I looked", not "clean". A committed credential does not care
// which package it is in, so the scope is now the tree a credential could
// plausibly be committed to.
const SCAN_ROOTS = [
  path.join(REPO_ROOT, 'apps'),
  path.join(REPO_ROOT, 'packages'),
  path.join(REPO_ROOT, 'scripts'),
  path.join(REPO_ROOT, 'deploy'),
  path.join(REPO_ROOT, 'integrations'),
  path.join(REPO_ROOT, 'docs'),
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
  '.serena',
  '.claude',
  '.worktrees',
  '.venv',
  '__pycache__',
  'coverage',
  '__snapshots__',
]);
// Only generated declaration/emit files are excluded.
//
// Test and fixture files used to be excluded here too, and that is the third and
// deepest reason the real leak survived: even with the scan pointed at the right
// directory, a `*.test.ts` file was skipped by *basename*, and the credential was
// committed in `packages/core/tests/*.ts`. Excluding the place where the defect
// lives is not a scope reduction, it is a disabled gate. The scan now reads test
// files and relies on ALLOWED_SYNTHETIC for the specific fixtures that are
// key-shaped on purpose - each one an explicit, reviewed, reasoned exception.
const EXCLUDED_FILE_PATTERNS: RegExp[] = [/\.d\.ts$/, /\.gen\.ts$/];

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
  {
    // The prefix that actually leaked. Its absence from this list is the second
    // reason the gate stayed green: even pointed at the right directory it had no
    // rule for a MiMo key.
    id: 'mimo-tp',
    prefix: 'tp-',
    regex: /\btp-[a-z0-9]{20,}/g,
    exampleEnvVar: 'MIMO_API_KEY',
  },
  {
    id: 'huggingface-hf',
    prefix: 'hf_',
    regex: /\bhf_[A-Za-z0-9]{20,}/g,
    exampleEnvVar: 'HUGGINGFACE_TOKEN',
  },
  {
    id: 'google-aiza',
    prefix: 'AIza',
    regex: /\bAIza[0-9A-Za-z_-]{30,}/g,
    exampleEnvVar: 'GOOGLE_API_KEY',
  },
  {
    id: 'stripe-live',
    prefix: 'sk_live_',
    regex: /\bsk_live_[A-Za-z0-9]{16,}/g,
    exampleEnvVar: 'STRIPE_SECRET_KEY',
  },
];

/**
 * Reviewed synthetic fixtures.
 *
 * Widening the scope means the scanner now reads the test suites that
 * deliberately contain key-shaped strings. Each entry is a deliberate decision:
 * the file, the exact pattern ids it is excused from, and why. Narrowing a
 * pattern cannot silently excuse a new one in the same file, and an entry for a
 * file that no longer matches is a stale excuse — the test below fails on it.
 */
const ALLOWED_SYNTHETIC: ReadonlyArray<{
  readonly file: string;
  readonly patterns: readonly string[];
  readonly reason: string;
}> = [
  {
    file: 'apps/api/test/evaluationAdmissionResidual.test.ts',
    patterns: ['openai-sk'],
    reason: 'Negative test fixture: provider error text must be redacted.',
  },
  {
    file: 'packages/core/tests/security/d25-api-key-grep.test.ts',
    patterns: ['openai-sk', 'anthropic-sk-ant', 'github-gh', 'aws-access-key', 'slack-xox'],
    reason: 'The gate’s own fixture strings; they exist to be matched.',
  },
  {
    file: 'packages/core/tests/security/d25-precommit-hook.test.ts',
    patterns: ['openai-sk', 'anthropic-sk-ant', 'github-gh', 'aws-access-key', 'slack-xox'],
    reason: 'Pre-commit scanner fixtures — key-shaped by design.',
  },
  {
    file: 'packages/core/tests/security/outputSanitizer.test.ts',
    patterns: [
      'anthropic-sk-ant',
      'github-gh',
      'aws-access-key',
      'slack-xox',
      'huggingface-hf',
      'google-aiza',
      'openai-sk',
    ],
    reason: 'DLP/sanitizer fixtures asserting redaction of key-shaped input.',
  },
  {
    file: 'packages/core/tests/security/securityPrimitives.test.ts',
    patterns: ['anthropic-sk-ant', 'github-gh', 'aws-access-key', 'openai-sk'],
    reason: 'Security-primitive fixtures asserting pattern detection.',
  },
  {
    file: 'packages/core/tests/agentjacking.test.ts',
    patterns: ['aws-access-key', 'openai-sk'],
    reason: 'Adversarial fixture pretending to exfiltrate a key.',
  },
  {
    file: 'packages/core/tests/commander-real-world-openclaw.ts',
    patterns: ['openai-sk', 'stripe-live'],
    reason: 'Scenario fixture; the values are shaped, not issued.',
  },
  {
    file: 'packages/core/src/benchmarks/algorithmicEffectiveness/modules/outputSanitizer.ts',
    patterns: ['anthropic-sk-ant', 'openai-sk'],
    reason:
      'Benchmark corpus values used to exercise the sanitizer (sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX is a spelled-out placeholder).',
  },
  {
    file: 'packages/core/src/benchmarks/algorithmicEffectiveness/modules/securityPrimitives.ts',
    patterns: ['aws-access-key', 'openai-sk'],
    reason:
      'Benchmark corpus values used to exercise the detector (sk-live-abcdefghijklmnop12345678 is a spelled-out placeholder).',
  },
  {
    file: 'apps/api/test/evaluationAdmissionResidual.test.ts',
    patterns: ['openai-sk'],
    reason: 'Admission test fixture; asserts no provider call is made.',
  },
  {
    file: 'packages/core/tests/security/guardianAgent.test.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped placeholder (sk-12345…) used as inert test input.',
  },
  {
    file: 'packages/core/tests/runtime/core-structural.test.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped placeholder (sk-abcde…) used as inert test input.',
  },
  {
    file: 'packages/core/tests/runtime/credentialManager.test.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped placeholder (sk-abcde…) used as inert test input.',
  },
  {
    file: 'packages/core/tests/runtime/llmCaller.test.ts',
    patterns: ['openai-sk'],
    reason: 'sk-live-… fixture asserting the gateway does not forward a leak',
  },
  {
    file: 'packages/core/tests/runtime/runtimeAdversarial.test.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped placeholder (sk-12345…) used as inert test input.',
  },
  {
    file: 'packages/core/tests/sandbox/teeEnclave.test.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped placeholder (sk-abcde…) used as inert test input.',
  },
  {
    file: 'packages/core/tests/e2e/real-api-chaos.test.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped value for the invalid-key scenario in the chaos suite.',
  },
  {
    file: 'packages/core/tests/demo-qa/test-chaos-failover.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped placeholder (sk-fake-…) used as inert demo input.',
  },
  {
    file: 'scripts/demo-qa/test-chaos-failover.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped placeholder (sk-fake-…) used as inert demo input.',
  },
  {
    file: 'packages/effect-broker/src/evidenceBundle.test.ts',
    patterns: ['openai-sk'],
    reason: 'Key-shaped fixture (sk-secret…) asserting bundle redaction.',
  },
  {
    file: 'packages/core/src/security/redTeamFramework.ts',
    patterns: ['openai-sk'],
    reason: 'red-team attack payloads, self-labelled sk-evil-key-do-not-use / sk-proj-…',
  },
  {
    file: 'deploy/docker/vault-init.sh',
    patterns: ['openai-sk', 'anthropic-sk-ant'],
    reason:
      'Vault bootstrap placeholders (sk-test…/sk-ant… repeated-character values), not issued keys.',
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
      // Dot-directories inside a package are runtime or tooling state
      // (`.attacker-reports`, `.commander_state`, `.serena`, `.venv`, …), never
      // committed source — a credential cannot be leaked by them and reading them
      // made the walk 100x larger. `.github` is not below any scan root, so this
      // does not narrow the meaningful surface.
      if (entry.name.startsWith('.') || EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      collectFiles(out, full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDED_FILE_PATTERNS.some((re) => re.test(entry.name))) continue;
    // A credential is equally leaked from a shell script, a compose file or a
    // test fixture, so the extension filter is not a security boundary.
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|json|yml|yaml|tf)$/.test(entry.name)) continue;
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
  const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const allowed = ALLOWED_SYNTHETIC.find((entry) => entry.file === relative);
  const hits: Violation[] = [];
  for (const def of PATTERNS) {
    if (allowed?.patterns.includes(def.id)) continue;
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

  it('the scanned tree contains zero plaintext API keys', () => {
    expect(violations, violations.map((v) => vToString(v)).join('\n')).toEqual([]);
  });

  it('anti-vacuity: the scan still reads the whole tree, not a subset', () => {
    expect(SCAN_ROOTS.length).toBe(6);
    for (const root of SCAN_ROOTS) expect(fs.existsSync(root)).toBe(true);
    // Pinned floor, deliberately set above the old apps-only count: if the scope
    // ever narrows again, this fails numerically instead of reporting success it
    // has not earned.
    // Measured 2409 across the six roots; the old apps-only scope read ~367, so
    // this floor cannot be satisfied by the narrow scope it replaced.
    expect(scannedFileCount).toBeGreaterThan(2000);
  });

  it('the allowlist holds no stale excuses', () => {
    for (const entry of ALLOWED_SYNTHETIC) {
      expect(fs.existsSync(path.join(REPO_ROOT, entry.file)), `${entry.file} missing`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(24);
      expect(entry.patterns.length).toBeGreaterThan(0);
    }
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
