#!/usr/bin/env tsx
/**
 * bench-event-sourcing-replay.ts — EventSourcingEngine 重放性能 benchmark
 *
 * 写入 1k/10k/100k 事件后测量 replay() 的吞吐（events/sec）、
 * 端到端延迟、内存占用，以及带 snapshot 时的加速比。
 *
 * Usage:
 *   npx tsx scripts/bench-event-sourcing-replay.ts
 *   npx tsx scripts/bench-event-sourcing-replay.ts --output=docs/baselines/replay-baseline.json
 */
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import * as os from 'node:os';
import { withBenchmarkEnv } from './benchmarkEnv';

interface ReplayBenchResult {
  eventCount: number;
  appendTotalMs: number;
  appendPerEventMs: number;
  replayTotalMs: number;
  replayEventsPerSec: number;
  replayPerEventMs: number;
  verifyIntegrityMs: number;
  snapshotMs: number;
  replayFromSnapshotMs: number;
  snapshotSpeedup: number;
  heapUsedMB: number;
}

const SCALES = [1000, 10000, 100000];

async function main() {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/replay-baseline.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('EventSourcingEngine Replay Benchmark');
  console.log('═'.repeat(70));

  const { EventSourcingEngine } = await import('../packages/core/src/runtime/eventSourcingEngine');

  const results: ReplayBenchResult[] = [];

  for (const scale of SCALES) {
    // Use temp WAL file for each scale
    const walPath = resolve(os.tmpdir(), `commander-bench-replay-${scale}-${process.pid}.wal`);
    // Clean up any previous file
    try {
      unlinkSync(walPath);
    } catch {
      // ignore
    }

    const engine = new EventSourcingEngine({ walPath });
    await engine.init();

    // ── Phase 1: Append events ──
    const appendStart = Date.now();
    for (let i = 0; i < scale; i++) {
      await engine.append({
        type: i % 5 === 0 ? 'checkpoint' : 'tool_call',
        correlationId: `run-bench-${i % 100}`,
        payload: {
          step: i,
          tool: `tool_${i % 20}`,
          args: { input: `data-${i}` },
          result: { ok: true, value: i * 2 },
        },
      });
    }
    const appendTotalMs = Date.now() - appendStart;

    // ── Phase 2: Verify integrity ──
    const verifyStart = Date.now();
    const integrityOk = await engine.verifyIntegrity();
    const verifyIntegrityMs = Date.now() - verifyStart;

    // ── Phase 3: Full replay ──
    const replayStart = Date.now();
    let replayedCount = 0;
    await engine.replay((event) => {
      replayedCount++;
    });
    const replayTotalMs = Date.now() - replayStart;

    // ── Phase 4: Snapshot + replay from snapshot ──
    const snapshotStart = Date.now();
    const snapshotId = await engine.snapshot();
    const snapshotMs = Date.now() - snapshotStart;

    // Compact (remove events before snapshot)
    await engine.compact(snapshotId);

    const replayFromSnapshotStart = Date.now();
    let snapshotReplayedCount = 0;
    await engine.replay((event) => {
      snapshotReplayedCount++;
    });
    const replayFromSnapshotMs = Date.now() - replayFromSnapshotStart;

    const heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

    const result: ReplayBenchResult = {
      eventCount: scale,
      appendTotalMs,
      appendPerEventMs: appendTotalMs / scale,
      replayTotalMs,
      replayEventsPerSec: Math.round((replayedCount / replayTotalMs) * 1000),
      replayPerEventMs: replayTotalMs / replayedCount,
      verifyIntegrityMs,
      snapshotMs,
      replayFromSnapshotMs,
      snapshotSpeedup: replayFromSnapshotMs > 0 ? replayTotalMs / replayFromSnapshotMs : 0,
      heapUsedMB,
    };

    results.push(result);
    console.log(
      `  ${scale.toString().padStart(6)} events: ` +
        `append=${appendTotalMs}ms (${(appendTotalMs / scale).toFixed(3)}ms/evt)  ` +
        `replay=${replayTotalMs}ms (${result.replayEventsPerSec} evts/sec)  ` +
        `verify=${verifyIntegrityMs}ms  ` +
        `snapshot=${snapshotMs}ms  ` +
        `replay-from-snapshot=${replayFromSnapshotMs}ms (${result.snapshotSpeedup.toFixed(1)}x speedup)  ` +
        `heap=${heapUsedMB}MB`,
    );

    if (!integrityOk) {
      console.log(`  ⚠ WARNING: Integrity check FAILED at scale ${scale}`);
    }

    // Clean up temp WAL
    try {
      unlinkSync(walPath);
    } catch {
      // ignore
    }
  }

  console.log('═'.repeat(70));

  const midScale = results.find((r) => r.eventCount === 10000);
  const passed = midScale ? midScale.replayTotalMs <= 5000 : false;

  const summary = { passed, errors: 0, failed: 0, skipped: 0 };

  const baselineDoc = withBenchmarkEnv(
    {
      benchmark: 'event-sourcing-replay',
      results,
      summary,
      scale1k: results[0],
      scale10k: results[1],
      scale100k: results[2],
    },
    { evidence: 'simulated', datasetVersion: 'event-sourcing-replay-v1' },
  );

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baselineDoc, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  // Regression: 10k events should replay in < 5s
  if (midScale && midScale.replayTotalMs > 5000) {
    console.log(
      `⚠ WARNING: 10k event replay took ${midScale.replayTotalMs}ms (> 5000ms threshold)`,
    );
    process.exit(1);
  }
  console.log('✅ PASS: Replay benchmark within thresholds');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
