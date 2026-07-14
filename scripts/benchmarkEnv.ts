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
    const pm = pkg.packageManager ?? '';
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
    const result = spawnSync(
      'docker',
      ['inspect', '--format={{index .RepoDigests 0}}', image],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10_000 },
    );
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
      ['-h', pgHost, '-p', String(pgPort), '-U', pgUser, '-d', pgDb, '-t', '-A', '-c', 'SELECT version();'],
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

// CLI helper: print the current env envelope as JSON.
if (import.meta.url === `file://${process.argv[1]}`) {
  const evidence = (process.argv[2] as BenchmarkEvidence) ?? 'simulated';
  console.log(JSON.stringify(collectBenchmarkEnv({ evidence }), null, 2));
}
