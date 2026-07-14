#!/usr/bin/env tsx
/**
 * bench-failover-rto-live.ts — failover RTO drill baseline generator.
 *
 * Supports two modes:
 *   --mode=local  (default) single-process kill/reclaim drill using
 *                 scripts/bench-failover-worker.js. Evidence is simulated.
 *   --mode=docker live container/DB drill against the docker compose topology.
 *                 Evidence is live; if docker is unavailable the baseline
 *                 reports the failure clearly instead of silently passing.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { withBenchmarkEnv, type BenchmarkEnv } from './benchmarkEnv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const WORKER_PATH = resolve(__dirname, 'bench-failover-worker.js');

const THRESHOLD_MS = 10_000;

interface Measurement {
  name: string;
  actualMs: number;
  thresholdMs: number;
  passed: boolean;
  reason?: string;
}

interface BenchOptions {
  mode: 'local' | 'docker';
  outputPath: string;
}

function parseArgs(argv: string[]): BenchOptions {
  const modeArg = argv.find((a) => a.startsWith('--mode='));
  const outputArg = argv.find((a) => a.startsWith('--output='));

  const rawMode = modeArg?.slice('--mode='.length) ?? 'local';
  const mode = rawMode === 'docker' ? 'docker' : 'local';

  const outputPath =
    outputArg?.slice('--output='.length) ?? 'docs/baselines/failover-rto-live.latest.json';

  return { mode, outputPath };
}

function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tmp = net.createServer();
    tmp.listen(0, '127.0.0.1', () => {
      const addr = tmp.address() as net.AddressInfo;
      tmp.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    tmp.on('error', reject);
  });
}

function waitForReady(
  worker: ReturnType<typeof fork>,
  timeoutMs = 5000,
): Promise<{ port: number; pid: number; leaseId: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('worker did not become ready in time'));
    }, timeoutMs);

    const onMessage = (msg: any) => {
      if (msg?.type === 'ready' && msg.port && msg.pid) {
        cleanup();
        resolve({ port: msg.port, pid: msg.pid, leaseId: msg.leaseId ?? 'unknown' });
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`worker exited before ready (code=${code})`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function waitForExit(worker: ReturnType<typeof fork>, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('worker did not exit in time'));
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve();
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timer);
      worker.off('exit', onExit);
      worker.off('error', onError);
    };

    worker.on('exit', onExit);
    worker.on('error', onError);
  });
}

function sendWork(worker: ReturnType<typeof fork>, payload?: unknown, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('worker did not acknowledge work in time'));
    }, timeoutMs);

    const onMessage = (msg: any) => {
      if (msg?.type === 'work_done') {
        cleanup();
        resolve();
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`worker exited while processing work (code=${code})`));
    };

    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.send({ type: 'work', payload });
  });
}

function reclaimPort(port: number, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tryBind = () => {
      const tmp = net.createServer();
      tmp.once('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && Date.now() < deadline) {
          setImmediate(tryBind);
          return;
        }
        reject(err);
      });
      tmp.listen(port, '127.0.0.1', () => {
        tmp.close((err) => (err ? reject(err) : resolve()));
      });
    };

    tryBind();
  });
}

async function runLocalDrill(): Promise<Measurement> {
  const port = await reserveEphemeralPort();
  const primary = fork(WORKER_PATH, [String(port), `primary-${Date.now()}`]);

  try {
    await waitForReady(primary);
    await sendWork(primary, { task: 'heartbeat' });

    const killedAt = Date.now();
    primary.kill('SIGKILL');
    await waitForExit(primary);

    // Reclaim the port at the OS level, then hand it to the replacement worker.
    await reclaimPort(port);

    const replacement = fork(WORKER_PATH, [String(port), `replacement-${Date.now()}`]);
    const replacementInfo = await waitForReady(replacement);
    const rtoMs = Date.now() - killedAt;

    // Verify the replacement actually took over the lease/work.
    await sendWork(replacement, { task: 'heartbeat' });

    replacement.kill('SIGKILL');
    await waitForExit(replacement);

    return {
      name: 'failover_rto_simulated',
      actualMs: rtoMs,
      thresholdMs: THRESHOLD_MS,
      passed: rtoMs < THRESHOLD_MS,
    };
  } catch (err) {
    try {
      primary.kill('SIGKILL');
    } catch {
      // ignore
    }
    return {
      name: 'failover_rto_simulated',
      actualMs: Number.NaN,
      thresholdMs: THRESHOLD_MS,
      passed: false,
      reason: (err as Error).message,
    };
  }
}

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 10_000,
  });
  return !result.error && result.status === 0;
}

function dockerComposeServices(): string[] {
  const result = spawnSync('docker', ['compose', 'config', '--services'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 15_000,
  });
  if (result.error || result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runDockerDrill(): Promise<Measurement> {
  if (!dockerAvailable()) {
    return {
      name: 'failover_rto_live',
      actualMs: Number.NaN,
      thresholdMs: THRESHOLD_MS,
      passed: false,
      reason: 'docker compose unavailable; live RTO drill requires a running docker compose topology',
    };
  }

  const services = dockerComposeServices();
  const target =
    services.find((s) => s.includes('worker')) ??
    services.find((s) => s.includes('db') || s.includes('postgres'));

  if (!target) {
    return {
      name: 'failover_rto_live',
      actualMs: Number.NaN,
      thresholdMs: THRESHOLD_MS,
      passed: false,
      reason: `no worker/db service found in docker compose services: [${services.join(', ') || 'none'}]`,
    };
  }

  console.log(`[failover-rto-live:docker] restarting service ${target} to measure RTO`);
  const restartedAt = Date.now();
  const restart = spawnSync('docker', ['compose', 'restart', target], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 120_000,
  });

  if (restart.error || restart.status !== 0) {
    return {
      name: 'failover_rto_live',
      actualMs: Number.NaN,
      thresholdMs: THRESHOLD_MS,
      passed: false,
      reason: `docker compose restart ${target} failed`,
    };
  }

  // Best-effort: time until the container reports healthy (or until a generous timeout).
  const healthyAt = Date.now();
  const rtoMs = healthyAt - restartedAt;

  return {
    name: 'failover_rto_live',
    actualMs: rtoMs,
    thresholdMs: THRESHOLD_MS,
    passed: false,
    reason: 'docker live RTO drill is a work in progress; measured restart time only, not full DB/worker failover reclaim',
  };
}

export async function run(
  argv: string[],
): Promise<{ report: Record<string, unknown>; baselinePath: string; passed: boolean }> {
  const opts = parseArgs(argv);
  const isLocal = opts.mode === 'local';

  console.log(`[failover-rto-live] mode=${opts.mode}`);

  const measurement = isLocal ? await runLocalDrill() : await runDockerDrill();

  const passed = measurement.passed;
  const errors = passed ? 0 : 1;
  const summary = { passed, errors, failed: errors, skipped: 0 };

  const evidence = isLocal ? 'simulated' : 'live';
  const env: BenchmarkEnv = withBenchmarkEnv(
    {
      benchmark: 'failover-rto-live',
      measurements: [measurement],
      summary,
    },
    {
      evidence,
      topology: isLocal
        ? { gateways: 1, workers: 1, operations: 0, model: 'single' }
        : { gateways: 1, workers: 2, operations: 1, model: 'v2' },
    },
  ).env;

  const baseline = {
    schemaVersion: 2,
    benchmark: 'failover-rto-live',
    evidenceLevel: evidence,
    baseline: {
      gitSha: env.gitSha,
      nodeVersion: env.nodeVersion,
      pnpmVersion: env.pnpmVersion,
      topology: env.topology,
    },
    measurements: [measurement],
    summary,
    env,
    runAt: new Date().toISOString(),
  };

  const fullPath = resolve(REPO_ROOT, opts.outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2) + '\n', { mode: 0o644 });

  const report = {
    ...baseline,
    baselinePath: fullPath,
    verdict: passed ? 'PASS' : 'FAIL',
  };

  return { report, baselinePath: fullPath, passed };
}

async function main() {
  const { report, baselinePath, passed } = await run(process.argv.slice(2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  console.log(`[failover-rto-live] baseline written to ${baselinePath}`);
  process.exit(passed ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('Fatal error:', e);
    process.exit(2);
  });
}
