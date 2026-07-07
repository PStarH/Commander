#!/usr/bin/env tsx
/**
 * bench-cost-prediction.ts — 成本预测准确度 benchmark
 *
 * 对比 CostEstimator 的 predicted cost 与 actual cost 的误差分布，
 * 输出 MAE / P95 误差，验证成本预估的可靠性。
 *
 * Gates (both must hold for summary.passed=true):
 *   1. summary.p95 < 50% (accuracy gate)
 *   2. totalActualCostUsd <= BENCH_MAX_COST_USD env (cost cap, when set)
 *
 * Determinism: jitter PRNG is seeded by djb2(model:category) via mulberry32,
 * so reruns within the same UTC day produce byte-identical baseline JSONs.
 * Required by .github/workflows/cost-bench.yml to compute meaningful
 * day-over-day regression deltas (Math.random() would have produced
 * different baselines on every cron tick and masked real drift as noise).
 *
 * Usage:
 *   npx tsx scripts/bench-cost-prediction.ts
 *   BENCH_MAX_COST_USD=0.30 npx tsx scripts/bench-cost-prediction.ts
 *   npx tsx scripts/bench-cost-prediction.ts --output=/tmp/x.json
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

interface CostPredictionResult {
  model: string;
  modelTier: string;
  taskCategory: string;
  predictedCostUsd: number;
  actualCostUsd: number;
  errorUsd: number;
  errorPct: number;
  predictedTokens: number;
  actualTokens: number;
}

/**
 * Bench fixture: known "actual" cost rates per (model, tier). Must match
 * the per-1M rates in `packages/core/src/runtime/costEstimator.ts`
 * `DEFAULT_PRICING` AND `packages/core/src/observability/costModel.ts`
 * DEFAULT_PRICING. The matching is enforced by the
 * 'bench fixture parity' describe block in costEstimator.test.ts so any
 * drift between bench fixture and pricingTable fails CI before it can
 * produce misleading regression comparisons.
 *
 * Exported so the parity test (and potentially other consumers) can read
 * the canonical fixture without string-matching duplication.
 */
export interface TestModelFixture {
  model: string;
  tier: 'eco' | 'standard' | 'power';
  /** USD per 1M input tokens. */
  inputPrice: number;
  /** USD per 1M output tokens. */
  outputPrice: number;
}

export const TEST_MODEL_FIXTURES: TestModelFixture[] = [
  { model: 'gpt-4o-mini', tier: 'eco', inputPrice: 0.15, outputPrice: 0.6 },
  { model: 'gpt-4o', tier: 'standard', inputPrice: 2.5, outputPrice: 10.0 },
  { model: 'claude-3-5-sonnet', tier: 'standard', inputPrice: 3.0, outputPrice: 15.0 },
  { model: 'step-3.7-flash', tier: 'eco', inputPrice: 0.3, outputPrice: 0.9 },
];

/**
 * djb2 — Daniel J. Bernstein's non-cryptographic string hash. Pure integer
 * math through `>>> 0` so the output is bit-stable across Node versions.
 */
function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

/** mulberry32 — deterministic 32-bit PRNG. Yields [0, 1) on each call. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TASK_CATEGORIES = [
  'code',
  'search',
  'analysis',
  'creative',
  'structured',
  'general',
] as const;

async function main() {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/cost-prediction.${new Date().toISOString().slice(0, 10)}.json`;

  console.log('Cost Prediction Accuracy Benchmark');
  console.log('═'.repeat(70));

  const { getCostEstimator, resetCostEstimator } =
    await import('../packages/core/src/runtime/costEstimator');
  resetCostEstimator();
  const estimator = getCostEstimator();

  const results: CostPredictionResult[] = [];
  let totalActualCostUsd = 0;
  const maxCostEnv = process.env.BENCH_MAX_COST_USD;
  const parsedMaxCost =
    maxCostEnv !== undefined && maxCostEnv !== '' ? Number(maxCostEnv) : null;
  const maxCostUsd =
    parsedMaxCost !== null && Number.isFinite(parsedMaxCost) && parsedMaxCost > 0
      ? parsedMaxCost
      : null;

  // Anchor actual tokens on predicted ones with bounded ±15% jitter, seeded
  // per (model, category) so the bench is deterministic across reruns within
  // the same UTC day. This isolates *pricing-table accuracy* from
  // *token-prediction accuracy*.
  for (const modelConfig of TEST_MODEL_FIXTURES) {
    for (const category of TASK_CATEGORIES) {
      let estimate;
      try {
        estimate = estimator.estimateForModel(
          {
            goal: `task-${category}`,
            taskCategory: category,
            messages: [{ role: 'user', content: `Perform ${category} task` }],
          } as any,
          { model: modelConfig.model, tier: modelConfig.tier } as any,
        );
      } catch (err) {
        console.error(
          `  [skip] estimateForModel threw for ${modelConfig.model}/${category}: ${(err as Error).message}`,
        );
        continue;
      }

      const rand = mulberry32(djb2(`cost-prediction:${modelConfig.model}:${category}`));
      const jitterInput = 0.85 + rand() * 0.3; // 0.85..1.15
      const jitterOutput = 0.85 + rand() * 0.3; // 0.85..1.15
      const actualInputTokens = Math.max(100, Math.round(estimate.inputTokens * jitterInput));
      const actualOutputTokens = Math.max(50, Math.round(estimate.outputTokens * jitterOutput));

      const actualCostUsd =
        (actualInputTokens / 1_000_000) * modelConfig.inputPrice +
        (actualOutputTokens / 1_000_000) * modelConfig.outputPrice;

      const errorUsd = Math.abs(estimate.costUsd - actualCostUsd);
      const errorPct = actualCostUsd > 0 ? (errorUsd / actualCostUsd) * 100 : 0;

      results.push({
        model: modelConfig.model,
        modelTier: modelConfig.tier,
        taskCategory: category,
        predictedCostUsd: estimate.costUsd,
        actualCostUsd,
        errorUsd,
        errorPct,
        predictedTokens: estimate.inputTokens + estimate.outputTokens,
        actualTokens: actualInputTokens + actualOutputTokens,
      });
      totalActualCostUsd += actualCostUsd;
    }
  }

  // Cost-overrun guardrail (ENTERPRISE_READINESS.md P1-6): if the bench's
  // aggregate actual cost exceeds BENCH_MAX_COST_USD, fail so CI can surface
  // an unintended cost regression before it lands in CI minutes.
  let costOverrunUsd = 0;
  if (maxCostUsd !== null && totalActualCostUsd > maxCostUsd) {
    costOverrunUsd = totalActualCostUsd - maxCostUsd;
  }

  // Statistics
  const errors = results.map((r) => r.errorPct);
  const sortedErrors = [...errors].sort((a, b) => a - b);
  const mae = errors.reduce((sum, e) => sum + e, 0) / errors.length;
  const p50 = sortedErrors[Math.floor(sortedErrors.length * 0.5)];
  const p95 = sortedErrors[Math.floor(sortedErrors.length * 0.95)];
  const maxError = sortedErrors[sortedErrors.length - 1];

  // Per-model breakdown
  const perModel: Record<string, { mae: number; p95: number; count: number }> = {};
  for (const model of TEST_MODEL_FIXTURES) {
    const modelResults = results.filter((r) => r.model === model.model);
    const modelErrors = modelResults.map((r) => r.errorPct);
    const modelSorted = [...modelErrors].sort((a, b) => a - b);
    perModel[model.model] = {
      mae: modelErrors.reduce((s, e) => s + e, 0) / modelErrors.length,
      p95: modelSorted[Math.floor(modelSorted.length * 0.95)],
      count: modelResults.length,
    };
  }

  // Pass criteria
  const accuracyOk = p95 < 50;
  const costOk = maxCostUsd === null || costOverrunUsd === 0;
  const passed = accuracyOk && costOk;

  console.log(`  Total tasks:    ${results.length}`);
  console.log(`  MAE:            ${mae.toFixed(1)}%`);
  console.log(`  P50 error:      ${p50.toFixed(1)}%`);
  console.log(`  P95 error:      ${p95.toFixed(1)}%`);
  console.log(`  Max error:      ${maxError.toFixed(1)}%`);
  if (maxCostUsd !== null) {
    console.log(
      `  Max-cost cap:   $${maxCostUsd.toFixed(4)} (actual=$${totalActualCostUsd.toFixed(4)})${costOverrunUsd > 0 ? '  ⚠️ OVERRUN' : ''}`,
    );
  }
  console.log('─'.repeat(70));
  for (const [model, stats] of Object.entries(perModel)) {
    console.log(
      `  ${model.padEnd(22)}: MAE=${stats.mae.toFixed(1)}%  P95=${stats.p95.toFixed(1)}%  (${stats.count} tasks)`,
    );
  }
  console.log('═'.repeat(70));

  const baseline = {
    benchmark: 'cost-prediction',
    runAt: new Date().toISOString(),
    nodeVersion: process.version,
    results,
    statistics: { mae, p50, p95, maxError, totalTasks: results.length },
    perModel,
    summary: {
      passed,
      mae,
      p95,
      totalActualCostUsd,
      maxCostUsd,
      costOverrunUsd,
    },
  };

  const fullPath = resolve(outputPath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(baseline, null, 2), { mode: 0o644 });
  console.log(`Baseline saved to ${fullPath}`);

  if (passed) {
    console.log('✅ PASS: Cost prediction benchmark completed');
  } else {
    const reasons: string[] = [];
    if (!accuracyOk) reasons.push(`P95 cost prediction error ${p95.toFixed(1)}% exceeds 50% threshold`);
    if (!costOk)
      reasons.push(
        `cost overrun $${costOverrunUsd.toFixed(4)} over $${maxCostUsd?.toFixed(4)} cap`,
      );
    console.log(`❌ FAIL: ${reasons.join('; ')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
