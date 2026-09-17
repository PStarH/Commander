#!/usr/bin/env tsx
/**
 * check-readiness.ts — strict readiness gate for all baselines.
 *
 * Historical problem: this script only checked that baseline files existed.
 * That allowed baselines with `passed=false`, `errors=104`, or `verdict=FAIL`
 * to be counted as ready. Now every baseline is parsed and its content is
 * validated with the strict baseline schema validator.
 *
 * Second problem (fixed here): every slot was declared `recommended`, so the
 * "required items all pass" predicate was vacuously true and `process.exit(1)`
 * was unreachable — the gate could never fail. A slot is only `required` when
 * an approved release profile names it. With no profile, or with a profile that
 * names no slot, strict mode reports NOT_EVALUATED and exits non-zero: the
 * absence of required evidence is not a pass.
 *
 * Exit codes (strict, the default):
 *   0  every required slot passed with live, candidate-bound evidence
 *   1  a required slot failed, or no required slot was evaluated
 * Exit codes (--non-strict): always 0, output labelled DIAGNOSTIC_ONLY.
 *   Non-strict mode never prints a readiness pass.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  validateBaseline,
  type BaselineDocument,
  type EvidenceLevel,
} from '../packages/core/src/benchmarks/baselineSchema';

export interface CheckResult {
  id: string;
  title: string;
  declaredStatus: 'required' | 'recommended';
  evidenceFound: boolean;
  evidencePath?: string;
  passed: boolean;
  reason?: string;
}

export type ReadinessStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

export interface ReadinessProfile {
  schema: 'commander-readiness-profile/v1';
  required: string[];
}

export interface ReadinessEvaluation {
  status: ReadinessStatus;
  requiredCount: number;
  requiredPassed: number;
  reasons: string[];
  results: CheckResult[];
}

export const STRICT = !process.argv.includes('--non-strict');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PROFILE_PATH = resolve(SCRIPT_DIR, 'readiness-profile.json');

/**
 * The full set of baseline slots this gate knows how to evaluate. Which of them
 * are *required* is a product decision and comes from the approved profile —
 * it is never inferred from this list.
 */
export const READINESS_SLOTS: ReadonlyArray<{
  prefix: string;
  declaredStatus: 'required' | 'recommended';
}> = [
  // Live-only path: simulated fixtures in docs/baselines/* are non-scoring and
  // must not fill these slots. Without an approved profile they are diagnostic
  // only; that is deliberately not the same thing as readiness.
  { prefix: 'tenant-isolation.', declaredStatus: 'recommended' },
  { prefix: 'tenant-concurrency.', declaredStatus: 'recommended' },
  { prefix: 'slo-baseline.', declaredStatus: 'recommended' },
  { prefix: 'failover-rto-live.', declaredStatus: 'recommended' },
  { prefix: 'wal-baseline.', declaredStatus: 'recommended' },
  { prefix: 'recovery-baseline.', declaredStatus: 'recommended' },
  { prefix: 'replay-baseline.', declaredStatus: 'recommended' },
  { prefix: 'e2e-latency.', declaredStatus: 'recommended' },
  { prefix: 'cost-prediction.', declaredStatus: 'recommended' },
  { prefix: 'redteam-baseline.', declaredStatus: 'recommended' },
  { prefix: 'bench-v2-live.', declaredStatus: 'recommended' },
  { prefix: 'benchmark-', declaredStatus: 'recommended' },
];

function runQuiet(args: string[]): string | undefined {
  try {
    const result = spawnSync(args[0]!, args.slice(1), {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0 || !result.stdout) return undefined;
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

export function getCurrentBaseline(): {
  gitSha: string;
  nodeVersion: string;
  pnpmVersion?: string;
  imageDigest?: string;
} {
  const gitSha = runQuiet(['git', 'rev-parse', 'HEAD']) ?? 'unknown';
  const nodeVersion = process.version;

  let pnpmVersion: string | undefined;
  try {
    pnpmVersion = runQuiet(['pnpm', '--version']);
  } catch {
    // pnpm may not be available in some execution environments.
  }

  const image = process.env.COMMANDER_IMAGE ?? 'commander:latest';
  const imageDigest = runQuiet(['docker', 'inspect', '--format={{index .RepoDigests 0}}', image]);

  return { gitSha, nodeVersion, pnpmVersion, imageDigest };
}

function loadJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function evidenceOf(doc: BaselineDocument): EvidenceLevel | undefined {
  if (doc.schemaVersion === 2 && doc.env?.evidence) return doc.env.evidence;
  return doc.evidenceLevel;
}

/**
 * Load the approved release profile. A missing, unreadable, malformed, or
 * unknown-slot profile is treated as "no approved profile" — never as an empty
 * required set that would let the gate report a pass.
 */
export function loadReadinessProfile(profilePath: string = PROFILE_PATH): {
  profile?: ReadinessProfile;
  reason?: string;
} {
  if (!existsSync(profilePath)) {
    return { reason: `no approved readiness profile at ${profilePath}` };
  }
  const raw = loadJson<Record<string, unknown>>(profilePath);
  if (!raw) return { reason: `readiness profile at ${profilePath} is not valid JSON` };
  if (raw.schema !== 'commander-readiness-profile/v1') {
    return { reason: `readiness profile schema is not commander-readiness-profile/v1` };
  }
  const allowed = new Set(['schema', 'required']);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return { reason: `readiness profile has unknown keys: ${unknown.join(', ')}` };
  }
  if (!Array.isArray(raw.required) || raw.required.length === 0) {
    return { reason: 'readiness profile declares no required slots' };
  }
  const known = new Set(READINESS_SLOTS.map((slot) => slot.prefix));
  const unknownSlots = raw.required.filter(
    (entry): entry is string => typeof entry === 'string' && !known.has(entry),
  );
  if (unknownSlots.length > 0 || raw.required.some((entry) => typeof entry !== 'string')) {
    return { reason: `readiness profile names unknown slots: ${unknownSlots.join(', ')}` };
  }
  const required = raw.required as string[];
  if (new Set(required).size !== required.length) {
    return { reason: 'readiness profile lists duplicate required slots' };
  }
  return { profile: { schema: 'commander-readiness-profile/v1', required } };
}

export function checkBaselineFile(
  dir: string,
  prefix: string,
  declaredStatus: 'required' | 'recommended',
  current: ReturnType<typeof getCurrentBaseline>,
): CheckResult {
  const id = prefix.toUpperCase().replace(/\.$/, '');
  const resolvedDir = resolve(dir);

  if (!existsSync(resolvedDir)) {
    return {
      id,
      title: `${prefix} baseline`,
      declaredStatus,
      evidenceFound: false,
      passed: false,
      reason: `directory ${dir} missing`,
    };
  }

  // Prefer filename order (newest date first). Git checkout mtimes are equal
  // and can otherwise surface stale 07-06 fixtures ahead of current 07-13 ones.
  const allFiles = readdirSync(resolvedDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => resolve(resolvedDir, f))
    .sort((a, b) => basename(b).localeCompare(basename(a)));

  // Source/synthetic evidence files are not counted as regular baselines.
  const regularFiles = allFiles.filter((f) => !f.endsWith('.source.json'));
  const sourceFiles = allFiles.filter((f) => f.endsWith('.source.json'));

  if (regularFiles.length === 0 && sourceFiles.length === 0) {
    return {
      id,
      title: `${prefix} baseline`,
      declaredStatus,
      evidenceFound: false,
      passed: false,
      reason: `no ${prefix}*.json baseline`,
    };
  }

  if (regularFiles.length === 0) {
    const latest = sourceFiles[0]!;
    if (declaredStatus === 'recommended') {
      return {
        id,
        title: `${prefix} source evidence`,
        declaredStatus: 'recommended',
        evidenceFound: true,
        evidencePath: latest,
        passed: false,
        reason: 'source/synthetic evidence does not count toward strict readiness',
      };
    }
    return {
      id,
      title: `${prefix} source evidence`,
      declaredStatus: 'required',
      evidenceFound: true,
      evidencePath: latest,
      passed: false,
      reason: 'source/synthetic evidence is not accepted for required baselines',
    };
  }

  const latest = regularFiles[0]!;

  const doc = loadJson<BaselineDocument>(latest);
  if (!doc) {
    return {
      id,
      title: `${prefix} baseline`,
      declaredStatus,
      evidenceFound: true,
      evidencePath: latest,
      passed: false,
      reason: 'invalid JSON',
    };
  }

  const validation = validateBaseline(doc, current);
  const evidence = evidenceOf(doc);

  // Simulated/synthetic fixtures are non-scoring: they must never satisfy
  // required readiness (residual→100 / merge-blocking). Recommended slots may
  // surface them as warnings only.
  if (
    validation.ok &&
    (evidence === 'simulated' || evidence === 'synthetic') &&
    declaredStatus === 'required'
  ) {
    return {
      id,
      title: `${prefix} baseline`,
      declaredStatus,
      evidenceFound: true,
      evidencePath: latest,
      passed: false,
      reason: `${evidence} evidence does not count toward required readiness`,
    };
  }

  if (
    validation.ok &&
    (evidence === 'simulated' || evidence === 'synthetic') &&
    declaredStatus === 'recommended'
  ) {
    return {
      id,
      title: `${prefix} baseline`,
      declaredStatus,
      evidenceFound: true,
      evidencePath: latest,
      passed: false,
      reason: `${evidence} evidence is non-scoring (diagnostic only)`,
    };
  }

  return {
    id,
    title: `${prefix} baseline`,
    declaredStatus,
    evidenceFound: true,
    evidencePath: latest,
    passed: validation.ok,
    reason: validation.ok ? undefined : validation.reasons.join('; '),
  };
}

/**
 * Pure readiness decision. Never infers a required set: with no approved
 * profile there is nothing to evaluate, and "nothing to evaluate" is
 * NOT_EVALUATED — not a pass.
 */
export function evaluateReadiness(
  results: CheckResult[],
  profile: ReadinessProfile | undefined,
  profileReason?: string,
): ReadinessEvaluation {
  const required = results.filter((r) => r.declaredStatus === 'required');
  const reasons: string[] = [];

  if (!profile) {
    reasons.push(profileReason ?? 'no approved readiness profile');
  }
  if (required.length === 0) {
    reasons.push('no required readiness slot was evaluated');
  }
  for (const r of required) {
    if (!r.passed) reasons.push(`required slot ${r.id} not satisfied: ${r.reason ?? 'unknown'}`);
  }

  const requiredPassed = required.filter((r) => r.passed).length;
  const status: ReadinessStatus =
    required.length === 0 ? 'NOT_EVALUATED' : requiredPassed === required.length ? 'PASS' : 'FAIL';

  return { status, requiredCount: required.length, requiredPassed, reasons, results };
}

export function main(strict: boolean = STRICT): CheckResult[] {
  const current = getCurrentBaseline();
  console.log(`Strict mode: ${strict} (use --non-strict for diagnostics only)`);

  const { profile, reason: profileReason } = loadReadinessProfile();
  if (profile) {
    console.log(`Profile: ${profile.required.length} required slot(s)`);
  } else {
    console.log(`Profile: none — ${profileReason}`);
  }

  const requiredPrefixes = new Set(profile?.required ?? []);
  const results: CheckResult[] = [];
  for (const { prefix, declaredStatus } of READINESS_SLOTS) {
    results.push(
      checkBaselineFile(
        'docs/baselines',
        prefix,
        requiredPrefixes.has(prefix) ? 'required' : declaredStatus,
        current,
      ),
    );
  }

  for (const r of results) {
    const icon = r.passed ? '✅' : r.declaredStatus === 'recommended' ? '⚠️' : '❌';
    const pathInfo = r.evidencePath ? ` (${r.evidencePath})` : '';
    const reasonInfo = r.reason ? `: ${r.reason}` : '';
    console.log(`${icon} ${r.title}${pathInfo}${reasonInfo}`);
  }

  const evaluation = evaluateReadiness(results, profile, profileReason);
  console.log(`Required slots passed: ${evaluation.requiredPassed}/${evaluation.requiredCount}`);
  for (const reason of evaluation.reasons) {
    console.log(`  - ${reason}`);
  }

  if (!strict) {
    console.log('DIAGNOSTIC_ONLY — non-strict mode makes no readiness claim');
    process.exit(0);
  } else if (evaluation.status === 'PASS') {
    console.log('✅ READINESS PASS');
    process.exit(0);
  } else if (evaluation.status === 'NOT_EVALUATED') {
    console.log(
      '⛔ READINESS NOT_EVALUATED — no required evidence was evaluated; this is not a pass',
    );
    process.exit(1);
  } else {
    console.log('❌ READINESS FAIL');
    process.exit(1);
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(STRICT);
}
