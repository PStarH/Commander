#!/usr/bin/env tsx
/**
 * ws9-livefire.ts — WS9 live-fire suite orchestrator (spec §4, §9) and the
 * evidence-binding primitives it shares with the WS9 test files (LM-16).
 *
 * Evidence binding (LM-16 / audit WS9-02). The previous design recycled the
 * shared `docs/baselines/ws9` directory as a scratch space: it deleted stale
 * top-level JSON before each run (`clearCaseArtifacts`) and then read whatever
 * was left, without ever checking that the artifacts belonged to this
 * execution or to the candidate commit. The primitives below replace that:
 *
 *   - `beginRun(runRoot)` requires an empty, owned directory and mints a random
 *     runId. The orchestrator passes the directory to every producer through
 *     `WS9_OUTPUT_ROOT`, so two concurrent runs can never overwrite each other.
 *   - `writeCaseArtifact` records runId, candidate gitSha, caseId, start/end,
 *     the environment fingerprint and hash-bound child artifacts, using a
 *     temp-file + rename so a reader never observes a half-written artifact.
 *   - `finalizeRun` seals the manifest (per-case content hashes + seal) and
 *     clears the incomplete marker; an interrupted run keeps
 *     `manifest.incomplete.json` and is marked `failed`, so it can never be
 *     consumed as a previous summary.
 *   - `verifyRun` fails closed on unknown/stale SHA, a different run, duplicate
 *     cases, extra unlisted artifacts, missing/corrupt files, absolute paths,
 *     `..` and symlink escapes, and on any manifest edited after sealing.
 *
 * The fixed `EXPECTED_CASES` list is copied into every manifest at `beginRun`,
 * and a PASS is still only credited to `evidenceLevel=live` artifacts.
 *
 * Publication of evidence into `docs/baselines/ws9` is an explicit operation
 * (`--publish`), never a side effect of running the suite.
 *
 * Pipeline (`main`):
 *   1. Run `ws9-env-check.ts --json` (spec §3.2 readiness gate).
 *      → If any FAIL-severity check fails: write summary.verdict=FAIL,
 *        do NOT run the test suite, do NOT produce evidence.
 *   2. Create this execution's empty run directory (random runId), export it as
 *      `WS9_OUTPUT_ROOT` and run the WS9 vitest suite (6 files, serial).
 *   3. `verifyRun` the run directory: only artifacts bound to this run and this
 *      candidate SHA and passing schema/child-hash/containment checks count.
 *   4. Apply honesty rules (spec §9.2):
 *        - Any verdict=FAIL/BREACH → overall FAIL.
 *        - Any expected case missing → FAIL (incomplete run).
 *        - Any PASS without evidenceLevel=live → FAIL.
 *   5. Write docs/baselines/ws9/summary.json (the summary is a report, not
 *      evidence; `--publish` is what copies a verified run into the baseline).
 *
 * Exit codes:
 *   0  all tests passed, 0 breaches, all evidence present
 *   1  one or more tests failed or breaches detected
 *   2  infrastructure gate failed (env-check) — tests did not run
 *   3  orchestrator error (uncaught exception)
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Constants ───────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = join(REPO_ROOT, 'docs', 'baselines', 'ws9');
const ENV_CHECK_SCRIPT = join(REPO_ROOT, 'scripts', 'ws9-env-check.ts');
const DEFAULT_RUNS_DIR = join(REPO_ROOT, '.commander_state', 'ws9-runs');

/** Env var through which the orchestrator hands producers their owned run dir. */
export const RUN_ROOT_ENV = 'WS9_OUTPUT_ROOT';
/** Sealed run manifest. Only a sealed, complete manifest may be consumed. */
export const MANIFEST_FILE = 'manifest.json';
/** Present from `beginRun` until `finalizeRun(..., 'complete')` removes it. */
export const INCOMPLETE_MARKER = 'manifest.incomplete.json';

const SCHEMA_VERSION = 1;
const SHA_RE = /^[0-9a-f]{40}$/;

/** All expected test case IDs (spec §4.1–4.5, §5.3, §6.5). */
export const EXPECTED_CASES: readonly string[] = [
  // §4.1 DATA
  'DATA-1',
  'DATA-2',
  'DATA-3',
  'DATA-4',
  'DATA-5',
  'DATA-6',
  // §4.2 EXEC
  'EXEC-1',
  'EXEC-2',
  'EXEC-3',
  'EXEC-4',
  'EXEC-5',
  // §4.3 NET
  'NET-1',
  'NET-2',
  'NET-3',
  // §4.4 RATE
  'RATE-1',
  'RATE-2',
  'RATE-3',
  // §4.5 AUDIT
  'AUDIT-1',
  'AUDIT-2',
  'AUDIT-3',
  'AUDIT-4',
  'AUDIT-5',
  // §6.5 TAMPER
  'TAMPER-1',
  'TAMPER-2',
  'TAMPER-3',
  'TAMPER-4',
  'TAMPER-5',
  // §5.3 KEY
  'KEY-1',
  'KEY-2',
  'KEY-3',
  'KEY-4',
  'KEY-5',
];

const EXPECTED_CASE_SET = new Set(EXPECTED_CASES);
const VERDICT_VALUES: readonly string[] = ['PASS', 'FAIL', 'SKIPPED', 'BREACH'];
const EVIDENCE_LEVEL_VALUES: readonly string[] = ['live', 'ci-worm-sim', 'simulated'];

// ─── Types ───────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'SKIPPED' | 'BREACH';
export type EvidenceLevel = 'live' | 'ci-worm-sim' | 'simulated';
export type RunStatus = 'running' | 'complete' | 'failed';

/**
 * A child artifact produced by a case (bench output, scan dump, …).
 * `path` is run-root relative with POSIX separators; an artifact that cannot be
 * expressed relative to the run root is recorded with `external: true` and an
 * absolute real path, which consumers refuse (it escapes the run).
 */
export interface ChildArtifact {
  path: string;
  sha256: string;
  external?: boolean;
}

/** A single case's evidence artifact, written as `<runRoot>/<caseId>.json`. */
export interface EvidenceArtifact {
  testCaseId: string;
  runId: string;
  verdict: Verdict;
  evidenceLevel: EvidenceLevel;
  breach: boolean;
  details: string;
  gitSha: string;
  startedAt: string;
  endedAt: string;
  environment: string;
  artifacts: ChildArtifact[];
}

/** The per-execution manifest: `docs/baselines/ws9` is never a scratch space. */
export interface RunManifest {
  schemaVersion: number;
  runId: string;
  gitSha: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  environment: string;
  /** The fixed WS9 case list, copied in at `beginRun` for tamper detection. */
  expectedCases: string[];
  /** Cases this run has written (unique; overwriting a case updates in place). */
  cases: string[];
  /** Sealed content hash per listed case, filled in by `finalizeRun`. */
  caseHashes?: Record<string, string>;
  reason?: string;
  /** Hash over everything above; any post-finalize edit breaks it. */
  seal?: string;
}

export interface CaseArtifactInput {
  testCaseId: string;
  verdict: Verdict;
  evidenceLevel: EvidenceLevel;
  breach: boolean;
  details: string;
  artifacts?: ChildArtifact[];
  startedAt?: string;
  endedAt?: string;
}

export interface VerifyOptions {
  /** The candidate commit SHA this run must have been produced from. */
  expectedGitSha: string;
  /** When given, the run must belong to exactly this runId. */
  expectedRunId?: string;
}

export interface VerifyResult {
  ok: boolean;
  rejections: string[];
  cases: EvidenceArtifact[];
  missing: string[];
  runId: string | null;
  status: RunStatus | null;
  gitSha: string | null;
  runRoot: string;
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
  runId: string | null;
  runRoot: string | null;
  envCheck: EnvCheckResult | null;
  totalCases: number;
  passed: number;
  failed: number;
  breached: number;
  skipped: number;
  missing: string[];
  rejections: string[];
  cases: EvidenceArtifact[];
  ranAt: string;
  gitSha: string;
}

// ─── Primitives: hashing, atomic writes, git, environment ────────────────

/** SHA-256 of the candidate commit, or `'unknown'` when git cannot answer. */
export function resolveGitSha(cwd: string = REPO_ROOT): string {
  try {
    const res = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    });
    const sha = (res.stdout ?? '').trim();
    return SHA_RE.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** SHA-256 of a file's bytes. */
export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Write JSON via a temp file + rename so no reader sees a partial artifact. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o644 });
  renameSync(tmp, filePath);
}

/** Key-sorted JSON so the seal does not depend on property insertion order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function computeSeal(manifest: RunManifest): string {
  const content: Record<string, unknown> = { ...manifest };
  delete content.seal;
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

/**
 * Environment fingerprint: where the evidence was produced from. This makes no
 * claim about the backend — `evidenceLevel` carries the live/simulated claim.
 */
export function describeEnvironment(): string {
  return [
    `host=${hostname()}`,
    `platform=${process.platform}/${process.arch}`,
    `node=${process.version}`,
    `cwd=${process.cwd()}`,
  ].join(' ');
}

function readManifestOrThrow(runRoot: string): RunManifest {
  const manifestPath = join(runRoot, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`run manifest not found: ${manifestPath} (beginRun must run first)`);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as RunManifest;
}

/** A fresh, still-empty absolute directory path for one execution. */
export function createRunRoot(
  baseDir: string = process.env.WS9_RUNS_DIR?.trim() || DEFAULT_RUNS_DIR,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(baseDir, `run-${stamp}-${randomBytes(6).toString('hex')}`);
}

// ─── Primitives: producer side ───────────────────────────────────────────

/**
 * Begin one owned execution: the run root must be empty (or absent), gets a
 * random runId, and is marked incomplete until `finalizeRun` seals it.
 *
 * Fail-closed: reusing a non-empty directory throws instead of merging two
 * executions' evidence, which is exactly how stale artifacts leaked into the
 * old shared `docs/baselines/ws9` flow.
 */
export function beginRun(runRoot: string): RunManifest {
  if (!isAbsolute(runRoot)) {
    throw new Error(`run root must be an absolute path, got "${runRoot}"`);
  }
  if (existsSync(runRoot)) {
    if (!statSync(runRoot).isDirectory()) {
      throw new Error(`run root exists and is not a directory: ${runRoot}`);
    }
    const entries = readdirSync(runRoot);
    if (entries.length > 0) {
      throw new Error(`run root is not empty (refusing to overwrite an existing run): ${runRoot}`);
    }
  } else {
    mkdirSync(runRoot, { recursive: true });
  }

  const manifest: RunManifest = {
    schemaVersion: SCHEMA_VERSION,
    runId: `ws9-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(8).toString('hex')}`,
    gitSha: resolveGitSha(),
    status: 'running',
    startedAt: new Date().toISOString(),
    environment: describeEnvironment(),
    expectedCases: [...EXPECTED_CASES],
    cases: [],
  };
  writeJsonAtomic(join(runRoot, MANIFEST_FILE), manifest);
  writeJsonAtomic(join(runRoot, INCOMPLETE_MARKER), {
    runId: manifest.runId,
    status: 'running',
    startedAt: manifest.startedAt,
    reason: 'incomplete: beginRun ran but finalizeRun never sealed this run',
  });
  return manifest;
}

/**
 * Write one case's evidence artifact into this run and list it in the manifest.
 * Writing the same case twice (a case can legitimately emit PASS *or* BREACH)
 * replaces the file in place and keeps a single manifest entry.
 */
export function writeCaseArtifact(runRoot: string, input: CaseArtifactInput): EvidenceArtifact {
  const manifest = readManifestOrThrow(runRoot);
  if (manifest.status !== 'running') {
    throw new Error(
      `run ${manifest.runId} is not running (status=${manifest.status}); refusing to write case ${input.testCaseId}`,
    );
  }
  if (!EXPECTED_CASE_SET.has(input.testCaseId)) {
    throw new Error(
      `unknown WS9 case id "${input.testCaseId}"; the expected case list is fixed by EXPECTED_CASES`,
    );
  }
  const artifact: EvidenceArtifact = {
    testCaseId: input.testCaseId,
    runId: manifest.runId,
    verdict: input.verdict,
    evidenceLevel: input.evidenceLevel,
    breach: input.breach,
    details: input.details,
    gitSha: manifest.gitSha,
    // The writer runs after the case; without an explicit start it is bound to
    // the run start rather than inventing a timestamp.
    startedAt: input.startedAt ?? manifest.startedAt,
    endedAt: input.endedAt ?? new Date().toISOString(),
    environment: manifest.environment,
    artifacts: input.artifacts ?? [],
  };
  writeJsonAtomic(join(runRoot, `${input.testCaseId}.json`), artifact);
  if (!manifest.cases.includes(input.testCaseId)) manifest.cases.push(input.testCaseId);
  writeJsonAtomic(join(runRoot, MANIFEST_FILE), manifest);
  return artifact;
}

/**
 * Seal the run. `'complete'` clears the incomplete marker; `'failed'` keeps it
 * and records the reason, so a killed run can never be consumed as a summary.
 */
export function finalizeRun(
  runRoot: string,
  status: 'complete' | 'failed',
  reason?: string,
): RunManifest {
  const manifest = readManifestOrThrow(runRoot);
  if (manifest.status !== 'running') {
    throw new Error(`run ${manifest.runId} was already finalized (status=${manifest.status})`);
  }
  const sealed: RunManifest = {
    ...manifest,
    status,
    endedAt: new Date().toISOString(),
    reason,
    caseHashes: Object.fromEntries(
      manifest.cases
        .map((caseId) => {
          const casePath = join(runRoot, `${caseId}.json`);
          return existsSync(casePath) ? [caseId, sha256File(casePath)] : null;
        })
        .filter((entry): entry is [string, string] => entry !== null),
    ),
  };
  sealed.seal = computeSeal(sealed);
  writeJsonAtomic(join(runRoot, MANIFEST_FILE), sealed);

  const markerPath = join(runRoot, INCOMPLETE_MARKER);
  if (status === 'complete') {
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } else {
    writeJsonAtomic(markerPath, {
      runId: manifest.runId,
      status: 'failed',
      endedAt: sealed.endedAt,
      reason: reason ?? 'unspecified',
    });
  }
  return sealed;
}

/**
 * Mark a live run as failed (used when a producer cannot write its evidence).
 * The incomplete marker stays, so the run remains unconsumable.
 */
export function markRunFailed(runRoot: string, reason: string): void {
  const manifest = readManifestOrThrow(runRoot);
  if (manifest.status === 'complete') {
    throw new Error(`run ${manifest.runId} is already sealed complete; refusing to mark it failed`);
  }
  const failed: RunManifest = {
    ...manifest,
    status: 'failed',
    endedAt: new Date().toISOString(),
    reason,
  };
  failed.seal = computeSeal(failed);
  writeJsonAtomic(join(runRoot, MANIFEST_FILE), failed);
  writeJsonAtomic(join(runRoot, INCOMPLETE_MARKER), {
    runId: manifest.runId,
    status: 'failed',
    endedAt: failed.endedAt,
    reason,
  });
}

/**
 * Hash-bind a child artifact produced by a case.
 *
 * A path inside the run root is stored run-root relative (POSIX separators);
 * anything that really resolves outside the root is stored as an absolute
 * `external` reference so consumers can see and refuse the escape.
 */
export function describeChildArtifact(artifactPath: string, runRoot: string): ChildArtifact {
  const abs = resolve(artifactPath);
  if (!existsSync(abs)) throw new Error(`child artifact does not exist: ${abs}`);
  const sha256 = sha256File(abs);
  const realRoot = realpathSync(runRoot);
  const realTarget = realpathSync(abs);
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realTarget !== realRoot && !realTarget.startsWith(prefix)) {
    return { path: realTarget, sha256, external: true };
  }
  return { path: relative(realRoot, realTarget).split(sep).join('/'), sha256 };
}

// ─── Primitives: consumer side ───────────────────────────────────────────

/**
 * Verify a run directory. Fails closed (and never fills a slot) on an unknown
 * or stale SHA, a different run, an incomplete/failed/unsealed run, a manifest
 * edited after sealing, duplicate cases, extra unlisted artifacts, missing or
 * corrupt files, schema violations, and absolute/`..`/symlink-escaping child
 * paths.
 */
export function verifyRun(runRoot: string, options: VerifyOptions): VerifyResult {
  const rejections: string[] = [];
  const accepted: EvidenceArtifact[] = [];
  const empty = (reason: string): VerifyResult => ({
    ok: false,
    rejections: [reason],
    cases: [],
    missing: [...EXPECTED_CASES],
    runId: null,
    status: null,
    gitSha: null,
    runRoot,
  });

  const manifestPath = join(runRoot, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return empty(`run manifest missing: ${manifestPath}`);
  }
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as RunManifest;
  } catch (err) {
    return empty(`run manifest is not valid JSON: ${(err as Error).message}`);
  }

  // ── Run-level binding ──────────────────────────────────────────────────
  const shaIsValid = SHA_RE.test(manifest.gitSha ?? '');
  const shaMismatch = !shaIsValid || manifest.gitSha !== options.expectedGitSha;
  if (shaMismatch) {
    rejections.push(
      `run ${manifest.runId} declares unknown/stale SHA "${manifest.gitSha}" — the candidate SHA is ${options.expectedGitSha}`,
    );
  }
  const runIdMismatch =
    options.expectedRunId !== undefined && manifest.runId !== options.expectedRunId;
  if (runIdMismatch) {
    rejections.push(
      `run manifest runId "${manifest.runId}" does not match expected ${options.expectedRunId}`,
    );
  }
  const incomplete = existsSync(join(runRoot, INCOMPLETE_MARKER));
  if (incomplete) {
    rejections.push(
      `run ${manifest.runId} is incomplete (${INCOMPLETE_MARKER} present): finalizeRun never sealed it`,
    );
  }
  const statusIncomplete = manifest.status !== 'complete';
  if (statusIncomplete) {
    rejections.push(
      `run ${manifest.runId} status is "${manifest.status}"${manifest.reason ? ` — ${manifest.reason}` : ''}; only a "complete" run may be consumed`,
    );
  }
  // A broken seal means the manifest was edited after sealing, so the run is
  // not consumable (ok=false). It is deliberately not run-*fatal*: each case is
  // still validated against its own file bytes, so the caller can see which
  // slots could be filled and which are missing.
  if (!manifest.seal) {
    rejections.push(
      `run ${manifest.runId} manifest has no seal; refusing to consume an unsealed run`,
    );
  } else if (computeSeal(manifest) !== manifest.seal) {
    rejections.push(
      `run ${manifest.runId} manifest seal mismatch: the manifest was modified after finalizeRun`,
    );
  }
  const expectedCaseListOk =
    Array.isArray(manifest.expectedCases) &&
    manifest.expectedCases.length === EXPECTED_CASES.length &&
    EXPECTED_CASES.every((caseId, index) => manifest.expectedCases[index] === caseId);
  if (!expectedCaseListOk) {
    rejections.push(
      `run ${manifest.runId} manifest expected-case list does not match the fixed WS9 case list (${EXPECTED_CASES.length} cases)`,
    );
  }

  const runFatal =
    shaMismatch || runIdMismatch || incomplete || statusIncomplete || !expectedCaseListOk;

  // ── Per-case binding ───────────────────────────────────────────────────
  const listed = Array.isArray(manifest.cases)
    ? manifest.cases.filter((c) => typeof c === 'string')
    : [];
  const counts = new Map<string, number>();
  for (const caseId of listed) counts.set(caseId, (counts.get(caseId) ?? 0) + 1);
  for (const [caseId, count] of counts) {
    if (count > 1) {
      rejections.push(
        `run ${manifest.runId}: duplicate case "${caseId}" is listed ${count} times in the manifest`,
      );
    }
  }

  /** Run-root relative paths referenced as children (so they are not "extra"). */
  const referencedChildren = new Set<string>();

  for (const caseId of counts.keys()) {
    const caseRejections: string[] = [];
    const reject = (message: string): void => {
      caseRejections.push(`${caseId}: ${message}`);
    };
    const casePath = join(runRoot, `${caseId}.json`);

    if (!existsSync(casePath)) {
      reject(`case artifact file is missing: ${caseId}.json`);
      rejections.push(...caseRejections);
      continue;
    }
    const sealedHash = manifest.caseHashes?.[caseId];
    if (sealedHash) {
      try {
        if (sha256File(casePath) !== sealedHash) {
          reject('case artifact content hash mismatch (file modified after finalizeRun)');
        }
      } catch (err) {
        reject(`case artifact could not be hashed: ${(err as Error).message}`);
      }
    }

    let artifact: EvidenceArtifact;
    try {
      artifact = JSON.parse(readFileSync(casePath, 'utf-8')) as EvidenceArtifact;
    } catch (err) {
      reject(`case artifact is not valid JSON: ${(err as Error).message}`);
      rejections.push(...caseRejections);
      continue;
    }
    if (artifact === null || typeof artifact !== 'object') {
      reject('case artifact is not a JSON object');
      rejections.push(...caseRejections);
      continue;
    }

    // Schema / provenance.
    if (typeof artifact.testCaseId !== 'string' || artifact.testCaseId !== caseId) {
      reject(`artifact testCaseId ${String(artifact.testCaseId)} does not match its file name`);
    }
    if (!VERDICT_VALUES.includes(artifact.verdict)) {
      reject(`illegal verdict "${String(artifact.verdict)}"`);
    }
    if (!EVIDENCE_LEVEL_VALUES.includes(artifact.evidenceLevel)) {
      reject(`illegal evidenceLevel "${String(artifact.evidenceLevel)}"`);
    }
    if (typeof artifact.breach !== 'boolean') reject('breach flag missing');
    if (typeof artifact.details !== 'string') reject('details missing');
    if (typeof artifact.environment !== 'string' || !artifact.environment.trim()) {
      reject('environment fingerprint missing');
    }
    if (typeof artifact.startedAt !== 'string' || !artifact.startedAt) reject('startedAt missing');
    if (typeof artifact.endedAt !== 'string' || !artifact.endedAt) reject('endedAt missing');
    if (!EXPECTED_CASE_SET.has(caseId)) {
      reject('is not part of the fixed WS9 case list');
    }
    if (artifact.runId !== manifest.runId) {
      reject(
        `artifact runId "${String(artifact.runId)}" does not belong to this run (${manifest.runId})`,
      );
    }
    if (artifact.gitSha !== options.expectedGitSha) {
      reject(
        `artifact gitSha ${String(artifact.gitSha)} is not the candidate SHA ${options.expectedGitSha}`,
      );
    }

    // Child artifacts: recorded for the extra-file check even when the case
    // itself is rejected, so one bad case does not turn its children into
    // "extra unlisted artifacts".
    const children = Array.isArray(artifact.artifacts) ? artifact.artifacts : [];
    for (const child of children) {
      if (
        child === null ||
        typeof child !== 'object' ||
        typeof child.path !== 'string' ||
        typeof child.sha256 !== 'string'
      ) {
        reject('child artifact entry is not a { path, sha256 } record');
        continue;
      }
      const rawPath = child.path;
      if (child.external === true) {
        reject(
          `child artifact "${rawPath}" is recorded as external and resolves outside the run root`,
        );
        continue;
      }
      if (isAbsolute(rawPath)) {
        reject(
          `child artifact path "${rawPath}" is absolute, but the run root must be an absolute path and every child artifact path must be relative to it`,
        );
        continue;
      }
      const rel = rawPath
        .split(/[\\/]+/)
        .filter((part) => part.length > 0)
        .join('/');
      referencedChildren.add(rel);
      if (rel.split('/').includes('..')) {
        reject(`child artifact path "${rawPath}" escapes the run root (path traversal)`);
        continue;
      }
      const abs = join(runRoot, rel);
      const rootPrefix = runRoot.endsWith(sep) ? runRoot : runRoot + sep;
      if (abs !== runRoot && !abs.startsWith(rootPrefix)) {
        reject(`child artifact "${rawPath}" resolves outside the run root`);
        continue;
      }
      if (!existsSync(abs)) {
        reject(`child artifact "${rawPath}" is missing`);
        continue;
      }
      let realAbs: string;
      let realRoot: string;
      try {
        realAbs = realpathSync(abs);
        realRoot = realpathSync(runRoot);
      } catch (err) {
        reject(`child artifact "${rawPath}" could not be resolved: ${(err as Error).message}`);
        continue;
      }
      const realPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      if (realAbs !== realRoot && !realAbs.startsWith(realPrefix)) {
        reject(`child artifact "${rawPath}" resolves outside the run root (symlink escape)`);
        continue;
      }
      let actual: string;
      try {
        actual = sha256File(realAbs);
      } catch (err) {
        reject(`child artifact "${rawPath}" could not be hashed: ${(err as Error).message}`);
        continue;
      }
      if (actual !== child.sha256) {
        reject(
          `child artifact "${rawPath}" hash mismatch (recorded ${child.sha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`,
        );
      }
    }

    if (caseRejections.length > 0) {
      rejections.push(...caseRejections);
    } else if ((counts.get(caseId) ?? 0) === 1) {
      accepted.push(artifact);
    }
  }

  // ── Extra, unlisted case artifacts ─────────────────────────────────────
  let entries: string[];
  try {
    entries = readdirSync(runRoot);
  } catch (err) {
    rejections.push(`run ${manifest.runId} root could not be scanned: ${(err as Error).message}`);
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry === MANIFEST_FILE || entry === INCOMPLETE_MARKER) continue;
    const caseId = entry.slice(0, -'.json'.length);
    if (counts.has(caseId)) continue;
    if (referencedChildren.has(entry)) continue;
    rejections.push(`extra unlisted artifact "${entry}" is not listed in manifest.cases`);
  }

  const acceptedIds = new Set(accepted.map((c) => c.testCaseId));
  return {
    ok: !runFatal && rejections.length === 0,
    rejections,
    cases: runFatal ? [] : accepted,
    missing: runFatal ? [...EXPECTED_CASES] : EXPECTED_CASES.filter((id) => !acceptedIds.has(id)),
    runId: manifest.runId ?? null,
    status: manifest.status ?? null,
    gitSha: manifest.gitSha ?? null,
    runRoot,
  };
}

// ─── Orchestrator ────────────────────────────────────────────────────────

function ensureBaselineDir(): void {
  if (!existsSync(BASELINE_DIR)) {
    mkdirSync(BASELINE_DIR, { recursive: true });
  }
}

/** Run ws9-env-check.ts --json and parse the result. */
function runEnvCheck(): EnvCheckResult {
  const res = spawnSync('pnpm', ['exec', 'tsx', ENV_CHECK_SCRIPT, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  // env-check exits 0 on pass, 1 on fail, 2 on error.
  // stdout contains the JSON result regardless of exit code.
  const stdout = (res.stdout ?? '').trim();
  if (!stdout) {
    throw new Error(
      `ws9-env-check produced no output (exit=${res.status}, stderr=${(res.stderr ?? '').slice(0, 200)})`,
    );
  }

  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`ws9-env-check output is not JSON: ${stdout.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[0]) as EnvCheckResult;
}

/** Run the WS9 vitest suite against this execution's owned run directory. */
function runVitestSuite(runRoot: string): boolean {
  const res = spawnSync('pnpm', ['exec', 'vitest', 'run', '--reporter=default', 'tests/ws9/'], {
    cwd: join(REPO_ROOT, 'packages', 'core'),
    encoding: 'utf-8',
    stdio: 'inherit',
    timeout: 300_000, // 5 min ceiling; tests are serial.
    env: { ...process.env, [RUN_ROOT_ENV]: runRoot },
  });

  return res.status === 0;
}

function writeSummary(summary: LiveFireSummary): void {
  ensureBaselineDir();
  writeJsonAtomic(join(BASELINE_DIR, 'summary.json'), summary);
}

/**
 * Explicit, audited publication of one verified run's evidence into
 * `docs/baselines/ws9`. Refuses a run that is not fully verified and complete
 * for every expected case.
 */
function publishRun(runRoot: string, expectedGitSha: string): void {
  const result = verifyRun(runRoot, { expectedGitSha });
  if (!result.ok || result.missing.length > 0) {
    console.error(`Refusing to publish ${runRoot}: run is not a complete verified candidate.`);
    for (const rejection of result.rejections) console.error(`   • ${rejection}`);
    if (result.missing.length > 0) {
      console.error(`   • missing evidence for: ${result.missing.join(', ')}`);
    }
    process.exit(1);
  }
  const manifest = readManifestOrThrow(runRoot);
  ensureBaselineDir();
  const files = new Set<string>([MANIFEST_FILE]);
  for (const artifact of result.cases) {
    files.add(`${artifact.testCaseId}.json`);
    for (const child of artifact.artifacts) {
      if (child.external === true || isAbsolute(child.path)) continue;
      files.add(child.path);
    }
  }
  let published = 0;
  for (const rel of files) {
    const src = join(runRoot, rel);
    if (!existsSync(src) || !statSync(src).isFile()) continue;
    const dst = join(BASELINE_DIR, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    published++;
  }
  console.log(
    `Published ${published} verified file(s) from run ${manifest.runId} to ${BASELINE_DIR}`,
  );
}

function printUsage(): void {
  console.log(`WS9 live-fire suite orchestrator (spec §4, §9; evidence binding LM-16)

Usage:
  node --import tsx scripts/ws9-livefire.ts [options]

Options:
  --help, -h           Show this help and exit (no evidence is written).
  --run-root=<path>    Consume an existing run directory instead of running the
                       suite. Prints the VerifyResult as JSON; exit 0 only when
                       the run verifies against the current candidate SHA.
  --publish            Explicitly publish a verified run's evidence to
                       docs/baselines/ws9 (with --run-root=<path>: that run;
                       otherwise: the run this invocation produced, and only
                       when it verifies PASS).

Evidence binding: each execution creates its own empty run directory with a
random runId and passes it to every producer through ${RUN_ROOT_ENV}. Nothing
is read from, or written to, the shared baseline directory unless --publish is
given explicitly.`);
}

function main(argv: string[] = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const expectedGitSha = resolveGitSha();
  const runRootArg = argv.find((a) => a.startsWith('--run-root='))?.slice('--run-root='.length);
  const publish = argv.includes('--publish');

  if (runRootArg) {
    const runRoot = resolve(runRootArg);
    if (publish) {
      publishRun(runRoot, expectedGitSha);
      return;
    }
    const result = verifyRun(runRoot, { expectedGitSha });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

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
      runId: null,
      runRoot: null,
      envCheck: null,
      totalCases: EXPECTED_CASES.length,
      passed: 0,
      failed: 0,
      breached: 0,
      skipped: 0,
      missing: [...EXPECTED_CASES],
      rejections: [],
      cases: [],
      ranAt: new Date().toISOString(),
      gitSha: expectedGitSha,
    };
    writeSummary(summary);
    console.error(`ERROR: ${summary.reason}`);
    process.exit(3);
  }

  const failedChecks = envCheck.checks.filter((c) => c.severity === 'FAIL' && !c.passed);

  if (failedChecks.length > 0) {
    console.log(`\n❌ Environment gate FAILED: ${failedChecks.length} required check(s) failed.`);
    for (const c of failedChecks) {
      console.log(`   • ${c.check}: ${c.detail}`);
    }

    const summary: LiveFireSummary = {
      verdict: 'FAIL',
      reason: `Environment gate failed: ${failedChecks.map((c) => c.check).join(', ')}. Tests did not run — no evidence produced.`,
      runId: null,
      runRoot: null,
      envCheck,
      totalCases: EXPECTED_CASES.length,
      passed: 0,
      failed: 0,
      breached: 0,
      skipped: EXPECTED_CASES.length,
      missing: [...EXPECTED_CASES],
      rejections: [],
      cases: [],
      ranAt: new Date().toISOString(),
      gitSha: expectedGitSha,
    };
    writeSummary(summary);
    console.log(`\nVerdict: FAIL (exit 2)`);
    process.exit(2);
  }

  console.log('✅ Environment gate passed. Proceeding to live-fire tests.');

  // Step 2: Own this execution's output directory, then run the suite.
  const runRoot = createRunRoot();
  const manifest = beginRun(runRoot);
  console.log(`\nStep 2: Running WS9 live-fire test suite...`);
  console.log(`   run ${manifest.runId}`);
  console.log(`   output root: ${runRoot}`);
  console.log('   (6 test files, serial execution)');
  console.log('');

  const vitestOk = runVitestSuite(runRoot);
  if (!vitestOk) {
    finalizeRun(runRoot, 'failed', 'vitest suite exited non-zero');
    const summary: LiveFireSummary = {
      verdict: 'FAIL',
      reason: 'Vitest suite exited non-zero — refusing to treat residual/partial evidence as live.',
      runId: manifest.runId,
      runRoot,
      envCheck,
      totalCases: EXPECTED_CASES.length,
      passed: 0,
      failed: EXPECTED_CASES.length,
      breached: 0,
      skipped: 0,
      missing: [...EXPECTED_CASES],
      rejections: [],
      cases: [],
      ranAt: new Date().toISOString(),
      gitSha: expectedGitSha,
    };
    writeSummary(summary);
    console.error(`\nVerdict: FAIL (vitest non-zero; exit 1)`);
    process.exit(1);
  }

  // Step 3: Consume only this run's manifest-listed, hash-verified artifacts.
  console.log('\nStep 3: Verifying evidence binding (runId + candidate SHA + child hashes)...');
  const verification = verifyRun(runRoot, { expectedGitSha, expectedRunId: manifest.runId });
  const cases = verification.cases;
  const missing = verification.missing;

  // Step 4: Apply honesty rules (spec §9.2).
  let passCount = 0;
  let failCount = 0;
  let breachCount = 0;
  let skipCount = 0;
  for (const artifact of cases) {
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

  const hasBreaches = breachCount > 0;
  const hasSkipped = skipCount > 0;
  const hasMissing = missing.length > 0;
  const nonLivePasses = cases.filter((c) => c.verdict === 'PASS' && c.evidenceLevel !== 'live');
  const allPassed = passCount === EXPECTED_CASES.length && nonLivePasses.length === 0;

  const verdict: 'PASS' | 'FAIL' =
    verification.ok && allPassed && !hasBreaches && !hasSkipped && !hasMissing ? 'PASS' : 'FAIL';

  const reasons: string[] = [];
  if (verification.rejections.length > 0) {
    reasons.push(`${verification.rejections.length} evidence-binding rejection(s)`);
  }
  if (hasBreaches) reasons.push(`${breachCount} breach(es) detected`);
  if (hasSkipped) reasons.push(`${skipCount} case(s) skipped`);
  if (hasMissing) reasons.push(`missing evidence for: ${missing.join(', ')}`);
  if (failCount > 0) reasons.push(`${failCount} case(s) failed`);
  if (nonLivePasses.length > 0) {
    reasons.push(
      `${nonLivePasses.length} PASS artifact(s) without evidenceLevel=live: ${nonLivePasses.map((c) => `${c.testCaseId}(${c.evidenceLevel})`).join(', ')}`,
    );
  }

  const summary: LiveFireSummary = {
    verdict,
    reason:
      verdict === 'PASS'
        ? `All ${EXPECTED_CASES.length} test cases passed with 0 breaches (run ${manifest.runId}).`
        : `FAIL: ${reasons.join('; ')}.`,
    runId: manifest.runId,
    runRoot,
    envCheck,
    totalCases: EXPECTED_CASES.length,
    passed: passCount,
    failed: failCount,
    breached: breachCount,
    skipped: skipCount,
    missing,
    rejections: verification.rejections,
    cases,
    ranAt: new Date().toISOString(),
    gitSha: expectedGitSha,
  };

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
  if (verification.rejections.length > 0) {
    console.log(`   Binding rejections: ${verification.rejections.length}`);
    for (const rejection of verification.rejections.slice(0, 10)) {
      console.log(`     • ${rejection}`);
    }
  }

  console.log(`\nVerdict: ${verdict}`);
  console.log(`Run directory (evidence): ${runRoot}`);
  console.log(`Summary written to: ${join(BASELINE_DIR, 'summary.json')}`);

  if (publish && verdict === 'PASS') {
    publishRun(runRoot, expectedGitSha);
  } else if (publish) {
    console.error('Refusing to publish: the run did not verify PASS.');
  }

  process.exit(verdict === 'PASS' ? 0 : 1);
}

// Entry guard: the module must be importable by the evidence-binding contract
// test and by packages/core/tests/ws9/_evidence.ts without the CLI body running
// (main() calls process.exit and writes the shared baseline directory). Only a
// direct CLI invocation executes the suite.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
