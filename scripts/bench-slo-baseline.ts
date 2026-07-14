#!/usr/bin/env tsx
/**
 * bench-slo-baseline.ts — SLO 回归 baseline 生成脚本
 *
 * 测量 4 项 SLO 指标（recovery / failover / compensation / dlq），
 * 输出 JSON baseline 供 bench-slo-regress.ts 做回归检测。
 *
 * Gate (all 4 must pass):
 *   recovery < 5s, failover < 10s, compensation < 30s, dlq < 60s
 *
 * Throws inside the measurement loop are recorded as `actualMs: NaN,
 * passed: false, reason: <err.message>` so the bench can never silently
 * greenlight a real failure. The previous version assigned
 * `actualMs: 0, passed: true` inside the catch block, which let
 * RunRecovery / RunCompensation / DeadLetterQueue wiring regressions
 * slip past CI. Mirrors the same fail-loud pattern that
 * scripts/bench-cost-prediction.ts uses for `process.exitCode = 1`.
 *
 * Usage:
 *   npx tsx scripts/bench-slo-baseline.ts
 *   npx tsx scripts/bench-slo-baseline.ts --output=docs/baselines/slo-baseline.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fork } from 'node:child_process';
import * as net from 'node:net';
import { withBenchmarkEnv } from './benchmarkEnv';

const SLO_THRESHOLDS = {
  recovery: 5000,
  failover: 10000,
  compensation: 30000,
  dlq: 60000,
} as const;

async function measureLatency<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

/**
 * Measure real failover RTO by forking a primary worker that binds a TCP port,
 * SIGKILL-ing it, and timing how long until a secondary server can reclaim that
 * same port. This exercises OS-level socket teardown / process reclaim rather
 * than just measuring a message round-trip.
 */
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

function measureFailoverRTO(): Promise<number> {
  return new Promise((resolve, reject) => {
    reserveEphemeralPort()
      .then((port) => {
        const worker = fork('./scripts/bench-failover-worker.js', [String(port)]);
        let killedAt = 0;

        worker.on('message', (msg: any) => {
          if (msg?.type === 'ready' && msg.port === port) {
            killedAt = Date.now();
            worker.kill('SIGKILL');
          }
        });

        worker.on('error', reject);

        worker.on('exit', () => {
          if (killedAt === 0) {
            reject(new Error('Primary worker exited before sending ready message'));
            return;
          }

          // Attempt to reclaim the port as the secondary server.
          const tryReclaim = () => {
            const secondary = net.createServer();
            secondary.once('error', (err: any) => {
              if (err.code === 'EADDRINUSE') {
                setImmediate(tryReclaim);
                return;
              }
              reject(err);
            });
            secondary.listen(port, '127.0.0.1', () => {
              const rto = Date.now() - killedAt;
              secondary.close(() => resolve(rto));
            });
          };
          tryReclaim();
        });
      })
      .catch(reject);
  });
}

interface SloMeasurement {
  name: string;
  actualMs: number;
  thresholdMs: number;
  passed: boolean;
  reason?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/slo-baseline.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('SLO Baseline Benchmark');
  console.log('═'.repeat(70));
  console.log('  Thresholds: recovery<5s  failover<10s  compensation<30s  dlq<60s');
  console.log('═'.repeat(70));

  const measurements: SloMeasurement[] = [];

  // ── 1. Recovery SLO ──
  try {
    const { RunRecovery } = await import('../packages/core/src/runtime/runRecovery');
    const { StateCheckpointer } = await import('../packages/core/src/runtime/stateCheckpointer');
    const { LeaseManager } = await import('../packages/core/src/atr/leaseManager');
    const checkpointer = new StateCheckpointer();
    checkpointer.checkpoint({
      runId: 'run-slo-bench',
      agentId: 'bench-agent',
      timestamp: new Date().toISOString(),
      phase: 'tool_execution',
      stepNumber: 5,
      attemptNumber: 1,
      messages: [],
      tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      stepDurations: [10, 20, 30, 40, 50],
      context: {
        agentId: 'bench-agent',
        projectId: 'slo-bench',
        goal: 'measure recovery SLO',
        availableTools: [],
        maxSteps: 10,
        tokenBudget: 8000,
      },
      totalDurationMs: 0,
    });
    const leaseManager = new LeaseManager({ defaultTtlSeconds: 300 });
    const recovery = new RunRecovery(checkpointer, leaseManager);
    const { durationMs } = await measureLatency(() => recovery.attempt('run-slo-bench'));
    measurements.push({
      name: 'recovery',
      actualMs: durationMs,
      thresholdMs: SLO_THRESHOLDS.recovery,
      passed: durationMs < SLO_THRESHOLDS.recovery,
    });
    console.log(
      `  recovery:       ${durationMs}ms  ${durationMs < SLO_THRESHOLDS.recovery ? '✅' : '❌'}`,
    );
  } catch (err) {
    const reason = (err as Error).message;
    console.log(`  recovery:       FAIL — ${reason}`);
    measurements.push({
      name: 'recovery',
      actualMs: Number.NaN,
      thresholdMs: SLO_THRESHOLDS.recovery,
      passed: false,
      reason,
    });
  }

  // ── 2. Failover SLO (simulated kill / reclaim RTO) ──
  try {
    const durationMs = await measureFailoverRTO();
    measurements.push({
      name: 'failover_rto_simulated',
      actualMs: durationMs,
      thresholdMs: SLO_THRESHOLDS.failover,
      passed: durationMs < SLO_THRESHOLDS.failover,
    });
    console.log(
      `  failover_rto_simulated: ${durationMs}ms  ${durationMs < SLO_THRESHOLDS.failover ? '✅' : '❌'}`,
    );
  } catch (err) {
    const reason = (err as Error).message;
    console.log(`  failover_rto_simulated: FAIL — ${reason}`);
    measurements.push({
      name: 'failover_rto_simulated',
      actualMs: Number.NaN,
      thresholdMs: SLO_THRESHOLDS.failover,
      passed: false,
      reason,
    });
  }

  // ── 3. Compensation SLO ──
  try {
    const { CompensationRegistry } =
      await import('../packages/core/src/runtime/compensationRegistry');
    const registry = new CompensationRegistry();
    // Single representative handler is enough — `compensateAll()` iterates
    // `pendingActions`, not handlers, and the throughput measurement only
    // needs ONE register() call to exercise the retry/enqueue path. The 50x
    // loop was a leftover from the first bench version and adds nothing.
    registry.register('noop-action', async () => ({ success: true }));
    for (let i = 0; i < 50; i++) {
      registry.recordAction({
        actionId: `pending-${i}`,
        toolName: 'noop-action',
        args: { i },
        description: `bench-dummy-${i}`,
        tags: ['bench'],
      });
    }
    const { durationMs } = await measureLatency(() => registry.compensateAll());
    measurements.push({
      name: 'compensation',
      actualMs: durationMs,
      thresholdMs: SLO_THRESHOLDS.compensation,
      passed: durationMs < SLO_THRESHOLDS.compensation,
    });
    console.log(
      `  compensation:   ${durationMs}ms  ${durationMs < SLO_THRESHOLDS.compensation ? '✅' : '❌'}`,
    );
  } catch (err) {
    const reason = (err as Error).message;
    console.log(`  compensation:   FAIL — ${reason}`);
    measurements.push({
      name: 'compensation',
      actualMs: Number.NaN,
      thresholdMs: SLO_THRESHOLDS.compensation,
      passed: false,
      reason,
    });
  }

  // ── 4. DLQ SLO ──
  try {
    const { DeadLetterQueue } = await import('../packages/core/src/runtime/deadLetterQueue');
    const { resetDeadLetterQueue } =
      await import('../packages/core/src/runtime/deadLetterQueueSingleton');
    resetDeadLetterQueue();
    const dlq = new DeadLetterQueue();
    for (let i = 0; i < 100; i++) {
      dlq.record({
        id: `dlq-bench-${i}`,
        category: 'execution',
        runId: `run-bench-${i}`,
        agentId: 'bench-agent',
        timestamp: new Date().toISOString(),
        errorClass: 'TransientError',
        errorMessage: `error-${i}`,
        retryable: true,
        attemptNumber: i,
        operationName: 'benchmark_op',
      });
    }
    const { durationMs } = await measureLatency(async () => {
      dlq.flush('execution');
      return dlq.readEntries('execution');
    });
    measurements.push({
      name: 'dlq',
      actualMs: durationMs,
      thresholdMs: SLO_THRESHOLDS.dlq,
      passed: durationMs < SLO_THRESHOLDS.dlq,
    });
    console.log(
      `  dlq:            ${durationMs}ms  ${durationMs < SLO_THRESHOLDS.dlq ? '✅' : '❌'}`,
    );
  } catch (err) {
    const reason = (err as Error).message;
    console.log(`  dlq:            FAIL — ${reason}`);
    measurements.push({
      name: 'dlq',
      actualMs: Number.NaN,
      thresholdMs: SLO_THRESHOLDS.dlq,
      passed: false,
      reason,
    });
  }

  console.log('═'.repeat(70));

  // Belt-and-suspenders: a future regression that re-introduces a `NaN +
  // passed=true` combo (the silent-PASS pattern this rewrite eliminated) must
  // throw before we serialize the baseline. This guard costs nothing on the
  // happy path because every successful measurement has Number.isFinite()
  // actualMs by construction (Date.now() arithmetic).
  for (const m of measurements) {
    if (m.passed && !Number.isFinite(m.actualMs)) {
      throw new Error(
        `bench-slo-baseline integrity violation: ${m.name} has passed=true but actualMs=${m.actualMs} (not finite). ` +
          `This is the silent-PASS anti-pattern; do not let a catch-block re-introduce it.`,
      );
    }
  }

  const failed = measurements.filter((m) => !m.passed);

  const baseline = withBenchmarkEnv(
    {
      benchmark: 'slo',
      thresholds: SLO_THRESHOLDS,
      measurements,
      summary: {
        passed: failed.length === 0,
        total: measurements.length,
        passedCount: measurements.length - failed.length,
        failed: failed.length,
      },
    },
    { evidence: 'simulated', datasetVersion: 'slo-v1' },
  );

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  if (failed.length > 0) {
    const failedNames = failed
      .map((m) => `${m.name}${m.reason ? ` (${m.reason})` : ''}`)
      .join(', ');
    console.log(`❌ FAIL: ${failed.length} SLO(s) exceeded threshold or threw: ${failedNames}`);
    process.exitCode = 1;
  } else {
    console.log('✅ PASS: All SLOs within thresholds');
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
