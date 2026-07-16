#!/usr/bin/env tsx
/**
 * ws9-compliance-evidence.ts — WS9 §7 SOC 2 Type II control point evidence pack generator.
 *
 * Collects live test results from `docs/baselines/ws9/*.json` and derives
 * SOC 2 control point evidence JSONs in `docs/baselines/ws9/compliance-evidence/`.
 *
 * Per spec `spec/ws9-tenant-livefire-compliance.md` §7:
 *   - One JSON per control point (9 total) + a `_header.json` disclaimer.
 *   - verdict = PASS only when every required test case ID has a PASS verdict
 *     in some baseline AND every artifact baseline passes overall
 *     (`verdict=PASS` / `summary.passed=true`, `errors=0`, `skipped=0`).
 *   - verdict = FAIL if any test case is FAIL or missing, or any artifact
 *     baseline is missing or fails. `verdict=FAIL` control points must not be
 *     labelled compliant (spec §7 honesty rule).
 *   - verdict = PENDING (evidenceLevel=pending) when no baselines exist yet
 *     (Phase 2 build stage) — the script still emits template evidence JSONs.
 *
 * Exit codes:
 *   0  no control point FAILed (all PASS, or all PENDING in build stage)
 *   1  one or more control points FAIL
 *   2  error (uncaught exception)
 *
 * Run: tsx scripts/ws9-compliance-evidence.ts [--json]
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

// ─── Types ─────────────────────────────────────────────────────────────

interface TestCaseResult {
  id: string;
  verdict: string;
}

interface BaselineDoc {
  // WS9 baseline format
  verdict?: string;
  passed?: boolean;
  errors?: number;
  skipped?: number;
  failed?: number;
  evidenceLevel?: string;
  testCases?: TestCaseResult[];
  cases?: TestCaseResult[];
  results?: TestCaseResult[];
  // Standard baseline schema (baselineSchema.ts)
  summary?: {
    passed?: boolean;
    errors?: number;
    failed?: number;
    skipped?: number;
    reason?: string;
  };
  [key: string]: unknown;
}

interface ControlPoint {
  controlId: string;
  controlName: string;
  slug: string;
  soc2Criteria: string[];
  testCaseIds: string[];
  artifactStems: string[];
}

interface ControlPointEvidence {
  controlId: string;
  controlName: string;
  soc2Criteria: string[];
  evidenceLevel: 'live' | 'pending';
  testCaseIds: string[];
  verdict: 'PASS' | 'FAIL' | 'PENDING';
  artifactPaths: string[];
  collectedAt: string;
  verifiedBy: string;
  gitSha: string;
}

interface EvidenceHeader {
  disclaimer: string;
  generatedAt: string;
  generatedBy: string;
  controlPointCount: number;
}

interface ControlPointEvaluation {
  controlId: string;
  controlName: string;
  slug: string;
  verdict: 'PASS' | 'FAIL' | 'PENDING';
  evidenceLevel: 'live' | 'pending';
  testCaseIds: string[];
  artifactPaths: string[];
  missingTestCases: string[];
  failedTestCases: string[];
  missingArtifacts: string[];
  failedArtifacts: string[];
  evidencePath: string;
}

interface Summary {
  verdict: 'PASS' | 'FAIL' | 'PENDING';
  controlPointCount: number;
  passCount: number;
  failCount: number;
  pendingCount: number;
  controlPoints: ControlPointEvaluation[];
  generatedAt: string;
  gitSha: string;
  outputDir: string;
  headerPath: string;
}

// ─── Constants ─────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(__dirname, '..');
const WS9_BASELINE_DIR = join(PROJECT_ROOT, 'docs', 'baselines', 'ws9');
const EVIDENCE_DIR = join(WS9_BASELINE_DIR, 'compliance-evidence');
const EVIDENCE_DIR_REL = 'docs/baselines/ws9/compliance-evidence';
const VERIFIED_BY = 'ws9-livefire';
const HEADER_DISCLAIMER =
  'This package contains control point evidence, not a SOC 2 Type II report. A report requires an external auditor with ≥3 months observation period.';

// Wildcard expansions (per spec §4.3 NET-1..3, §5.3 KEY-1..5, §6.5 TAMPER-1..5).
const KEY_IDS = ['KEY-1', 'KEY-2', 'KEY-3', 'KEY-4', 'KEY-5'];
const TAMPER_IDS = ['TAMPER-1', 'TAMPER-2', 'TAMPER-3', 'TAMPER-4', 'TAMPER-5'];
const NET_IDS = ['NET-1', 'NET-2', 'NET-3'];

// ─── Control points (per spec §7 table) ────────────────────────────────
//
// Each control point maps SOC 2 CC criteria to the test case IDs that prove
// it and the baseline files (stems) that carry the live evidence. Stems
// resolve to `docs/baselines/ws9/<stem>.json`.
const CONTROL_POINTS: ControlPoint[] = [
  {
    controlId: 'CC6.1',
    controlName: 'Access Control',
    slug: 'access-control',
    soc2Criteria: ['CC6.1', 'CC6.6'],
    testCaseIds: ['DATA-2', 'EXEC-4', ...KEY_IDS],
    artifactStems: ['data-isolation', 'exec-isolation', 'key-injection'],
  },
  {
    controlId: 'CC8.1',
    controlName: 'Change Management',
    slug: 'change-management',
    soc2Criteria: ['CC8.1'],
    testCaseIds: ['EXEC-3'],
    artifactStems: ['exec-isolation', 'keypath-scan'],
  },
  {
    controlId: 'CC6.7',
    controlName: 'Logical Access',
    slug: 'logical-access',
    soc2Criteria: ['CC6.7'],
    testCaseIds: ['DATA-1', 'DATA-3', 'DATA-4'],
    artifactStems: ['data-isolation', 'env-check'],
  },
  {
    controlId: 'CC7.3',
    controlName: 'Incident Response',
    slug: 'incident-response',
    soc2Criteria: ['CC7.3', 'CC7.4'],
    testCaseIds: [...TAMPER_IDS, 'AUDIT-4', 'EXEC-5'],
    artifactStems: ['audit-isolation', 'exec-isolation'],
  },
  {
    controlId: 'CC7.2',
    controlName: 'Audit Log Integrity',
    slug: 'audit-log-integrity',
    soc2Criteria: ['CC7.2'],
    testCaseIds: [...TAMPER_IDS],
    artifactStems: ['audit-isolation'],
  },
  {
    controlId: 'CC5.2',
    controlName: 'Data Retention & Deletion',
    slug: 'data-retention-deletion',
    soc2Criteria: ['CC5.2', 'CC7.1'],
    testCaseIds: ['DATA-5'],
    artifactStems: ['data-isolation', 'dr-backup-restore'],
  },
  {
    controlId: 'CC6.1',
    controlName: 'Key Management',
    slug: 'key-management',
    soc2Criteria: ['CC6.1'],
    testCaseIds: [...KEY_IDS],
    artifactStems: ['key-injection', 'keypath-scan'],
  },
  {
    controlId: 'CC6.6',
    controlName: 'Network Isolation',
    slug: 'network-isolation',
    soc2Criteria: ['CC6.6'],
    testCaseIds: [...NET_IDS],
    artifactStems: ['net-isolation'],
  },
  {
    controlId: 'CC7.1',
    controlName: 'Configuration Management',
    slug: 'configuration-management',
    soc2Criteria: ['CC7.1', 'CC8.1'],
    // No explicit test case IDs; the env-check baseline (§3.2 non-owner role
    // CI gate) is the artifact that proves this control point.
    testCaseIds: [],
    artifactStems: ['env-check'],
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────

function getGitSha(): string {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: PROJECT_ROOT,
    });
    if (result.error || result.status !== 0 || !result.stdout) return 'unknown';
    return result.stdout.trim();
  } catch {
    return 'unknown';
  }
}

function loadBaseline(filePath: string): BaselineDoc | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as BaselineDoc;
  } catch {
    return undefined;
  }
}

/** Extract per-test-case results from any of the common array fields. */
function extractTestCaseResults(doc: BaselineDoc): TestCaseResult[] {
  return doc.testCases ?? doc.cases ?? doc.results ?? [];
}

/** Find a test case result by ID across all loaded baselines. */
function findTestCaseResult(
  tcId: string,
  baselines: Map<string, { doc: BaselineDoc; path: string }>,
): TestCaseResult | undefined {
  for (const { doc } of baselines.values()) {
    const cases = extractTestCaseResults(doc);
    for (const tc of cases) {
      if (tc && typeof tc.id === 'string' && tc.id === tcId) return tc;
    }
  }
  return undefined;
}

/**
 * Determine whether a baseline passes its overall verdict.
 * Handles both the WS9 format (`verdict`/`passed`/`errors`/`skipped`) and the
 * standard baseline schema (`summary.passed`/`summary.errors`/...).
 * Per spec §9.2: errors>0, skipped>0, passed=false, or verdict!=PASS → FAIL.
 */
function baselineVerdictPass(doc: BaselineDoc): boolean {
  const passed = doc.summary?.passed ?? doc.passed;
  if (passed === false) return false;

  if (doc.verdict && doc.verdict !== 'PASS') return false;

  const errors = doc.summary?.errors ?? doc.errors ?? 0;
  const skipped = doc.summary?.skipped ?? doc.skipped ?? 0;
  const failed = doc.summary?.failed ?? doc.failed ?? 0;
  if (errors > 0) return false;
  if (skipped > 0) return false;
  if (failed > 0) return false;

  // No explicit failure → pass (PASS verdict, passed=true, or no verdict field).
  return true;
}

// ─── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');

  const gitSha = getGitSha();
  const collectedAt = new Date().toISOString();

  // Read all baseline JSONs from docs/baselines/ws9/*.json. Subdirectories
  // (like compliance-evidence/) are not traversed — only top-level files.
  const baselines = new Map<string, { doc: BaselineDoc; path: string }>();
  if (existsSync(WS9_BASELINE_DIR)) {
    let entries: string[];
    try {
      entries = readdirSync(WS9_BASELINE_DIR);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const stem = entry.replace(/\.json$/, '');
      const filePath = join(WS9_BASELINE_DIR, entry);
      const doc = loadBaseline(filePath);
      if (doc) {
        baselines.set(stem, { doc, path: filePath });
      }
    }
  }

  const anyBaselineExists = baselines.size > 0;

  // Ensure evidence output directory exists (creates parents as needed).
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // Evaluate each control point and write its evidence JSON.
  const evaluations: ControlPointEvaluation[] = [];
  for (const cp of CONTROL_POINTS) {
    const missingTestCases: string[] = [];
    const failedTestCases: string[] = [];
    const missingArtifacts: string[] = [];
    const failedArtifacts: string[] = [];
    const artifactPaths: string[] = [];

    let verdict: 'PASS' | 'FAIL' | 'PENDING';
    let evidenceLevel: 'live' | 'pending';

    if (!anyBaselineExists) {
      // Phase 2 build stage: no baselines yet → emit PENDING template.
      verdict = 'PENDING';
      evidenceLevel = 'pending';
    } else {
      // Check each required test case ID has a PASS verdict in some baseline.
      for (const tcId of cp.testCaseIds) {
        const result = findTestCaseResult(tcId, baselines);
        if (!result) {
          missingTestCases.push(tcId);
        } else if (result.verdict !== 'PASS') {
          failedTestCases.push(tcId);
        }
      }

      // Check each artifact baseline exists and passes overall.
      for (const stem of cp.artifactStems) {
        const relPath = `docs/baselines/ws9/${stem}.json`;
        const baseline = baselines.get(stem);
        if (!baseline) {
          missingArtifacts.push(stem);
        } else {
          artifactPaths.push(relPath);
          if (!baselineVerdictPass(baseline.doc)) {
            failedArtifacts.push(stem);
          }
        }
      }

      const testCasesPass =
        missingTestCases.length === 0 && failedTestCases.length === 0;
      const artifactsPass =
        missingArtifacts.length === 0 && failedArtifacts.length === 0;

      // Control points with explicit test case IDs require both arms to pass.
      // Control points without test case IDs (e.g. Configuration Management)
      // rely on their artifact baselines' overall verdicts.
      const pass =
        cp.testCaseIds.length > 0
          ? testCasesPass && artifactsPass
          : artifactsPass;

      verdict = pass ? 'PASS' : 'FAIL';
      evidenceLevel = 'live';
    }

    const evidence: ControlPointEvidence = {
      controlId: cp.controlId,
      controlName: cp.controlName,
      soc2Criteria: cp.soc2Criteria,
      evidenceLevel,
      testCaseIds: cp.testCaseIds,
      verdict,
      artifactPaths,
      collectedAt,
      verifiedBy: VERIFIED_BY,
      gitSha,
    };

    const evidenceFilePath = join(EVIDENCE_DIR, `${cp.slug}.json`);
    writeFileSync(evidenceFilePath, JSON.stringify(evidence, null, 2) + '\n');

    evaluations.push({
      controlId: cp.controlId,
      controlName: cp.controlName,
      slug: cp.slug,
      verdict,
      evidenceLevel,
      testCaseIds: cp.testCaseIds,
      artifactPaths,
      missingTestCases,
      failedTestCases,
      missingArtifacts,
      failedArtifacts,
      evidencePath: `${EVIDENCE_DIR_REL}/${cp.slug}.json`,
    });
  }

  // Write header file with the honesty disclaimer.
  const header: EvidenceHeader = {
    disclaimer: HEADER_DISCLAIMER,
    generatedAt: collectedAt,
    generatedBy: 'ws9-compliance-evidence',
    controlPointCount: CONTROL_POINTS.length,
  };
  const headerFilePath = join(EVIDENCE_DIR, '_header.json');
  writeFileSync(headerFilePath, JSON.stringify(header, null, 2) + '\n');
  const headerRelPath = `${EVIDENCE_DIR_REL}/_header.json`;

  // Build summary.
  const passCount = evaluations.filter((e) => e.verdict === 'PASS').length;
  const failCount = evaluations.filter((e) => e.verdict === 'FAIL').length;
  const pendingCount = evaluations.filter((e) => e.verdict === 'PENDING').length;

  let summaryVerdict: 'PASS' | 'FAIL' | 'PENDING';
  if (failCount > 0) {
    summaryVerdict = 'FAIL';
  } else if (pendingCount === evaluations.length) {
    summaryVerdict = 'PENDING';
  } else {
    summaryVerdict = 'PASS';
  }

  const summary: Summary = {
    verdict: summaryVerdict,
    controlPointCount: CONTROL_POINTS.length,
    passCount,
    failCount,
    pendingCount,
    controlPoints: evaluations,
    generatedAt: collectedAt,
    gitSha,
    outputDir: EVIDENCE_DIR_REL,
    headerPath: headerRelPath,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`\nWS9 §7 SOC 2 Control Point Evidence Pack`);
    console.log(`========================================`);
    console.log(`Generated at: ${collectedAt}`);
    console.log(`Git SHA:     ${gitSha}`);
    console.log(`Baselines:   ${baselines.size} file(s) in docs/baselines/ws9/`);
    console.log(`Output:      ${EVIDENCE_DIR_REL}/`);
    console.log('');
    for (const e of evaluations) {
      const icon =
        e.verdict === 'PASS' ? '✅' : e.verdict === 'FAIL' ? '❌' : '⏳';
      console.log(
        `${icon} [${e.verdict}] ${e.controlName} (${e.controlId}) — ${e.evidencePath}`,
      );
      const details: string[] = [];
      if (e.missingTestCases.length > 0)
        details.push(`missing test cases: ${e.missingTestCases.join(', ')}`);
      if (e.failedTestCases.length > 0)
        details.push(`failed test cases: ${e.failedTestCases.join(', ')}`);
      if (e.missingArtifacts.length > 0)
        details.push(
          `missing artifacts: ${e.missingArtifacts.map((s) => s + '.json').join(', ')}`,
        );
      if (e.failedArtifacts.length > 0)
        details.push(
          `failed artifacts: ${e.failedArtifacts.map((s) => s + '.json').join(', ')}`,
        );
      if (details.length > 0) {
        console.log(`    ${details.join('; ')}`);
      }
    }
    console.log('');
    console.log(
      `Pass: ${passCount}  Fail: ${failCount}  Pending: ${pendingCount}  Total: ${CONTROL_POINTS.length}`,
    );
    console.log(`Header: ${headerRelPath}`);
    console.log(`Verdict: ${summaryVerdict}`);
  }

  // Exit codes: 0 if no FAIL (all PASS or all PENDING), 1 if any FAIL, 2 on error.
  if (failCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
