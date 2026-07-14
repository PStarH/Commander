/**
 * Synthetic scale harness stub — Architecture V2.
 *
 * Exercises claim/wake admission under high churn without calling LLMs.
 * Target: demonstrate worker pool can claim N runs/sec for capacity planning
 * toward millions of executions/day.
 *
 * Usage:
 *   npx tsx scripts/bench-worker-claim-throughput.ts --runs=1000
 */

import { RunLedger } from '../packages/core/src/atr/runLedger';
import { LeaseManager } from '../packages/core/src/atr/leaseManager';
import { IdempotencyStore } from '../packages/core/src/atr/idempotencyStore';
import { ExecutionScheduler } from '../packages/core/src/atr/scheduler';
import { withBenchmarkEnv } from './benchmarkEnv';

function parseArgs() {
  const runs = Number(
    process.argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) ?? 500,
  );
  return { runs: Number.isFinite(runs) && runs > 0 ? runs : 500 };
}

function main() {
  const { runs } = parseArgs();
  const lease = new LeaseManager({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'bench',
  });
  const idempotency = new IdempotencyStore({
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    evictEveryOps: 1_000_000,
    maxRecords: 1_000_000,
  });
  const ledger = new RunLedger(lease, idempotency, {
    filePath: ':memory:',
    defaultTtlSeconds: 60,
    defaultHolder: 'bench',
    defaultIdempotencyTtlSeconds: 60,
  });
  const scheduler = new ExecutionScheduler({ lease, idempotency, ledger });

  const t0 = Date.now();
  for (let i = 0; i < runs; i++) {
    // Create PENDING without beginExecuting so claimNextRun can pick them up.
    ledger.start({
      runId: `bench-${i}`,
      intentHash: `hash-${i}`,
    });
  }
  const enqueueMs = Date.now() - t0;

  const t1 = Date.now();
  let claimed = 0;
  for (;;) {
    const h = scheduler.claimNextRun();
    if (!h) break;
    claimed++;
    scheduler.commitRun({
      runId: h.runId,
      leaseToken: h.leaseToken,
      fencingEpoch: h.fencingEpoch,
    });
  }
  const claimMs = Date.now() - t1;

  const claimsPerSec = claimMs > 0 ? (claimed / claimMs) * 1000 : claimed;
  const projectedDay = claimsPerSec * 86_400;

  const report = withBenchmarkEnv(
    {
      benchmark: 'worker-claim-throughput',
      runs,
      claimed,
      enqueueMs,
      claimMs,
      claimsPerSec: Math.round(claimsPerSec),
      projectedExecutionsPerDay: Math.round(projectedDay),
      note: 'Synthetic claim/commit only — not full agent-loop throughput',
    },
    { evidence: 'simulated' },
  );
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main();
