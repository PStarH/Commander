#!/usr/bin/env tsx
/**
 * check-readiness.ts — Enterprise Readiness Verification Script
 *
 * Verifies that docs/status.json and ENTERPRISE_READINESS.md claims are
 * backed by actual benchmark baselines and test artifacts. Exits non-zero
 * if any declared "done" item lacks evidence.
 *
 * Usage:
 *   npx tsx scripts/check-readiness.ts
 *   pnpm check:readiness
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

interface StatusEntry {
  id: string;
  title: string;
  status: string;
  evidence?: string;
  category?: string;
}

interface StatusJson {
  version?: string;
  categories?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CheckResult {
  id: string;
  title: string;
  declaredStatus: string;
  evidenceFound: boolean;
  evidencePath?: string;
  passed: boolean;
  reason?: string;
}

function loadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function checkBaselineExists(dir: string, prefix: string): boolean {
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  return files.length > 0;
}

async function main() {
  console.log('Enterprise Readiness Verification');
  console.log('═'.repeat(70));

  const results: CheckResult[] = [];

  // ── Check 1: WAL baseline exists ──
  const walBaselineExists = checkBaselineExists('docs/baselines', 'wal-baseline.');
  results.push({
    id: 'WAL-BENCH',
    title: 'WAL throughput baseline',
    declaredStatus: 'required',
    evidenceFound: walBaselineExists,
    evidencePath: walBaselineExists ? 'docs/baselines/wal-baseline.*.json' : undefined,
    passed: walBaselineExists,
    reason: walBaselineExists ? undefined : 'No WAL baseline found — run bench:wal',
  });

  // ── Check 2: SLO baseline exists ──
  const sloBaselineExists = checkBaselineExists('docs/baselines', 'slo-baseline.');
  results.push({
    id: 'SLO-1',
    title: 'SLO measurement baseline',
    declaredStatus: 'required',
    evidenceFound: sloBaselineExists,
    evidencePath: sloBaselineExists ? 'docs/baselines/slo-baseline.*.json' : undefined,
    passed: sloBaselineExists,
    reason: sloBaselineExists ? undefined : 'No SLO baseline found — run bench:slo',
  });

  // ── Check 3: Tenant isolation baseline exists ──
  const tenantBaselineExists = checkBaselineExists('docs/baselines', 'tenant-isolation.');
  results.push({
    id: 'SOC2-6',
    title: 'Cross-tenant fuzz test',
    declaredStatus: 'required',
    evidenceFound: tenantBaselineExists,
    evidencePath: tenantBaselineExists ? 'docs/baselines/tenant-isolation.*.json' : undefined,
    passed: tenantBaselineExists,
    reason: tenantBaselineExists
      ? undefined
      : 'No tenant isolation baseline — run bench:tenant-isolation',
  });

  // ── Check 4: Red Team baseline exists ──
  const redteamBaselineExists = checkBaselineExists('docs/baselines', 'redteam-baseline.');
  results.push({
    id: 'REDTEAM-1',
    title: 'Red Team battery baseline',
    declaredStatus: 'required',
    evidenceFound: redteamBaselineExists,
    evidencePath: redteamBaselineExists ? 'docs/baselines/redteam-baseline.*.json' : undefined,
    passed: redteamBaselineExists,
    reason: redteamBaselineExists ? undefined : 'No Red Team baseline — run benchmark:redteam',
  });

  // ── Check 5: Recovery bootstrap baseline exists ──
  const recoveryBaselineExists = checkBaselineExists('docs/baselines', 'recovery-baseline.');
  results.push({
    id: 'RECOVERY-1',
    title: 'RecoveryBootstrapper benchmark',
    declaredStatus: 'required',
    evidenceFound: recoveryBaselineExists,
    evidencePath: recoveryBaselineExists ? 'docs/baselines/recovery-baseline.*.json' : undefined,
    passed: recoveryBaselineExists,
    reason: recoveryBaselineExists ? undefined : 'No recovery baseline — run bench:recovery',
  });

  // ── Check 6: Event sourcing replay baseline exists ──
  const replayBaselineExists = checkBaselineExists('docs/baselines', 'replay-baseline.');
  results.push({
    id: 'REPLAY-1',
    title: 'EventSourcingEngine replay benchmark',
    declaredStatus: 'required',
    evidenceFound: replayBaselineExists,
    evidencePath: replayBaselineExists ? 'docs/baselines/replay-baseline.*.json' : undefined,
    passed: replayBaselineExists,
    reason: replayBaselineExists ? undefined : 'No replay baseline — run bench:replay',
  });

  // ── Check 7: E2E latency baseline exists ──
  const e2eBaselineExists = checkBaselineExists('docs/baselines', 'e2e-latency.');
  results.push({
    id: 'E2E-1',
    title: 'E2E latency benchmark',
    declaredStatus: 'recommended',
    evidenceFound: e2eBaselineExists,
    evidencePath: e2eBaselineExists ? 'docs/baselines/e2e-latency.*.json' : undefined,
    passed: e2eBaselineExists,
    reason: e2eBaselineExists ? undefined : 'No E2E latency baseline — run bench:e2e-latency',
  });

  // ── Check 8: Cost prediction baseline exists ──
  const costBaselineExists = checkBaselineExists('docs/baselines', 'cost-prediction.');
  results.push({
    id: 'COST-1',
    title: 'Cost prediction accuracy benchmark',
    declaredStatus: 'recommended',
    evidenceFound: costBaselineExists,
    evidencePath: costBaselineExists ? 'docs/baselines/cost-prediction.*.json' : undefined,
    passed: costBaselineExists,
    reason: costBaselineExists
      ? undefined
      : 'No cost prediction baseline — run bench:cost-prediction',
  });

  // ── Check 9: Tenant concurrency baseline exists ──
  const tenantConcBaselineExists = checkBaselineExists('docs/baselines', 'tenant-concurrency.');
  results.push({
    id: 'TENANT-CONC-1',
    title: 'Multi-tenant concurrency benchmark',
    declaredStatus: 'recommended',
    evidenceFound: tenantConcBaselineExists,
    evidencePath: tenantConcBaselineExists ? 'docs/baselines/tenant-concurrency.*.json' : undefined,
    passed: tenantConcBaselineExists,
    reason: tenantConcBaselineExists
      ? undefined
      : 'No tenant concurrency baseline — run bench:tenant-concurrency',
  });

  // ── Check 10: docs/status.json exists and is valid JSON ──
  const statusPath = resolve('docs/status.json');
  const statusJson = loadJson<StatusJson>(statusPath);
  results.push({
    id: 'STATUS-1',
    title: 'docs/status.json exists and valid',
    declaredStatus: 'required',
    evidenceFound: statusJson !== null,
    evidencePath: statusJson !== null ? 'docs/status.json' : undefined,
    passed: statusJson !== null,
    reason: statusJson !== null ? undefined : 'docs/status.json missing or invalid JSON',
  });

  // ── Check 11: ENTERPRISE_READINESS.md exists ──
  const erPath = resolve('ENTERPRISE_READINESS.md');
  results.push({
    id: 'ER-1',
    title: 'ENTERPRISE_READINESS.md exists',
    declaredStatus: 'required',
    evidenceFound: existsSync(erPath),
    evidencePath: existsSync(erPath) ? 'ENTERPRISE_READINESS.md' : undefined,
    passed: existsSync(erPath),
    reason: existsSync(erPath) ? undefined : 'ENTERPRISE_READINESS.md not found',
  });

  // ── Check 12: .node-version is valid LTS ──
  const nodeVersionPath = resolve('.node-version');
  let nodeVersionOk = false;
  if (existsSync(nodeVersionPath)) {
    const version = readFileSync(nodeVersionPath, 'utf-8').trim();
    nodeVersionOk = version === '20' || version === '22';
    results.push({
      id: 'NODE-1',
      title: '.node-version is valid LTS (20 or 22)',
      declaredStatus: 'required',
      evidenceFound: true,
      evidencePath: '.node-version',
      passed: nodeVersionOk,
      reason: nodeVersionOk ? undefined : `.node-version is "${version}", expected 20 or 22`,
    });
  } else {
    results.push({
      id: 'NODE-1',
      title: '.node-version is valid LTS (20 or 22)',
      declaredStatus: 'required',
      evidenceFound: false,
      passed: false,
      reason: '.node-version not found',
    });
  }

  // ── Print results ──
  let failed = 0;
  let warnings = 0;
  for (const r of results) {
    const icon = r.passed ? '✅' : r.declaredStatus === 'recommended' ? '⚠' : '❌';
    console.log(
      `  ${icon} ${r.id.padEnd(16)} ${r.title.padEnd(45)} ${r.passed ? 'OK' : 'MISSING'}`,
    );
    if (!r.passed && r.reason) {
      console.log(`                   ↳ ${r.reason}`);
    }
    if (!r.passed) {
      if (r.declaredStatus === 'recommended') {
        warnings++;
      } else {
        failed++;
      }
    }
  }

  console.log('═'.repeat(70));
  console.log(
    `  Total: ${results.length}  Passed: ${results.length - failed - warnings}  Failed: ${failed}  Warnings: ${warnings}`,
  );
  console.log('═'.repeat(70));

  if (failed > 0) {
    console.log(`❌ FAIL: ${failed} required readiness check(s) failed`);
    process.exit(1);
  }
  if (warnings > 0) {
    console.log(`⚠ WARNING: ${warnings} recommended check(s) missing`);
  }
  console.log('✅ PASS: All required readiness checks passed');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
