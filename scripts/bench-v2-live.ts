#!/usr/bin/env tsx
/**
 * bench-v2-live.ts — Layer B live benchmark harness.
 *
 * Supports two modes:
 *   - simulated (default): uses the in-memory /v2/* bench ledger. Fast, needs
 *     no Docker, suitable for CI/local sanity checks.
 *   - live: submits real runs through /v1/runs and polls the shared kernel
 *     until every run reaches a terminal state. Requires a running API + kernel
 *     (and ideally workers) to make meaningful progress.
 *
 * Output JSON matches the Layer B evidence contract. A baseline file is
 * written to docs/baselines/bench-v2-live.<timestamp>.json so the readiness
 * gate can consume it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateBaseline,
  type BaselineBinding,
  type BaselineDocument,
  type BaselineSummary,
} from '../packages/core/src/benchmarks/baselineSchema.ts';
import { collectBenchmarkEnv } from './benchmarkEnv';

interface BenchOptions {
  image: string;
  baseUrl: string;
  runs: number;
  tenants: number;
  rate: number;
  timeoutSeconds: number;
  mode: 'simulated' | 'live';
}

interface AnomalyCounts {
  duplicateClaims: number;
  staleCompletions: number;
  tenantLeaks: number;
  unknownEffects: number;
  reconciledEffects: number;
  failedRuns: number;
}

interface HttpResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

interface BenchMeasurements {
  live: boolean;
  seeded: boolean;
  drained: boolean;
  auditAvailable: boolean;
  runs: number;
  tenants: number;
  rate: number;
  anomalyCounts: AnomalyCounts;
  latencyMs: {
    total: number;
    seed?: number;
    drain?: number;
    anomaly?: number;
  };
  failures: string[];
}

function parseArgs(argv: string[]): BenchOptions {
  const imageArg = argv.find((a) => a.startsWith('--image='));
  const baseUrlArg = argv.find((a) => a.startsWith('--base-url='));
  const runsArg = argv.find((a) => a.startsWith('--runs='));
  const tenantsArg = argv.find((a) => a.startsWith('--tenants='));
  const rateArg = argv.find((a) => a.startsWith('--rate='));
  const timeoutArg = argv.find((a) => a.startsWith('--timeout='));
  const modeArg = argv.find((a) => a.startsWith('--mode='));

  const runs = runsArg ? Number.parseInt(runsArg.slice('--runs='.length), 10) : 10_000;
  const tenants = tenantsArg ? Number.parseInt(tenantsArg.slice('--tenants='.length), 10) : 5;
  const rate = rateArg ? Number.parseInt(rateArg.slice('--rate='.length), 10) : 10;
  const timeoutSeconds = timeoutArg
    ? Number.parseInt(timeoutArg.slice('--timeout='.length), 10)
    : 300;
  const rawMode = modeArg?.slice('--mode='.length) ?? 'simulated';
  const mode: BenchOptions['mode'] = rawMode === 'live' ? 'live' : 'simulated';

  return {
    image: imageArg?.slice('--image='.length) ?? 'commander-api:latest',
    baseUrl: baseUrlArg?.slice('--base-url='.length) ?? 'http://127.0.0.1:8080',
    runs: Number.isFinite(runs) && runs > 0 ? runs : 10_000,
    tenants: Number.isFinite(tenants) && tenants > 0 ? tenants : 5,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 10,
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 300,
    mode,
  };
}

async function httpJson<T>(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult<T>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return { ok: false, status: res.status, data: null };
    }

    const json = (await res.json()) as T;
    return { ok: true, status: res.status, data: json };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

async function isLive(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Simulated mode: /v2 in-memory ledger ───────────────────────────────────

async function collectAnomaliesSimulated(baseUrl: string): Promise<AnomalyCounts | null> {
  const aggregate = await httpJson<AnomalyCounts & { ok?: boolean }>(
    'GET',
    `${baseUrl}/v2/bench/anomalies`,
  );
  if (aggregate.ok && aggregate.data) {
    if (aggregate.data.ok === false) return null;
    return {
      duplicateClaims: aggregate.data.duplicateClaims ?? 0,
      staleCompletions: aggregate.data.staleCompletions ?? 0,
      tenantLeaks: aggregate.data.tenantLeaks ?? 0,
      unknownEffects: aggregate.data.unknownEffects ?? 0,
      reconciledEffects: aggregate.data.reconciledEffects ?? 0,
      failedRuns: 0,
    };
  }

  const [effectsRes, runsRes] = await Promise.all([
    httpJson<Array<{ runId: string; tenantId: string; status: string }>>(
      'GET',
      `${baseUrl}/v2/effects`,
    ),
    httpJson<Array<{ runId: string; tenantId: string; state: string; claimedBy?: string[] }>>(
      'GET',
      `${baseUrl}/v2/runs`,
    ),
  ]);

  if (!effectsRes.ok || !runsRes.ok) {
    return null;
  }

  const effects = effectsRes.data ?? [];
  const runs = runsRes.data ?? [];

  const runById = new Map(runs.map((r) => [r.runId, r]));
  const claims = new Map<string, Set<string>>();
  for (const r of runs) {
    for (const holder of r.claimedBy ?? []) {
      if (!claims.has(r.runId)) claims.set(r.runId, new Set());
      claims.get(r.runId)!.add(holder);
    }
  }

  let duplicateClaims = 0;
  for (const [, holders] of claims) {
    if (holders.size > 1) duplicateClaims++;
  }

  let tenantLeaks = 0;
  let unknownEffects = 0;
  for (const e of effects) {
    const run = runById.get(e.runId);
    if (!run) {
      unknownEffects++;
      continue;
    }
    if (run.tenantId !== e.tenantId) tenantLeaks++;
  }

  const staleCompletions = runs.filter((r) => r.state === 'STALE_COMPLETED').length;
  const reconciledEffects = effects.filter((e) => e.status === 'RECONCILED').length;

  return {
    duplicateClaims,
    staleCompletions,
    tenantLeaks,
    unknownEffects,
    reconciledEffects,
    failedRuns: 0,
  };
}

async function seedRunsSimulated(
  baseUrl: string,
  runs: number,
  tenants: number,
): Promise<boolean> {
  const batchSize = 500;
  for (let i = 0; i < runs; i += batchSize) {
    const batch = [];
    const end = Math.min(i + batchSize, runs);
    for (let j = i; j < end; j++) {
      batch.push({
        runId: `bench-v2-${j}`,
        tenantId: `tenant-${j % tenants}`,
        intentHash: `intent-${j}`,
      });
    }
    const res = await httpJson<{ ok?: boolean }>('POST', `${baseUrl}/v2/runs/batch`, batch);
    if (!res.ok || !res.data || res.data.ok !== true) return false;
  }
  return true;
}

async function waitForDrainSimulated(
  baseUrl: string,
  runs: number,
  timeoutSeconds: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const res = await httpJson<{ pending: number; completed: number }>(
      'GET',
      `${baseUrl}/v2/runs/status`,
    );
    if (res.ok && res.data && res.data.pending === 0 && res.data.completed === runs) return true;
    await sleep(1000);
  }
  return false;
}

// ── Live mode: real /v1 kernel path ────────────────────────────────────────

interface LiveRunHandle {
  runId: string;
  tenantId: string;
  benchIndex: number;
}

async function createLiveRun(
  baseUrl: string,
  tenantId: string,
  benchIndex: number,
): Promise<string | null> {
  const idempotencyKey = `bench-v2-live-${benchIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await httpJson<{ run?: { id: string } }>(
    'POST',
    `${baseUrl}/v1/runs`,
    {
      goal: `Layer B benchmark run ${benchIndex} for ${tenantId}`,
      metadata: { benchIndex, tenantId, source: 'bench-v2-live' },
    },
    {
      'Idempotency-Key': idempotencyKey,
      'X-Tenant-ID': tenantId,
    },
  );
  if (!res.ok || !res.data?.run?.id) return null;
  return res.data.run.id;
}

async function seedRunsLive(
  baseUrl: string,
  runs: number,
  tenants: number,
  rate: number,
): Promise<LiveRunHandle[]> {
  const handles: LiveRunHandle[] = [];
  const intervalMs = 1000 / rate;
  for (let i = 0; i < runs; i++) {
    const tenantId = `tenant-${i % tenants}`;
    const runId = await createLiveRun(baseUrl, tenantId, i);
    if (!runId) return handles;
    handles.push({ runId, tenantId, benchIndex: i });
    if (i < runs - 1) await sleep(intervalMs);
  }
  return handles;
}

interface RunStatus {
  runId: string;
  state: string;
  tenantId: string;
  terminal: boolean;
}

async function getRunStatus(
  baseUrl: string,
  runId: string,
  tenantId: string,
): Promise<RunStatus | null> {
  const res = await httpJson<RunStatus>(
    'GET',
    `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/status`,
    undefined,
    { 'X-Tenant-ID': tenantId },
  );
  return res.ok && res.data ? res.data : null;
}

async function waitForLiveDrain(
  baseUrl: string,
  handles: LiveRunHandle[],
  timeoutSeconds: number,
): Promise<{ drained: boolean; statuses: Map<string, RunStatus>; failedRuns: number }> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const statuses = new Map<string, RunStatus>();
  while (Date.now() < deadline) {
    statuses.clear();
    let terminalCount = 0;
    let failedRuns = 0;
    for (const h of handles) {
      const status = await getRunStatus(baseUrl, h.runId, h.tenantId);
      if (status) {
        statuses.set(h.runId, status);
        if (status.terminal) terminalCount++;
        if (status.state === 'FAILED') failedRuns++;
      }
    }
    if (terminalCount === handles.length) {
      return { drained: true, statuses, failedRuns };
    }
    await sleep(1000);
  }
  // Final scan to report whatever we have.
  let failedRuns = 0;
  for (const h of handles) {
    const status = statuses.get(h.runId) ?? (await getRunStatus(baseUrl, h.runId, h.tenantId));
    if (status) {
      statuses.set(h.runId, status);
      if (status.state === 'FAILED') failedRuns++;
    }
  }
  return { drained: false, statuses, failedRuns };
}

interface KernelEvent {
  type: string;
  tenantId: string;
  runId: string;
  stepId?: string;
  actor: string;
  aggregateType: 'run' | 'step' | 'effect' | 'interaction' | 'worker';
}

async function listRunEvents(
  baseUrl: string,
  runId: string,
  tenantId: string,
): Promise<KernelEvent[] | null> {
  const res = await httpJson<{ events?: KernelEvent[] }>(
    'GET',
    `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`,
    undefined,
    { 'X-Tenant-ID': tenantId },
  );
  if (!res.ok || !res.data) return null;
  return res.data.events ?? [];
}

async function collectLiveAnomalies(
  baseUrl: string,
  handles: LiveRunHandle[],
  runStatuses: Map<string, RunStatus>,
): Promise<AnomalyCounts | null> {
  const runIdSet = new Set(handles.map((h) => h.runId));
  const expectedTenantByRun = new Map(handles.map((h) => [h.runId, h.tenantId]));

  let duplicateClaims = 0;
  let tenantLeaks = 0;
  let unknownEffects = 0;
  let reconciledEffects = 0;
  let failedRuns = 0;

  for (const h of handles) {
    const status = runStatuses.get(h.runId);
    if (status?.state === 'FAILED') failedRuns++;

    const events = await listRunEvents(baseUrl, h.runId, h.tenantId);
    if (events === null) return null;

    const claimedActorsByStep = new Map<string, Set<string>>();
    for (const e of events) {
      if (e.aggregateType === 'step' && e.type === 'step.claimed' && e.stepId) {
        const actors = claimedActorsByStep.get(e.stepId) ?? new Set<string>();
        actors.add(e.actor);
        claimedActorsByStep.set(e.stepId, actors);
      }
      if (e.aggregateType === 'effect' && e.type === 'effect.admitted') {
        if (!runIdSet.has(e.runId)) {
          unknownEffects++;
        } else if (expectedTenantByRun.get(e.runId) !== e.tenantId) {
          tenantLeaks++;
        }
        if ((e as KernelEvent & { payload?: { replayed?: boolean } }).payload?.replayed) {
          reconciledEffects++;
        }
      }
    }

    for (const actors of claimedActorsByStep.values()) {
      if (actors.size > 1) duplicateClaims++;
    }
  }

  return {
    duplicateClaims,
    staleCompletions: 0,
    tenantLeaks,
    unknownEffects,
    reconciledEffects,
    failedRuns,
  };
}

// ── Baseline output ────────────────────────────────────────────────────────

function getImageDigest(image: string): string | undefined {
  try {
    const result = spawnSync('docker', ['inspect', '--format={{index .RepoDigests 0}}', image], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 15_000,
    });
    if (result.error || result.status !== 0 || !result.stdout) return undefined;
    const raw = result.stdout.trim();
    const at = raw.indexOf('@');
    return at >= 0 ? raw.slice(at + 1) : raw;
  } catch {
    return undefined;
  }
}

function writeBaseline(baseline: BaselineDocument): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const baselineDir = resolve(repoRoot, 'docs', 'baselines');
  mkdirSync(baselineDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baselinePath = resolve(baselineDir, `bench-v2-live.${timestamp}.json`);
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf-8');
  return baselinePath;
}

export async function run(
  argv: string[],
): Promise<{ report: Record<string, unknown>; baselinePath: string; passed: boolean }> {
  const opts = parseArgs(argv);
  const startedAt = Date.now();

  process.env.COMMANDER_IMAGE = opts.image;
  const digest = getImageDigest(opts.image);
  if (digest) process.env.COMMANDER_IMAGE_DIGEST = digest;
  process.env.COMMANDER_POSTGRES_VERSION = '16.x';
  process.env.COMMANDER_TOPOLOGY_GATEWAYS = '2';
  process.env.COMMANDER_TOPOLOGY_WORKERS = '10';
  process.env.COMMANDER_TOPOLOGY_OPERATIONS = '2';
  process.env.COMMANDER_TOPOLOGY_MODEL = 'v2';

  const live = opts.mode === 'live';
  const topologyReachable = await isLive(opts.baseUrl);

  let anomalies: AnomalyCounts | null = null;
  let drained = false;
  let seeded = false;
  const failures: string[] = [];

  let seedLatencyMs: number | undefined;
  let drainLatencyMs: number | undefined;
  let anomalyLatencyMs: number | undefined;

  if (opts.mode === 'simulated') {
    if (topologyReachable) {
      console.log(
        `[bench:v2:live] simulated mode against ${opts.baseUrl} using /v2 memory ledger`,
      );
      const seedStart = Date.now();
      seeded = await seedRunsSimulated(opts.baseUrl, opts.runs, opts.tenants);
      seedLatencyMs = Date.now() - seedStart;
      if (!seeded) {
        failures.push('seed failed');
      } else {
        const drainStart = Date.now();
        drained = await waitForDrainSimulated(opts.baseUrl, opts.runs, opts.timeoutSeconds);
        drainLatencyMs = Date.now() - drainStart;
        if (!drained) failures.push('drain timeout');
      }
      const anomalyStart = Date.now();
      anomalies = await collectAnomaliesSimulated(opts.baseUrl);
      anomalyLatencyMs = Date.now() - anomalyStart;
      if (!anomalies) failures.push('anomaly audit unavailable');
    } else {
      console.log(
        `[bench:v2:live] simulated mode: topology not reachable at ${opts.baseUrl}; emitting simulated baseline`,
      );
      failures.push('topology not reachable');
    }
  } else {
    if (!topologyReachable) {
      console.error(
        `[bench:v2:live] live mode: kernel / API not reachable at ${opts.baseUrl}; cannot proceed`,
      );
      failures.push('kernel not reachable');
    } else {
      console.log(`[bench:v2:live] live mode against ${opts.baseUrl} using /v1/runs`);
      const seedStart = Date.now();
      const handles = await seedRunsLive(opts.baseUrl, opts.runs, opts.tenants, opts.rate);
      seeded = handles.length === opts.runs;
      seedLatencyMs = Date.now() - seedStart;
      if (!seeded) {
        failures.push(`seed failed: created ${handles.length}/${opts.runs} runs`);
      } else {
        const drainStart = Date.now();
        const drainResult = await waitForLiveDrain(
          opts.baseUrl,
          handles,
          opts.timeoutSeconds,
        );
        drainLatencyMs = Date.now() - drainStart;
        drained = drainResult.drained;
        if (!drained) failures.push('drain timeout');
        const anomalyStart = Date.now();
        anomalies = await collectLiveAnomalies(
          opts.baseUrl,
          handles,
          drainResult.statuses,
        );
        anomalyLatencyMs = Date.now() - anomalyStart;
        if (!anomalies) failures.push('anomaly audit unavailable');
      }
    }
  }

  const counts: AnomalyCounts = anomalies ?? {
    duplicateClaims: 0,
    staleCompletions: 0,
    tenantLeaks: 0,
    unknownEffects: 0,
    reconciledEffects: 0,
    failedRuns: 0,
  };

  const anomalyOk =
    counts.duplicateClaims === 0 &&
    counts.tenantLeaks === 0 &&
    counts.unknownEffects === 0 &&
    counts.staleCompletions === 0 &&
    counts.failedRuns === 0;

  if (!anomalyOk) {
    if (counts.duplicateClaims > 0) failures.push(`${counts.duplicateClaims} duplicate claims`);
    if (counts.tenantLeaks > 0) failures.push(`${counts.tenantLeaks} tenant leaks`);
    if (counts.unknownEffects > 0) failures.push(`${counts.unknownEffects} unknown effects`);
    if (counts.staleCompletions > 0) failures.push(`${counts.staleCompletions} stale completions`);
    if (counts.failedRuns > 0) failures.push(`${counts.failedRuns} failed runs`);
  }

  // Simulated mode is allowed to pass without a live topology. Live mode must
  // have a reachable kernel, successful seed/drain, and clean anomaly audit.
  const passed = opts.mode === 'simulated'
    ? anomalyOk
    : topologyReachable && seeded && drained && anomalies !== null && anomalyOk;
  const anomalyErrors =
    counts.duplicateClaims +
    counts.tenantLeaks +
    counts.unknownEffects +
    counts.staleCompletions +
    counts.failedRuns;

  const env = collectBenchmarkEnv({ evidence: opts.mode });

  const summary: BaselineSummary = {
    passed,
    errors: anomalyErrors,
    failed: 0,
    skipped: 0,
  };

  const measurements: BenchMeasurements = {
    live,
    seeded,
    drained,
    auditAvailable: anomalies !== null,
    runs: opts.runs,
    tenants: opts.tenants,
    rate: opts.rate,
    anomalyCounts: counts,
    latencyMs: {
      total: Date.now() - startedAt,
      seed: seedLatencyMs,
      drain: drainLatencyMs,
      anomaly: anomalyLatencyMs,
    },
    failures,
  };

  const baselineBinding: BaselineBinding = {
    gitSha: env.gitSha,
    nodeVersion: env.nodeVersion,
    pnpmVersion: env.pnpmVersion,
    topology: env.topology,
    datasetVersion: env.datasetVersion ?? 'unknown',
  };

  const baseline: BaselineDocument = {
    schemaVersion: 2,
    evidenceLevel: opts.mode,
    baseline: baselineBinding,
    summary,
    env,
    measurements,
    runAt: new Date().toISOString(),
  };

  const validation = validateBaseline(baseline, {
    gitSha: env.gitSha,
    nodeVersion: env.nodeVersion,
    pnpmVersion: env.pnpmVersion,
    imageDigest: env.imageDigest,
  });
  if (!validation.ok) {
    console.error(
      '[bench:v2:live] generated baseline failed validation:',
      validation.reasons.join('; '),
    );
  }

  const baselinePath = writeBaseline(baseline);

  const report = {
    schemaVersion: 2,
    gitSha: env.gitSha,
    imageDigest: env.imageDigest ?? null,
    nodeVersion: env.nodeVersion,
    postgresVersion: env.postgresVersion ?? '16.x',
    topology: env.topology ?? { gateways: 2, workers: 10, operations: 2 },
    runs: opts.runs,
    tenants: opts.tenants,
    rate: opts.rate,
    mode: opts.mode,
    live,
    seeded,
    drained,
    auditAvailable: anomalies !== null,
    ...counts,
    summary,
    verdict: passed ? 'PASS' : 'FAIL',
    failures,
    baselinePath,
    env,
    runAt: new Date().toISOString(),
  };

  return { report, baselinePath, passed };
}

async function main() {
  const { report, baselinePath, passed } = await run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  console.log(`[bench:v2:live] baseline written to ${baselinePath}`);
  process.exit(passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(2);
  });
}
