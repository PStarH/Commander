/**
 * scripts/precommitHook.ts — D3 + D2.5 hardening-sprint pre-commit security gate.
 *
 * Behaviour:
 *   1. Read the list of staged files (.git/hooks/pre-commit sets CORE_PRECOMMIT_HOOK=1
 *      and delegates here). When invoked from CI without git, staged files come
 *      from `process.argv.slice(2)` so the same logic can replay in pipeline.
 *   2. For each scannable extension (.ts/.tsx/.js/.mjs/.cjs/.json/.sh):
 *        - Read bytes (capped at 500 KB to avoid bloating on generated files).
 *        - Run `SupplyChainScanner.scan({name, content, tools: []})`.
 *        - If `recommendation === 'block'` OR `severity === 'malicious'/'dangerous'`
 *          AND recommendation is `quarantine`, fail with a clear summary.
 *   3. D2.5 audit #6 closeout — plaintext API-key grep (Day 7+4 wire-up):
 *      same regex set as `tests/security/d25-api-key-grep.test.ts`, so the
 *      pre-commit gate mirrors the CI gate step-for-step. Catches sk-/ghp_/
 *      AKIA/xox* prefixes in staged files BEFORE GitHub CI ever sees them,
 *      shrinking the catastrophic-slip window to <1s of operator time.
 *   4. Run vitest smoke on `tests/runtime/execPolicy.edge.test.ts` — verifies
 *      ExecPolicy engine still classifies pipes / $() / symlinks correctly.
 *   5. Exit 0 on clean, 1 on any violation.
 *
 * Why a thin wrapper over the real scanner (instead of inline regex)?
 *   - Single source of truth for malware signatures (SupplyChainScanner.MAL-*).
 *   - D2.5 plaintext detector mirrors `tests/security/d25-api-key-grep.test.ts`
 *     exactly — same regex set, same hard-coded prefix list, same fallback
 *     comment-line guard. If the CI gate rejects a prefix, the pre-commit
 *     gate rejects it too; if CI accepts, pre-commit accepts.
 *   - Scanner-loading failures are blocking so the hook never silently
 *     disables itself.
 */

import { reportSilentFailure } from '../packages/core/src/silentFailureReporter';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  enumerateHighWarnings,
  evaluateIndexedWarnings,
  readGitBlob,
  readIndexedContent,
  type ScannerWarning,
} from './precommitScannerPolicy.js';

// ── Configuration ────────────────────────────────────────────────────────

// Resolve the actual working tree root via `git rev-parse --show-toplevel`.
// This works in both the main checkout and linked worktrees — the previous
// GIT_DIR-based derivation resolved to .git/ under worktrees (where
// GIT_DIR points at .git/worktrees/<name>), causing vitestCwd/.ts file
// reads to ENOENT against .git/packages/... Fall back to cwd() only if
// git is unavailable (e.g. CI argv replay with no git context).
function resolveRepoRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return process.cwd();
  }
}

const REPO_ROOT = resolveRepoRoot();
const SCANNABLE_EXT = /\.(ts|tsx|js|mjs|cjs|json|sh)$/i;
const MAX_FILE_BYTES = 500 * 1024;
const EXECPOLICY_TEST_FILE = 'tests/runtime/execPolicy.edge.test.ts';
const SCANNER_MODULE_PATH = path.join(
  REPO_ROOT,
  'packages/core/src/security/supplyChainScanner.ts',
);

// ── Helpers ──────────────────────────────────────────────────────────────

function getStagedFiles(): { source: 'git' | 'argv'; files: string[] } {
  // CI replay: caller passes files via argv.
  if (process.env.CORE_PRECOMMIT_HOOK === '1' && process.env.GIT_DIR === undefined) {
    return { source: 'argv', files: process.argv.slice(2).filter(Boolean) };
  }
  // Git-side invocation: read every staged path that can introduce content.
  // A rename or copy has no same-path HEAD baseline, so it must be scanned.
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=AMRC'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return {
    source: 'git',
    files: out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

interface ScanLike {
  passed: boolean;
  severity: 'clean' | 'warning' | 'dangerous' | 'malicious';
  recommendation: 'allow' | 'allow_with_warnings' | 'quarantine' | 'block';
  warnings: Array<{ severity: string; category: string; message: string; evidence: string }>;
}

function readContent(relativePath: string, source: 'git' | 'argv'): string {
  if (source === 'git') {
    return readIndexedContent(REPO_ROOT, relativePath);
  }
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * Run SupplyChainScanner.scan(). If the module cannot be loaded, fail closed:
 * a pre-commit malware gate must not silently pass while its scanner is down.
 */
async function scanContent(name: string, content: string): Promise<ScanLike> {
  try {
    const mod = await import(SCANNER_MODULE_PATH);
    // Pre-commit needs a synchronous detection decision only. Audit/SBOM work
    // belongs to the normal scanner pipeline and can otherwise keep commits
    // alive after a clean decision.
    const scanner = new mod.SupplyChainScanner({ auditAllScans: false });
    const r = scanner.scan({
      name,
      content,
      tools: [],
    });
    const blocked = r.warnings.some(
      (w) =>
        w.severity === 'critical' || w.severity === 'high' || w.category.startsWith('malware.'),
    );
    return {
      passed: !blocked,
      severity: blocked ? r.severity : 'clean',
      recommendation: blocked ? 'block' : 'allow',
      warnings: r.warnings,
    };
  } catch (err) {
    process.stderr.write(
      '[D3 hook] SupplyChainScanner unavailable (' +
        ((err as Error)?.message ?? err) +
        '); blocking (fail-closed).\n',
    );
    return {
      passed: false,
      severity: 'malicious',
      recommendation: 'block',
      warnings: [
        {
          severity: 'critical',
          category: 'scanner-unavailable',
          message: 'SupplyChainScanner failed to load; commit blocked (fail-closed)',
          evidence: name,
        },
      ],
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function runScannerGate(): Promise<void> {
  const staged = getStagedFiles();
  const scannable = staged.files.filter((f) => SCANNABLE_EXT.test(f));

  if (scannable.length === 0) {
    console.log(
      `[D3 hook] No scannable staged files (out of ${staged.files.length} via ${staged.source}).`,
    );
    return;
  }

  console.log(`[D3 hook] Scanning ${scannable.length} staged files via ${staged.source}…`);
  const violations: Array<{ file: string; reason: string; severity: string }> = [];

  for (const rel of scannable) {
    let content: string;
    try {
      content = readContent(rel, staged.source);
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error('D3_INDEX_BLOB_TOO_LARGE:' + rel);
      }
    } catch (err) {
      violations.push({
        file: rel,
        reason: 'index_blob_unavailable: ' + (err as Error).message,
        severity: 'critical',
      });
      continue;
    }
    const stagedResult = await scanContent(rel, content);
    const headContent = staged.source === 'git' ? readGitBlob(REPO_ROOT, 'HEAD', rel) : undefined;
    const headResult = headContent === undefined ? undefined : await scanContent(rel, headContent);
    const stagedWarnings = [
      ...stagedResult.warnings.filter(
        (warning) => warning.severity !== 'high' || warning.category.startsWith('malware.'),
      ),
      ...(await enumerateHighWarnings(
        content,
        async (candidate) => (await scanContent(rel, candidate)).warnings as ScannerWarning[],
      )),
    ] as ScannerWarning[];
    const headWarnings =
      headContent === undefined || headResult === undefined
        ? []
        : [
            ...headResult.warnings.filter(
              (warning) => warning.severity !== 'high' || warning.category.startsWith('malware.'),
            ),
            ...(await enumerateHighWarnings(
              headContent,
              async (candidate) => (await scanContent(rel, candidate)).warnings as ScannerWarning[],
            )),
          ];
    const policy = evaluateIndexedWarnings(stagedWarnings, headWarnings as ScannerWarning[]);
    for (const warning of policy.inherited) {
      console.log(
        '[D3 hook] inherited high warning ' +
          warning.fingerprint +
          ' ' +
          warning.category +
          ' (' +
          rel +
          ')',
      );
    }
    for (const violation of policy.violations) {
      violations.push({
        file: rel,
        reason: violation.reason + ':' + violation.fingerprint + ':' + violation.category,
        severity: violation.severity,
      });
    }
  }

  if (violations.length > 0) {
    console.error('\n❌ [D3 hook] SupplyChainScanner gate FAILED\n');
    for (const v of violations) {
      console.error(`  [${v.severity}] ${v.file}: ${v.reason}`);
    }
    console.error('\nFix or amend the staging before committing.\n');
    throw new Error('precommit scanner gate failed');
  }
  console.log('[D3 hook] scanner gate clean ✅');
}

// ============================================================================
// D2.5 hardening — plaintext API-key regex set (mirrors the d25 vitest gate).
// Audit #6 closeout: fast pre-commit gate matching the CI gate step-for-step.
// ============================================================================

interface D25PatternDef {
  readonly id: string;
  readonly prefix: string;
  readonly regex: RegExp;
  readonly exampleEnvVar: string;
}

const D25_PATTERNS: readonly D25PatternDef[] = [
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

interface D25Violation {
  file: string;
  line: number;
  matched: string;
  patternId: string;
  exampleEnvVar: string;
}

function scanFileForPlaintextKeys(rel: string, content: string): D25Violation[] {
  const hits: D25Violation[] = [];
  for (const def of D25_PATTERNS) {
    def.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = def.regex.exec(content)) !== null) {
      const before = content.slice(0, m.index);
      const lineNumber = before.split('\n').length;
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineEnd = content.indexOf('\n', m.index + m[0].length);
      const lineContent = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
      const trimmed = lineContent.trim().toLowerCase();
      // Skip intentional test-data lines that mark themselves as fixtures.
      if (
        trimmed.includes('// fake') ||
        trimmed.includes('// example') ||
        trimmed.includes('// mock') ||
        (trimmed.startsWith('// ') === false && trimmed.includes('fixture:'))
      ) {
        continue;
      }
      hits.push({
        file: rel,
        line: lineNumber,
        matched: m[0].slice(0, 32) + (m[0].length > 32 ? '…' : ''),
        patternId: def.id,
        exampleEnvVar: def.exampleEnvVar,
      });
    }
  }
  return hits;
}

function runD25PlaintextGate(scannableFiles: string[], source: 'git' | 'argv'): void {
  if (scannableFiles.length === 0) {
    console.log('[D2.5 hook] no staged files to scan');
    return;
  }
  const violations: D25Violation[] = [];
  for (const rel of scannableFiles) {
    let content: string;
    try {
      content = readContent(rel, source);
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error('D25_INDEX_BLOB_TOO_LARGE:' + rel);
      }
    } catch (err) {
      throw new Error('precommit d2.5 source unavailable for ' + rel + ': ' + (err as Error).message);
    }
    violations.push(...scanFileForPlaintextKeys(rel, content));
  }
  if (violations.length > 0) {
    console.error('\n❌ [D2.5 hook] plaintext API-key gate FAILED (d25 parity)\n');
    for (const v of violations) {
      console.error(
        `  [${v.patternId} → ${v.exampleEnvVar}] ${v.file}:${v.line}  matched=${v.matched}`,
      );
    }
    console.error(
      '\nFix or amend the staging; replace with `process.env.<env-var>`. ' +
        'Commit only after removing the plaintext value.\n',
    );
    throw new Error('precommit d2.5 plaintext gate failed');
  }
  console.log(`[D2.5 hook] plaintext scan clean (${scannableFiles.length} files) ✅`);
}

function runExecPolicySmoke(): void {
  console.log('[D3 hook] running ExecPolicy edge tests smoke…');
  // vitest config lives in packages/core; running from repo root fails
  // because vitest cannot find vitest.config.ts there.  Use
  // packages/core as cwd so vitest resolves its config and the test
  // file path is relative to the package root.
  const vitestCwd = path.join(REPO_ROOT, 'packages', 'core');
  try {
    execFileSync(
      'pnpm',
      ['exec', 'vitest', 'run', EXECPOLICY_TEST_FILE, '--no-cache', '--reporter=default'],
      {
        cwd: vitestCwd,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'test' },
      },
    );
    console.log('[D3 hook] ExecPolicy smoke green ✅');
  } catch (err) {
    reportSilentFailure(err, 'precommitHook:335');
    throw new Error('precommit ExecPolicy smoke failed — see vitest output above');
  }
}

(async () => {
  try {
    await runScannerGate();
    // Audit #6 closeout — d25 plaintext-API-key gate runs BETWEEN the
    // SupplyChain scanner and the vitest smoke. Mirrors the d25 vitest
    // gate regex-by-regex so a slip is caught at commit time, not at CI.
    const staged = getStagedFiles();
    const stagedForScan = staged.files.filter((f) => SCANNABLE_EXT.test(f));
    runD25PlaintextGate(stagedForScan, staged.source);
    runExecPolicySmoke();
    console.log('[D3+hook] all gates passed ✅');
    process.exit(0);
  } catch (err) {
    console.error(`[D3+hook] ${(err as Error).message}`);
    process.exit(1);
  }
})();
