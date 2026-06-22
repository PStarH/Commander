/**
 * scripts/precommitHook.ts — D3 hardening-sprint pre-commit security gate.
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
 *   3. Run vitest smoke on `tests/runtime/execPolicy.edge.test.ts` — verifies
 *      ExecPolicy engine still classifies pipes / $() / symlinks correctly.
 *   4. Exit 0 on clean, 1 on any violation.
 *
 * Why a thin wrapper over the real scanner (instead of inline regex)?
 *   - Single source of truth for malware signatures (SupplyChainScanner.MAL-*).
 *   - Same verifier passes locally in dev (NODE_ENV unset → dev fallback key)
 *     and in CI (NODE_ENV=test/prod via env-controlled test runs).
 *   - Singleton resolveMasterKey failure (D2 prod-mode) is caught and we
 *     fall back to inline regex so the hook never silently disables itself.
 *
 * Halt switch: COMMANDER_SKIP_PRECOMMIT=1 (handled in .githooks/pre-commit).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Configuration ────────────────────────────────────────────────────────

const REPO_ROOT = process.env.GIT_DIR ? path.dirname(path.dirname(process.env.GIT_DIR)) : process.cwd();
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
  // Git-side invocation: read staged + added files (added vs modified = same
  // security posture for our purposes).
  const out = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=AM'],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  );
  return { source: 'git', files: out.split('\n').map((s) => s.trim()).filter(Boolean) };
}

interface ScanLike {
  passed: boolean;
  severity: 'clean' | 'warning' | 'dangerous' | 'malicious';
  recommendation: 'allow' | 'allow_with_warnings' | 'quarantine' | 'block';
  warnings: Array<{ severity: string; category: string; message: string; evidence: string }>;
}

/**
 * Run SupplyChainScanner.scan() if we can load the module. Otherwise fall
 * back to an inline blocklist mirroring MAL-001 / MAL-005 / MAL-007 so
 * the hook still blocks catastrophic commits when the SDK is unavailable.
 */
async function scanContent(name: string, content: string): Promise<ScanLike> {
  try {
    const mod = await import(SCANNER_MODULE_PATH);
    const scanner = mod.getSupplyChainScanner();
    const r = scanner.scan({ name, content, tools: [] });
    return {
      passed: r.passed,
      severity: r.severity,
      recommendation: r.recommendation,
      warnings: r.warnings,
    };
  } catch (err) {
    // Singleton init can fail under D1 prod fail-fast (production NODE_ENV +
    // missing COMMANDER_AUDIT_CHAIN_KEY). Continue with the inline mirror.
    process.stderr.write(
      `[D3 hook] SupplyChainScanner unavailable (${(err as Error)?.message ?? err}); using inline blocklist.\n`,
    );
    return inlineBlocklistScan(name, content);
  }
}

function inlineBlocklistScan(name: string, content: string): ScanLike {
  // Mirror of MAL-001 / MAL-005 / MAL-007 / MAL-008 — keep in lock-step with
  // packages/core/src/security/supplyChainScanner.ts MALWARE_SIGNATURES.
  const PATTERNS: Array<{ id: string; regex: RegExp }> = [
    { id: 'MAL-001-reverse-shell', regex: /\/dev\/tcp\/.*\/.*|bash -i >& \/dev\/tcp/ },
    { id: 'MAL-005-data-destruction', regex: /rm\s+-rf\s+\/(?:\s|$)|;\s*:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
    { id: 'MAL-007-ssh-backdoor', regex: />>\s*~\/\.ssh\/authorized_keys|>>\s*\/root\/\.ssh\/authorized_keys/ },
    { id: 'MAL-008-persistence', regex: /@reboot|crontab\s+-\s+-[el]|\/etc\/cron\.(daily|hourly|weekly|monthly)/i },
  ];
  const warnings = PATTERNS
    .filter((p) => p.regex.test(content))
    .map((p) => ({
      severity: 'critical' as const,
      category: p.id,
      message: `blocklist hit: ${p.id}`,
      evidence: name,
    }));
  return {
    passed: warnings.length === 0,
    severity: warnings.length > 0 ? 'malicious' : 'clean',
    recommendation: warnings.length > 0 ? 'block' : 'allow',
    warnings,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function runScannerGate(): Promise<void> {
  const staged = getStagedFiles();
  const scannable = staged.files.filter((f) => SCANNABLE_EXT.test(f) && !f.includes('/.commander/'));

  if (scannable.length === 0) {
    console.log(`[D3 hook] No scannable staged files (out of ${staged.files.length} via ${staged.source}).`);
    return;
  }

  console.log(`[D3 hook] Scanning ${scannable.length} staged files via ${staged.source}…`);
  const violations: Array<{ file: string; reason: string; severity: string }> = [];

  for (const rel of scannable) {
    const full = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
    let content: string;
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) {
        console.warn(`[D3 hook] skipping ${rel} (size ${stat.size} > ${MAX_FILE_BYTES})`);
        continue;
      }
      content = fs.readFileSync(full, 'utf-8');
    } catch (err) {
      console.warn(`[D3 hook] cannot read ${rel}: ${(err as Error).message}`);
      continue;
    }
    const result = await scanContent(rel, content);
    if (!result.passed || result.recommendation === 'block') {
      for (const w of result.warnings) {
        // Only show critical/high hits so the output is actionable.
        if (w.severity === 'critical' || w.severity === 'high' || w.category.startsWith('malware.')) {
          violations.push({ file: rel, reason: `${w.category}: ${w.message}`, severity: w.severity });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error('\n❌ [D3 hook] SupplyChainScanner gate FAILED\n');
    for (const v of violations) {
      console.error(`  [${v.severity}] ${v.file}: ${v.reason}`);
    }
    console.error('\nFix or amend the staging; bypass with COMMANDER_SKIP_PRECOMMIT=1 (logged).\n');
    throw new Error('precommit scanner gate failed');
  }
  console.log('[D3 hook] scanner gate clean ✅');
}

function runExecPolicySmoke(): void {
  console.log('[D3 hook] running ExecPolicy edge tests smoke…');
  // npx handles local-binary discovery (.bin lookup) plus PATH search;
  // passing bare 'vitest' to node won't work (Node only resolves modules).
  // execFileSync propagates a real exit code so a non-zero from vitest lands
  // in our catch block.
  try {
    execFileSync(
      'npx',
      ['vitest', 'run', EXECPOLICY_TEST_FILE, '--no-cache', '--reporter=basic'],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'test' },
      },
    );
    console.log('[D3 hook] ExecPolicy smoke green ✅');
  } catch {
    throw new Error('precommit ExecPolicy smoke failed — see vitest output above');
  }
}

(async () => {
  try {
    await runScannerGate();
    runExecPolicySmoke();
    console.log('[D3 hook] all gates passed ✅');
    process.exit(0);
  } catch (err) {
    console.error(`[D3 hook] ${(err as Error).message}`);
    process.exit(1);
  }
})();
