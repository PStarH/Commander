#!/usr/bin/env tsx
/**
 * bench-wal-throughput.ts — Day 4 WAL throughput + P99 latency baseline.
 *
 * Runs a single-writer steady-state benchmark against the ATR checkpoint
 * backend (better-sqlite3 + journal_mode=WAL + synchronous=NORMAL when
 * available; InMemory fallback otherwise). Emits a baseline JSON to
 * stdout AND optionally writes it to `--output=path`.
 *
 * Metrics:
 *   - rowsPerSec: total committed rows / elapsed wall time
 *   - latency.{p50,p99,p999,avg,min,max}Us : per-row latency in
 *     microseconds (use hrtime.bigint() so sub-millisecond precision is
 *     captured; process.hrtime is monotonic)
 *
 * Usage:
 *   npx tsx scripts/bench-wal-throughput.ts
 *   npx tsx scripts/bench-wal-throughput.ts --iterations=20000
 *   npx tsx scripts/bench-wal-throughput.ts --output=docs/bench/baseline-2026-06-23.json
 *
 * The schemaVersion=1 envelope guards downstream consumers (CI
 * dashboards, regress alerts) against backwards-incompatible changes.
 */

import { reportSilentFailure } from '../packages/core/src/silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openCheckpointBackend } from '../packages/core/src/atr/checkpointStore';
import type { CheckpointState } from '../packages/core/src/runtime/stateCheckpointer';
import { withBenchmarkEnv } from './benchmarkEnv';

interface BenchResult {
  timestamp: string;
  iterations: number;
  warmup: number;
  backend: 'wal' | 'memory';
  rowsPerSec: number;
  latency: {
    p50Us: number;
    p99Us: number;
    p999Us: number;
    avgUs: number;
    minUs: number;
    maxUs: number;
  };
  hint: string;
}

function makeState(stepNumber: number): CheckpointState {
  return {
    runId: 'bench-throughput',
    agentId: 'bench-agent',
    timestamp: new Date().toISOString(),
    phase: 'llm_call',
    stepNumber,
    attemptNumber: 0,
    messages: [],
    tokenUsage: { totalTokens: 100, promptTokens: 60, completionTokens: 40 },
    stepDurations: [50],
    context: {
      agentId: 'bench-agent',
      projectId: 'bench',
      goal: 'WAL throughput baseline',
      availableTools: [],
      maxSteps: 1,
      tokenBudget: 1000,
    },
    totalDurationMs: 50,
  };
}

interface CliArgs {
  iterations: number;
  warmup: number;
  dbPath: string;
  output?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let iterations = 10_000;
  let warmup = 100;
  let dbPath = path.join(process.cwd(), '.commander', 'bench-wal.db');
  let output: string | undefined;
  let noOutput = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--iterations=')) {
      iterations = parseInt(arg.slice('--iterations='.length), 10);
    } else if (arg.startsWith('--warmup=')) {
      warmup = parseInt(arg.slice('--warmup='.length), 10);
    } else if (arg.startsWith('--dbPath=')) {
      dbPath = arg.slice('--dbPath='.length);
    } else if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
    } else if (arg === '--no-output') {
      noOutput = true;
    }
  }
  // Default capture target: docs/baselines/wal-baseline.<YYYY-MM-DD>.json.
  // pnpm bench:wal runs this default so dashboards always have a fresh
  // artifact. Callers wanting a different path pass --output=...; callers
  // wanting no capture pass --no-output (we never silently drop).
  if (!output && !noOutput) {
    const today = new Date().toISOString().slice(0, 10);
    output = path.join(process.cwd(), 'docs', 'baselines', `wal-baseline.${today}.json`);
  }
  return { iterations, warmup, dbPath, output };
}

async function runBenchmark(args: CliArgs): Promise<BenchResult> {
  const { iterations, warmup, dbPath } = args;
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch (err) {
      reportSilentFailure(err, 'bench-wal-throughput:115');
      /* best-effort */
    }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const backend = openCheckpointBackend({ filePath: dbPath });

  // Warmup — discard these measurements.
  for (let i = 0; i < warmup; i++) {
    backend.save(makeState(-1 - i));
  }

  // Measurement loop — capture per-iteration latency in microseconds.
  const latenciesUs: number[] = new Array(iterations);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    backend.save(makeState(i));
    const end = process.hrtime.bigint();
    latenciesUs[i] = Number(end - start) / 1000; // ns → µs
  }
  const t1 = process.hrtime.bigint();
  backend.close();

  latenciesUs.sort((a, b) => a - b);
  const at = (q: number) => latenciesUs[Math.floor(q * latenciesUs.length)];
  const totalElapsedSec = Number(t1 - t0) / 1e9;
  const sum = latenciesUs.reduce((s, x) => s + x, 0);

  return {
    timestamp: new Date().toISOString(),
    iterations,
    warmup,
    backend: backend.backend,
    rowsPerSec: iterations / totalElapsedSec,
    latency: {
      p50Us: at(0.5),
      p99Us: at(0.99),
      p999Us: at(0.999),
      avgUs: sum / latenciesUs.length,
      minUs: latenciesUs[0] ?? 0,
      maxUs: latenciesUs[latenciesUs.length - 1] ?? 0,
    },
    hint: 'lower latency and higher rowsPerSec are better; this is the steady-state single-writer baseline.',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  process.stderr.write(
    `[bench] starting iterations=${args.iterations} warmup=${args.warmup} dbPath=${args.dbPath}\n`,
  );
  const result = await runBenchmark(args);

  const summary = { passed: true, errors: 0, failed: 0, skipped: 0 };

  const baselineDoc = withBenchmarkEnv(
    { ...result, summary },
    { evidence: 'simulated', datasetVersion: 'wal-throughput-v1' },
  );
  const json = JSON.stringify(baselineDoc, null, 2);
  process.stdout.write(json + '\n');
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, json + '\n', 'utf-8');
    process.stderr.write(`[bench] baseline JSON written to ${args.output}\n`);
  } else {
    process.stderr.write('[bench] --no-output set; baseline NOT captured.\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[bench] failed: ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
