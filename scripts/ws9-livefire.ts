#!/usr/bin/env tsx
/**
 * ws9-livefire.ts — WS9 live-fire suite orchestrator (spec §4, §9).
 *
 * Pipeline:
 *   1. Run `ws9-env-check.ts --json` (spec §3.2 readiness gate).
 *      → If any FAIL-severity check fails: write summary.verdict=FAIL,
 *        do NOT run the test suite, do NOT produce evidence.
 *   2. Run the WS9 vitest suite (6 test files under packages/core/tests/ws9/).
 *      → Vitest runs serially (pool:'threads', fileParallelism:false).
 *   3. Collect all evidence JSON artifacts from docs/baselines/ws9/*.json.
 *   4. Apply honesty rules (spec §9.2):
 *        - Any verdict=FAIL or verdict=BREACH → overall FAIL.
 *        - Any expected test case missing evidence → FAIL (incomplete run).
 *        - Any evidence with evidenceLevel != live filling a live slot → FAIL.
 *   5. Write docs/baselines/ws9/summary.json with per-case results + overall verdict.
 *
 * Exit codes:
 *   0  all tests passed, 0 breaches, all evidence present
 *   1  one or more tests failed or breaches detected
 *   2  infrastructure gate failed (env-check) — tests did not run
 *   3  orchestrator error (uncaught exception)
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

// ─── Constants ───────────────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, '..');
const WS9_DIR = join(REPO_ROOT, 'packages', 'core', 'tests', 'ws9');
const BASELINE_DIR = join(REPO_ROOT, 'docs', 'baselines', 'ws9');
const ENV_CHECK_SCRIPT = join(REPO_ROOT, 'scripts', 'ws9-env-check.ts');

/** All expected test case IDs (spec §4.1–4.5, §5.3, §6.5). */
const EXPECTED_CASES = [
  // §4.1 DATA
  'DATA-1', 'DATA-2', 'DATA-3', 'DATA-4', 'DATA-5', 'DATA-6',
  // §4.2 EXEC
  'EXEC-1', 'EXEC-2', 'EXEC-3', 'EXEC-4', 'EXEC-5',
  // §4.3 NET
  'NET-1', 'NET-2', 'NET-3',
  // §4.4 RATE
  'RATE-1', 'RATE-2', 'RATE-3',
  // §4.5 AUDIT
  'AUDIT-1', 'AUDIT-2', 'AUDIT-3', 'AUDIT-4', 'AUDIT-5',
  // §6.5 TAMPER
  'TAMPER-1', 'TAMPER-2', 'TAMPER-3', 'TAMPER-4', 'TAMPER-5',
  // §5.3 KEY
  'KEY-1', 'KEY-2', 'KEY-3', 'KEY-4', 'KEY-5',
] as const;

// ─── Types ───────────────────────────────────────────────────────────────

interface EvidenceArtifact {
  testCaseId: string;
  verdict: 'PASS' | 'FAIL' | 'SKIPPED' | 'BREACH';
  evidenceLevel: 'live' | 'ci-worm-sim' | 'simulated';
  breach: boolean;
  details: string;
  gitSha: string;
  ranAt: string;
  artifacts: string[];
}

interface EnvCheckResult {
  verdict: 'PASS' | 'FAIL';
  checks: Array<{
    check: string;
    passed: boolean;
    severity: 'FAIL' | 'WARN';
    detail: string;
  }>;
  scannedAt: string;
}

interface LiveFireSummary {
  verdict: 'PASS' | 'FAIL';
  reason: string;
  envCheck: EnvCheckResult | null;
  totalCases: number;
  passed: number;
  failed: number;
  breached: number;
  skipped: number;
  missing: string[];
  cases: EvidenceArtifact[];
  ranAt: string;
  gitSha: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function gitSha(): string {
  try {
    const res = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    return (res.stdout ?? '').trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function ensureBaselineDir(): void {
  if (!existsSync(BASELINE_DIR)) {
    mkdirSync(BASELINE_DIR, { recursive: true });
  }
}

/** Run ws9-env-check.ts --json and parse the result. */
function runEnvCheck(): EnvCheckResult {
  const res = spawnSync(
    'pnpm',
    ['exec', 'tsx', ENV_CHECK_SCRIPT, '--json'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  // env-check exits 0 on pass, 1 on fail, 2 on error.
  // stdout contains the JSON result regardless of exit code.
  const stdout = (res.stdout ?? '').trim();
  if (!stdout) {
    throw new Error(
      `ws9-env-check produced no output (exit=${res.status}, stderr=${(res.stderr ?? '').slice(0, 200)})`,
    );
  }

  // The JSON is the last block of stdout (after any stderr leakage).
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`ws9-env-check output is not JSON: ${stdout.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]) as EnvCheckResult;
}

/** Run the WS9 vitest suite. Returns true if all tests passed. */
function runVitestSuite(): boolean {
  const res = spawnSync(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      '--reporter=default',
      'tests/ws9/',
    ],
    {
      cwd: join(REPO_ROOT, 'packages', 'core'),
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 300_000, // 5 min ceiling; tests are serial.
    },
  );

  return res.status === 0;
}

/**
 * Remove prior per-case evidence JSON so this run cannot pick up stale PASS
 * artifacts. Keeps compliance-evidence/ subdirectory and summary.json.
 */
function clearCaseArtifacts(): void {
  if (!existsSync(BASELINE_DIR)) return;
  for (const file of readdirSync(BASELINE_DIR)) {
    if (!file.endsWith('.json')) continue;
    if (file === 'summary.json') continue;
    try {
      unlinkSync(join(BASELINE_DIR, file));
    } catch {
      // ignore
    }
  }
}

/** Collect all evidence JSON artifacts from docs/baselines/ws9/. */
function collectEvidence(): Map<string, EvidenceArtifact> {
  const artifacts = new Map<string, EvidenceArtifact>();

  if (!existsSync(BASELINE_DIR)) return artifacts;

  const files = readdirSync(BASELINE_DIR).filter(
    (f) => f.endsWith('.json') && f !== 'summary.json',
  );

  for (const file of files) {
    try {
      const raw = readFileSync(join(BASELINE_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw) as EvidenceArtifact;
      if (parsed.testCaseId) {
        artifacts.set(parsed.testCaseId, parsed);
      }
    } catch {
      // Skip malformed artifacts.
    }
  }

  return artifacts;
}

// ─── Main ───────────────────────────────────────────────────────────────

function main(): void {
  ensureBaselineDir();

  // Step 1: Environment readiness gate (spec §3.2).
  console.log('\nWS9 Live-Fire Suite Orchestrator');
  console.log('==================================');
  console.log('\nStep 1: Environment readiness gate (ws9-env-check)...');

  let envCheck: EnvCheckResult;
  try {
    envCheck = runEnvCheck();
  } catch (err) {
    const summary: LiveFireSummary = {
      verdict: 'FAIL',
      reason: `env-check orchestrator error: ${(err as Error).message}`,
      envCheck: null,
      totalCases: EXPECTED_CASES.length,
      passed: 0,
      failed: 0,
      breached: 0,
      skipped: 0,
      missing: [...EXPECTED_CASES],
      cases: [],
      ranAt: new Date().toISOString(),
      gitSha: gitSha(),
    };
    writeSummary(summary);
    console.error(`ERROR: ${summary.reason}`);
    process.exit(3);
  }

  const failedChecks = envCheck.checks.filter(
    (c) => c.severity === 'FAIL' && !c.passed,
  );

  if (failedChecks.length > 0) {
    console.log(`\n❌ Environment gate FAILED: ${failedChecks.length} required check(s) failed.`);
    for (const c of failedChecks) {
      console.log(`   • ${c.check}: ${c.detail}`);
    }

    const summary: LiveFireSummary = {
      verdict: 'FAIL',
      reason: `Environment gate failed: ${failedChecks.map((c) => c.check).join(', ')}. Tests did not run — no evidence produced.`,
      envCheck,
      totalCases: EXPECTED_CASES.length,
      passed: 0,
      failed: 0,
      breached: 0,
      skipped: EXPECTED_CASES.length,
      missing: [...EXPECTED_CASES],
      cases: [],
      ranAt: new Date().toISOString(),
      gitSha: gitSha(),
    };
    writeSummary(summary);
    console.log(`\nVerdict: FAIL (exit 2)`);
    process.exit(2);
  }

  console.log('✅ Environment gate passed. Proceeding to live-fire tests.');

  // Clear stale case artifacts before this run so honesty rules see only
  // evidence produced by the forthcoming vitest invocation.
  clearCaseArtifacts();

  // Step 2: Run the WS9 vitest suite.
  console.log('\nStep 2: Running WS9 live-fire test suite...');
  console.log('   (6 test files, serial execution)');
  console.log('');

  const vitestOk = runVitestSuite();
  if (!vitestOk) {
    const summary: LiveFireSummary = {
      verdict: 'FAIL',
      reason: 'Vitest suite exited non-zero — refusing to treat residual/partial evidence as live.',
      envCheck,
      totalCases: EXPECTED_CASES.length,
      passed: 0,
      failed: EXPECTED_CASES.length,
      breached: 0,
      skipped: 0,
      missing: [...EXPECTED_CASES],
      cases: [],
      ranAt: new Date().toISOString(),
      gitSha: gitSha(),
    };
    writeSummary(summary);
    console.error(`\nVerdict: FAIL (vitest non-zero; exit 1)`);
    process.exit(1);
  }

  // Step 3: Collect evidence artifacts.
  console.log('\nStep 3: Collecting evidence artifacts...');
  const artifacts = collectEvidence();

  // Step 4: Apply honesty rules (spec §9.2).
  const missing: string[] = [];
  const cases: EvidenceArtifact[] = [];
  let passCount = 0;
  let failCount = 0;
  let breachCount = 0;
  let skipCount = 0;

  for (const caseId of EXPECTED_CASES) {
    const artifact = artifacts.get(caseId);
    if (!artifact) {
      missing.push(caseId);
      skipCount++;
      continue;
    }
    cases.push(artifact);
    switch (artifact.verdict) {
      case 'PASS':
        passCount++;
        break;
      case 'FAIL':
        failCount++;
        break;
      case 'BREACH':
        breachCount++;
        failCount++;
        break;
      case 'SKIPPED':
        skipCount++;
        failCount++;
        break;
    }
  }

  // Honesty rules (spec §9.2):
  //   - errors > 0 → FAIL
  //   - skipped > 0 → FAIL
  //   - passed = false → FAIL
  //   - any breach → FAIL
  //   - PASS without evidenceLevel=live → FAIL (simulated cannot fill SOC slots)
  const hasBreaches = breachCount > 0;
  const hasSkipped = skipCount > 0;
  const hasMissing = missing.length > 0;
  const nonLivePasses = cases.filter(
    (c) => c.verdict === 'PASS' && c.evidenceLevel !== 'live',
  );
  const allPassed = passCount === EXPECTED_CASES.length && nonLivePasses.length === 0;

  const verdict: 'PASS' | 'FAIL' = allPassed && !hasBreaches && !hasSkipped && !hasMissing
    ? 'PASS'
    : 'FAIL';

  const reasons: string[] = [];
  if (hasBreaches) reasons.push(`${breachCount} breach(es) detected`);
  if (hasSkipped) reasons.push(`${skipCount} case(s) skipped or missing evidence`);
  if (hasMissing) reasons.push(`missing evidence for: ${missing.join(', ')}`);
  if (failCount > 0) reasons.push(`${failCount} case(s) failed`);
  if (nonLivePasses.length > 0) {
    reasons.push(
      `${nonLivePasses.length} PASS artifact(s) without evidenceLevel=live: ${nonLivePasses.map((c) => `${c.testCaseId}(${c.evidenceLevel})`).join(', ')}`,
    );
  }

  const summary: LiveFireSummary = {
    verdict,
    reason: verdict === 'PASS'
      ? `All ${EXPECTED_CASES.length} test cases passed with 0 breaches.`
      : `FAIL: ${reasons.join('; ')}.`,
    envCheck,
    totalCases: EXPECTED_CASES.length,
    passed: passCount,
    failed: failCount,
    breached: breachCount,
    skipped: skipCount,
    missing,
    cases,
    ranAt: new Date().toISOString(),
    gitSha: gitSha(),
  };

  // Step 5: Write summary.
  writeSummary(summary);

  console.log('\nStep 4: Honesty gate applied (spec §9.2).');
  console.log(`   Total: ${EXPECTED_CASES.length}`);
  console.log(`   Passed: ${passCount}`);
  console.log(`   Failed: ${failCount}`);
  console.log(`   Breached: ${breachCount}`);
  console.log(`   Skipped/Missing: ${skipCount}`);
  if (missing.length > 0) {
    console.log(`   Missing evidence: ${missing.join(', ')}`);
  }

  console.log(`\nVerdict: ${verdict}`);
  console.log(`Summary written to: ${join(BASELINE_DIR, 'summary.json')}`);

  process.exit(verdict === 'PASS' ? 0 : 1);
}

function writeSummary(summary: LiveFireSummary): void {
  ensureBaselineDir();
  const summaryPath = join(BASELINE_DIR, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), { mode: 0o644 });
}

main();
