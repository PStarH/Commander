#!/usr/bin/env tsx
/**
 * benchmarkEnv.ts — Shared environment metadata for all Commander benchmarks.
 *
 * Every baseline JSON must be anchored to the exact runtime / topology / dataset
 * it was produced on. This module collects those facts in one place so bench
 * scripts do not reinvent (or omit) them.
 *
 * Evidence tiers:
 *   - source    : benchmark against a third-party dataset or rule set
 *                 (e.g. AgentDojo, HarmBench, CyberSecEval).
 *   - simulated : local in-process simulation / mock workload.
 *   - synthetic : rule-based / generated dataset (e.g. redteam battery).
 *   - live      : real container / process / database / network topology.
 */
import { readFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export type BenchmarkEvidence = 'source' | 'simulated' | 'synthetic' | 'live';

export interface BenchmarkTopology {
  /** Number of gateway / API containers. */
  gateways: number;
  /** Number of worker containers / processes. */
  workers: number;
  /** Number of operations / outbox / timer containers. */
  operations: number;
  /** Optional deployment model label. */
  model?: 'bridge' | 'silo' | 'v2' | 'single';
}

export interface BenchmarkEnv {
  /** Evidence tier for this benchmark. */
  evidence: BenchmarkEvidence;
  /** Git SHA of the code being benchmarked. */
  gitSha: string;
  /** Current Git branch / tag, if available. */
  gitBranch?: string;
  /** Whether the working tree has uncommitted changes. */
  gitDirty: boolean;
  /** Docker image digest when running in a container / live topology. */
  imageDigest?: string;
  /** Node.js version. */
  nodeVersion: string;
  /** pnpm version from packageManager field. */
  pnpmVersion: string;
  /** PostgreSQL version when a live DB is involved. */
  postgresVersion?: string;
  /** Runtime topology description. */
  topology: BenchmarkTopology;
  /** Dataset / rule-set version identifier for source benchmarks. */
  datasetVersion?: string;
}

export interface CollectEnvOptions {
  evidence: BenchmarkEvidence;
  /** Override / enrich topology defaults. */
  topology?: Partial<BenchmarkTopology>;
  /** Dataset version for source benchmarks. */
  datasetVersion?: string;
  /** PostgreSQL version override. */
  postgresVersion?: string;
  /** Image digest override. */
  imageDigest?: string;
}

let cachedPackageManagerVersion: string | undefined;

function getPnpmVersion(): string {
  if (cachedPackageManagerVersion) return cachedPackageManagerVersion;
  try {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
    const pm = typeof pkg?.packageManager === 'string' ? pkg.packageManager : '';
    const match = pm.match(/pnpm@(\d+\.\d+\.\d+)/);
    if (match) {
      cachedPackageManagerVersion = match[1];
      return cachedPackageManagerVersion;
    }
  } catch {
    // fallthrough
  }
  try {
    const out = execSync('pnpm --version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    cachedPackageManagerVersion = out.trim();
    return cachedPackageManagerVersion;
  } catch {
    cachedPackageManagerVersion = 'unknown';
    return cachedPackageManagerVersion;
  }
}

function getGitSha(): string {
  if (process.env.COMMANDER_GIT_SHA) return process.env.COMMANDER_GIT_SHA;
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function getGitBranch(): string | undefined {
  if (process.env.COMMANDER_GIT_BRANCH) return process.env.COMMANDER_GIT_BRANCH;
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function isGitDirty(): boolean {
  if (process.env.COMMANDER_GIT_DIRTY) return process.env.COMMANDER_GIT_DIRTY === '1';
  try {
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

function getImageDigest(): string | undefined {
  if (process.env.COMMANDER_IMAGE_DIGEST && process.env.COMMANDER_IMAGE_DIGEST !== 'undefined') {
    return process.env.COMMANDER_IMAGE_DIGEST;
  }
  const image = process.env.COMMANDER_IMAGE;
  if (!image || image === 'undefined') return undefined;
  try {
    const result = spawnSync('docker', ['inspect', '--format={{index .RepoDigests 0}}', image], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    if (result.error || result.status !== 0 || !result.stdout) return undefined;
    const raw = result.stdout.trim();
    // RepoDigests looks like "name@sha256:..."
    const at = raw.indexOf('@');
    return at >= 0 ? raw.slice(at + 1) : raw;
  } catch {
    return undefined;
  }
}

function getPostgresVersion(): string | undefined {
  if (process.env.COMMANDER_POSTGRES_VERSION) return process.env.COMMANDER_POSTGRES_VERSION;
  if (process.env.POSTGRES_VERSION) return process.env.POSTGRES_VERSION;
  const pgHost = process.env.PGHOST ?? process.env.COMMANDER_DATABASE_HOST;
  const pgPort = process.env.PGPORT ?? process.env.COMMANDER_DATABASE_PORT ?? '5432';
  const pgUser = process.env.PGUSER ?? process.env.COMMANDER_DATABASE_USER ?? 'postgres';
  const pgPassword = process.env.PGPASSWORD ?? process.env.COMMANDER_DATABASE_PASSWORD ?? '';
  const pgDb = process.env.PGDATABASE ?? process.env.COMMANDER_DATABASE_NAME ?? 'postgres';
  if (!pgHost) return undefined;
  try {
    const result = spawnSync(
      'psql',
      [
        '-h',
        pgHost,
        '-p',
        String(pgPort),
        '-U',
        pgUser,
        '-d',
        pgDb,
        '-t',
        '-A',
        '-c',
        'SELECT version();',
      ],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 5_000,
        env: { ...process.env, PGPASSWORD: pgPassword },
      },
    );
    if (result.error || result.status !== 0 || !result.stdout) return undefined;
    const out = result.stdout.trim();
    const match = out.match(/PostgreSQL\s+(\d+\.\d+)/);
    return match ? match[1] : out;
  } catch {
    return undefined;
  }
}

function getTopology(options?: Partial<BenchmarkTopology>): BenchmarkTopology {
  const envGateways = process.env.COMMANDER_TOPOLOGY_GATEWAYS;
  const envWorkers = process.env.COMMANDER_TOPOLOGY_WORKERS;
  const envOperations = process.env.COMMANDER_TOPOLOGY_OPERATIONS;
  const envModel = process.env.COMMANDER_TOPOLOGY_MODEL;
  return {
    gateways: options?.gateways ?? (envGateways ? parseInt(envGateways, 10) : 1),
    workers: options?.workers ?? (envWorkers ? parseInt(envWorkers, 10) : 1),
    operations: options?.operations ?? (envOperations ? parseInt(envOperations, 10) : 1),
    model: options?.model ?? (envModel as BenchmarkTopology['model']) ?? 'single',
  };
}

/**
 * Collect a canonical environment envelope for a baseline JSON.
 *
 * Prefer env overrides so CI / live runs can supply exact values without
 * shelling out to git or docker.
 */
export function collectBenchmarkEnv(options: CollectEnvOptions): BenchmarkEnv {
  return {
    evidence: options.evidence,
    gitSha: getGitSha(),
    gitBranch: getGitBranch(),
    gitDirty: isGitDirty(),
    imageDigest: options.imageDigest ?? getImageDigest(),
    nodeVersion: process.version,
    pnpmVersion: getPnpmVersion(),
    postgresVersion: options.postgresVersion ?? getPostgresVersion(),
    topology: getTopology(options.topology),
    datasetVersion: options.datasetVersion ?? process.env.COMMANDER_DATASET_VERSION,
  };
}

/**
 * Attach the environment envelope and a schemaVersion to any baseline payload.
 */
export function withBenchmarkEnv<T extends Record<string, unknown>>(
  payload: T,
  options: CollectEnvOptions,
): T & { schemaVersion: number; env: BenchmarkEnv; runAt: string } {
  return {
    schemaVersion: 2,
    ...payload,
    env: collectBenchmarkEnv(options),
    runAt: new Date().toISOString(),
  };
}

// ── Capability verdict ──────────────────────────────────────────────────────

/**
 * How a benchmark produced the numbers it is scoring.
 *
 *   - `scaffold`  : no real executor. Stub/fixture results exercise the pipeline
 *                   only; they say nothing about model capability.
 *   - `simulated` : local in-process simulation of the workload.
 *   - `live`      : a real executor produced the outputs that were scored.
 *
 * Only `live` can yield a capability PASS. A scaffold run that "passes" its
 * assertions has proved its plumbing, not its capability — conflating the two is
 * the defect this type exists to prevent.
 */
export type BenchmarkExecutionMode = 'scaffold' | 'simulated' | 'live';

export type CapabilityStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';

export interface CapabilityVerdictInput {
  /** How the numbers were produced. */
  mode: BenchmarkExecutionMode;
  /** Measured accuracy for this run. */
  accuracy: number;
  /** Reviewed baseline accuracy, or `null` when no baseline exists yet. */
  baselineAccuracy: number | null;
  /**
   * When true, a run that cannot yield a capability verdict exits non-zero.
   * Set from `COMMANDER_BENCHMARK_STRICT=1` in a required CI job.
   */
  strict?: boolean;
}

export interface CapabilityVerdict {
  status: CapabilityStatus;
  /** Exit code the benchmark process should use. */
  exitCode: number;
  /**
   * Whether this run may be counted as capability evidence. `false` for every
   * non-live run, and for a run with no reviewed baseline.
   */
  scoringEligible: boolean;
  reason: string;
}

/**
 * Decide the capability verdict for a benchmark run.
 *
 * Fails closed in every direction that used to succeed silently:
 *   - a scaffold/simulated run is NOT_EVALUATED, never PASS;
 *   - a missing baseline is NOT_EVALUATED, never an auto-created pass — creating
 *     a baseline must be a separate, reviewed operation;
 *   - only a live run at or above its reviewed baseline is a PASS.
 *
 * Pure: no I/O, no `process.exit`, so it is directly testable.
 */
export function capabilityVerdict(input: CapabilityVerdictInput): CapabilityVerdict {
  const strict = input.strict === true;

  if (input.mode !== 'live') {
    return {
      status: 'NOT_EVALUATED',
      exitCode: strict ? 1 : 0,
      scoringEligible: false,
      reason:
        `execution mode is '${input.mode}', not 'live': this run validates the ` +
        'benchmark pipeline and must not be reported as a capability result',
    };
  }

  if (input.baselineAccuracy === null) {
    return {
      status: 'NOT_EVALUATED',
      exitCode: strict ? 1 : 0,
      scoringEligible: false,
      reason:
        'no reviewed baseline exists; creating one is a separate reviewed operation ' +
        'and is never a by-product of a verification run',
    };
  }

  if (input.accuracy < input.baselineAccuracy) {
    return {
      status: 'FAIL',
      exitCode: 1,
      scoringEligible: true,
      reason: `capability regression: accuracy=${input.accuracy} < baseline=${input.baselineAccuracy}`,
    };
  }

  return {
    status: 'PASS',
    exitCode: 0,
    scoringEligible: true,
    reason: `accuracy=${input.accuracy} >= baseline=${input.baselineAccuracy} (live run)`,
  };
}

/**
 * One-line human-readable rendering. Deliberately never prints the string
 * "Capability check passed" unless the verdict is an actual PASS, so a scaffold
 * run cannot be mistaken for a capability result in a CI log.
 */
export function formatCapabilityVerdict(
  verdict: CapabilityVerdict,
  measured: { accuracy: number; baselineAccuracy: number | null },
): string {
  const detail =
    `accuracy=${measured.accuracy} baseline=${measured.baselineAccuracy ?? 'none'} ` +
    `scoringEligible=${verdict.scoringEligible}`;
  switch (verdict.status) {
    case 'PASS':
      return `Capability check passed: ${detail} — ${verdict.reason}`;
    case 'FAIL':
      return `Capability check failed: ${detail} — ${verdict.reason}`;
    default:
      return `Capability NOT_EVALUATED (this is not a pass): ${detail} — ${verdict.reason}`;
  }
}

/** Read the strict-mode flag from the environment. */
export function capabilityStrictFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMMANDER_BENCHMARK_STRICT === '1';
}

// CLI helper: print the current env envelope as JSON.
if (import.meta.url === `file://${process.argv[1]}`) {
  const evidence = (process.argv[2] as BenchmarkEvidence) ?? 'simulated';
  console.log(JSON.stringify(collectBenchmarkEnv({ evidence }), null, 2));
}
