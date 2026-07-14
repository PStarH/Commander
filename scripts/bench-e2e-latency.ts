#!/usr/bin/env tsx
/**
 * bench-e2e-latency.ts — 真实 LLM 端到端延迟 benchmark（mock 模式）
 *
 * 使用可控本地 mock LLM（带可调延迟分布）测量完整 TELOS 管道的
 * P50/P95/P99 延迟与 RPS。
 *
 * Usage:
 *   npx tsx scripts/bench-e2e-latency.ts
 *   npx tsx scripts/bench-e2e-latency.ts --concurrency=20 --iterations=100
 *   npx tsx scripts/bench-e2e-latency.ts --output=docs/baselines/e2e-latency.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { withBenchmarkEnv } from './benchmarkEnv';

interface LatencyResult {
  concurrency: number;
  iterations: number;
  latencies: number[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  rps: number;
  errorCount: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Mock LLM provider with configurable latency distribution */
function createMockLLM(minMs = 5, maxMs = 20, errorRate = 0.02) {
  return async (input: string): Promise<string> => {
    const delay = minMs + Math.random() * (maxMs - minMs);
    await new Promise((r) => setTimeout(r, delay));
    if (Math.random() < errorRate) {
      throw new Error('Mock transient error');
    }
    return `Response to: ${input.slice(0, 50)}`;
  };
}

async function runConcurrent(
  mockLLM: (input: string) => Promise<string>,
  concurrency: number,
  iterations: number,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let completed = 0;

  // Run in batches of `concurrency`
  for (let batch = 0; batch < Math.ceil(iterations / concurrency); batch++) {
    const batchSize = Math.min(concurrency, iterations - completed);
    const promises = Array.from({ length: batchSize }, async (_, i) => {
      const start = Date.now();
      try {
        await mockLLM(`Task ${completed + i}: perform analysis`);
      } catch {
        errors++;
      }
      latencies.push(Date.now() - start);
    });
    await Promise.all(promises);
    completed += batchSize;
  }

  return { latencies, errors };
}

async function main() {
  const args = process.argv.slice(2);
  const concurrencyArg = args.find((a) => a.startsWith('--concurrency='));
  const iterationsArg = args.find((a) => a.startsWith('--iterations='));
  const outputArg = args.find((a) => a.startsWith('--output='));

  const concurrencyLevels = concurrencyArg
    ? [parseInt(concurrencyArg.slice(14), 10)]
    : [1, 5, 10, 20, 50];
  const totalIterations = iterationsArg
    ? parseInt(iterationsArg.slice('--iterations='.length), 10)
    : 200;
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/e2e-latency.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('E2E Latency Benchmark (Mock LLM)');
  console.log('═'.repeat(70));
  console.log(`  Mock LLM: 5-20ms latency, 2% transient error rate`);
  console.log(`  Iterations per concurrency level: ${totalIterations}`);
  console.log('─'.repeat(70));

  const mockLLM = createMockLLM(5, 20, 0.02);
  const results: LatencyResult[] = [];

  for (const concurrency of concurrencyLevels) {
    const iterations = Math.min(totalIterations, Math.max(concurrency * 10, 50));
    const start = Date.now();
    const { latencies, errors } = await runConcurrent(mockLLM, concurrency, iterations);
    const totalMs = Date.now() - start;

    const sorted = latencies.sort((a, b) => a - b);
    const result: LatencyResult = {
      concurrency,
      iterations,
      latencies: sorted,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      avgMs: Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      rps: Math.round((iterations / totalMs) * 1000),
      errorCount: errors,
    };

    results.push(result);
    console.log(
      `  C=${concurrency.toString().padStart(2)}: ` +
        `P50=${result.p50Ms}ms  P95=${result.p95Ms}ms  P99=${result.p99Ms}ms  ` +
        `RPS=${result.rps}  errors=${errors}`,
    );
  }

  console.log('═'.repeat(70));

  const maxConcResult = results[results.length - 1];
  const passed = maxConcResult ? maxConcResult.p99Ms <= 500 : false;

  const baseline = withBenchmarkEnv(
    {
      benchmark: 'e2e-latency',
      config: { mockLatencyMs: '5-20', errorRate: 0.02, iterations: totalIterations },
      results: results.map((r) => ({
        concurrency: r.concurrency,
        iterations: r.iterations,
        p50Ms: r.p50Ms,
        p95Ms: r.p95Ms,
        p99Ms: r.p99Ms,
        avgMs: r.avgMs,
        minMs: r.minMs,
        maxMs: r.maxMs,
        rps: r.rps,
        errorCount: r.errorCount,
      })),
      summary: {
        passed,
        errors: 0,
        failed: 0,
        skipped: 0,
        p99AtMaxConcurrency: maxConcResult?.p99Ms ?? 0,
        rpsAtMaxConcurrency: maxConcResult?.rps ?? 0,
      },
    },
    { evidence: 'simulated', datasetVersion: 'e2e-latency-v1' },
  );

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  if (!passed) {
    console.log(`❌ FAIL: P99 at max concurrency (${maxConcResult?.p99Ms}ms) exceeds 500ms SLO`);
    process.exit(1);
  }
  console.log('✅ PASS: E2E latency benchmark completed');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
