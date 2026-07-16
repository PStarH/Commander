#!/usr/bin/env tsx
/**
 * StepFun + V2 实战 benchmark 轮询器。
 *
 * 按配置轮流执行 chaos-255、bench-v2-live、topology、redteam、agentdojo 等，
 * 结果写入 docs/baselines/stepfun-live-loop/。
 *
 * 用法：
 *   STEPFUN_API_KEY=... pnpm bench:stepfun:loop
 *   STEPFUN_API_KEY=... pnpm bench:stepfun:loop --once
 *   STEPFUN_API_KEY=... pnpm bench:stepfun:loop --cycles=3 --cooldown=120
 *   STEPFUN_API_KEY=... pnpm bench:stepfun:loop --skip-v2-check
 *
 * 实战 V2 栈（可选，bench-v2-live 需要）：
 *   export COMMANDER_API_KEY=$(openssl rand -hex 32)
 *   export POSTGRES_PASSWORD=commander
 *   export STEPFUN_API_KEY=...
 *   export COMMANDER_DEFAULT_PROVIDER=stepfun
 *   export STEPFUN_MODEL=step-3.7-flash
 *   pnpm docker:v2
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectBenchmarkEnv } from './benchmarkEnv';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'docs', 'baselines', 'stepfun-live-loop');

interface BenchJob {
  id: string;
  evidence: 'live' | 'simulated' | 'synthetic' | 'source';
  needsV2: boolean;
  buildArgv: (ts: string) => string[];
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const skipV2 = argv.includes('--skip-v2-check');
  const cyclesArg = argv.find((a) => a.startsWith('--cycles='));
  const cooldownArg = argv.find((a) => a.startsWith('--cooldown='));
  const intervalArg = argv.find((a) => a.startsWith('--interval='));
  const baseUrlArg = argv.find((a) => a.startsWith('--base-url='));
  return {
    once,
    skipV2,
    cycles: once ? 1 : Number.parseInt(cyclesArg?.split('=')[1] ?? '0', 10),
    cooldownSec: Number.parseInt(cooldownArg?.split('=')[1] ?? '90', 10),
    intervalSec: Number.parseInt(intervalArg?.split('=')[1] ?? '600', 10),
    baseUrl: baseUrlArg?.split('=')[1] ?? 'http://127.0.0.1:4000',
  };
}

function stepfunEnv(): Record<string, string> {
  const key = process.env.STEPFUN_API_KEY ?? '';
  const base = process.env.STEPFUN_BASE_URL ?? 'https://api.stepfun.com/step_plan/v1';
  const model = process.env.STEPFUN_MODEL ?? 'step-3.7-flash';
  return {
    STEPFUN_API_KEY: key,
    STEPFUN_BASE_URL: base,
    STEPFUN_MODEL: model,
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: base,
    OPENAI_MODEL: model,
    COMMANDER_DEFAULT_PROVIDER: 'stepfun',
    COMMANDER_DEFAULT_MODEL: model,
  };
}

function requireStepfun(): void {
  if (!process.env.STEPFUN_API_KEY) {
    console.error('[bench:stepfun:loop] STEPFUN_API_KEY is required');
    process.exit(2);
  }
}

async function v2Reachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

const JOBS: BenchJob[] = [
  {
    id: 'chaos-255-live',
    evidence: 'live',
    needsV2: false,
    buildArgv: (ts) => [
      'exec',
      'tsx',
      'benchmarks/chaos-runner/src/index.ts',
      'run',
      '--live',
      '--llm-live',
      '--max=255',
      `--output=${resolve(OUT_DIR, `chaos-255-live.${ts}.json`)}`,
    ],
  },
  {
    id: 'bench-v2-live',
    evidence: 'live',
    needsV2: true,
    buildArgv: (ts) => [
      'exec',
      'tsx',
      'scripts/bench-v2-live.ts',
      '--mode=live',
      `--base-url=${process.env.BENCH_V2_BASE_URL ?? 'http://127.0.0.1:4000'}`,
      '--runs=20',
      '--tenants=3',
      '--rate=2',
      '--timeout=180',
    ],
  },
  {
    id: 'topology-quick',
    evidence: 'live',
    needsV2: false,
    buildArgv: (ts) => [
      'exec',
      'tsx',
      'scripts/benchmark-topology.ts',
      '--topology=single',
      '--iterations=3',
      `--output=${resolve(OUT_DIR, `topology-single.${ts}.json`)}`,
    ],
  },
  {
    id: 'redteam',
    evidence: 'synthetic',
    needsV2: false,
    buildArgv: () => ['exec', 'tsx', 'scripts/benchmark-redteam.ts'],
  },
  {
    id: 'agentdojo-all',
    evidence: 'source',
    needsV2: false,
    buildArgv: () => ['exec', 'tsx', 'scripts/benchmark-agentdojo.ts', '--all'],
  },
  {
    id: 'chaos-sim-255',
    evidence: 'simulated',
    needsV2: false,
    buildArgv: (ts) => [
      'exec',
      'tsx',
      'benchmarks/chaos-runner/src/index.ts',
      'run',
      '--simulated',
      '--scripted',
      '--max=255',
      `--output=${resolve(OUT_DIR, `chaos-sim-255.${ts}.json`)}`,
    ],
  },
];

function runJob(job: BenchJob, ts: string): { ok: boolean; exitCode: number; durationMs: number } {
  const started = Date.now();
  const argv = job.buildArgv(ts);
  console.log(`\n[bench:stepfun:loop] ▶ ${job.id} (${job.evidence})`);
  console.log(`[bench:stepfun:loop]   pnpm ${argv.join(' ')}`);

  const result = spawnSync('pnpm', argv, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...stepfunEnv() },
    stdio: 'inherit',
    timeout: job.id.startsWith('chaos') ? 3_600_000 : 1_800_000,
  });

  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  console.log(
    `[bench:stepfun:loop] ${ok ? '✓' : '✗'} ${job.id} exit=${result.status ?? 'null'} (${(durationMs / 1000).toFixed(1)}s)`,
  );
  return { ok, exitCode: result.status ?? 1, durationMs };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runCycle(
  cycle: number,
  opts: ReturnType<typeof parseArgs>,
  v2Ok: boolean,
): Promise<Record<string, unknown>> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const results: Array<{
    id: string;
    ok: boolean;
    exitCode: number;
    durationMs: number;
    skipped?: boolean;
    reason?: string;
  }> = [];

  for (const job of JOBS) {
    if (job.needsV2 && !v2Ok) {
      results.push({
        id: job.id,
        ok: false,
        exitCode: 0,
        durationMs: 0,
        skipped: true,
        reason: `v2 API not reachable at ${opts.baseUrl}`,
      });
      console.log(`[bench:stepfun:loop] ⊘ skip ${job.id} (v2 down)`);
      continue;
    }

    const r = runJob(job, ts);
    results.push({ id: job.id, ...r });
    if (opts.cooldownSec > 0) {
      console.log(`[bench:stepfun:loop] cooldown ${opts.cooldownSec}s...`);
      await sleep(opts.cooldownSec * 1000);
    }
  }

  const summary = {
    schemaVersion: 2,
    cycle,
    ranAt: new Date().toISOString(),
    model: process.env.STEPFUN_MODEL ?? 'step-3.7-flash',
    baseUrl: opts.baseUrl,
    v2Reachable: v2Ok,
    env: collectBenchmarkEnv({ evidence: 'live', topology: { model: 'v2', gateways: 1, workers: 1, operations: 1 } }),
    results,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
  };

  const summaryPath = resolve(OUT_DIR, `cycle-${String(cycle).padStart(4, '0')}.${ts}.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf-8');
  console.log(`[bench:stepfun:loop] cycle summary → ${summaryPath}`);
  return summary;
}

async function main(): Promise<void> {
  requireStepfun();
  const opts = parseArgs();
  process.env.BENCH_V2_BASE_URL = opts.baseUrl;
  mkdirSync(OUT_DIR, { recursive: true });

  console.log('[bench:stepfun:loop] StepFun V2 live benchmark loop');
  console.log(`[bench:stepfun:loop] model=${process.env.STEPFUN_MODEL ?? 'step-3.7-flash'}`);
  console.log(`[bench:stepfun:loop] base-url=${opts.baseUrl}`);
  console.log(
    `[bench:stepfun:loop] cycles=${opts.once ? 1 : opts.cycles === 0 ? '∞' : opts.cycles} cooldown=${opts.cooldownSec}s interval=${opts.intervalSec}s`,
  );

  let cycle = 0;
  const maxCycles = opts.once ? 1 : opts.cycles;

  while (true) {
    cycle++;
    const v2Ok = opts.skipV2 ? false : await v2Reachable(opts.baseUrl);
    if (!v2Ok && !opts.skipV2) {
      console.warn(
        `[bench:stepfun:loop] V2 API not reachable at ${opts.baseUrl} — v2-only jobs will skip. Start with: pnpm docker:v2`,
      );
    }

    const summary = await runCycle(cycle, opts, v2Ok);
    console.log(
      `[bench:stepfun:loop] cycle ${cycle} done: pass=${summary.passed} fail=${summary.failed} skip=${summary.skipped}`,
    );

    if (maxCycles > 0 && cycle >= maxCycles) break;
    console.log(`[bench:stepfun:loop] next cycle in ${opts.intervalSec}s (Ctrl+C to stop)`);
    await sleep(opts.intervalSec * 1000);
  }
}

main().catch((err) => {
  console.error('[bench:stepfun:loop] fatal:', err);
  process.exit(3);
});
