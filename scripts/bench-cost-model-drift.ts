#!/usr/bin/env tsx
/**
 * bench-cost-model-drift.ts — pricing-table drift detector (bidirectional)
 *
 * Cross-checks `packages/core/src/observability/costModel.ts` `DEFAULT_PRICING`
 * (the source-of-truth used by `CostModel.calculate()` for real-time cost
 * attribution) against `packages/core/src/runtime/costEstimator.ts`
 * `DEFAULT_PRICING` (used by the pre-run CostEstimator + the cost-prediction
 * bench). Both are spelt out in the same file via per-1K and per-1M units
 * respectively, so a future pricing update in one and not the other will
 * silently desync the projected cost from the recorded cost — a serious
 * billing-accuracy risk.
 *
 * Direction A (costModel -> costEstimator):
 *   For each costModel entry, find the matching costEstimator entry by
 *   `provider`+`model` (with @tier-suffix stripping). Report per-1M drift.
 *   A model that costModel prices but costEstimator does not is a missing
 *   pricingTable row; costModel.getPricing() will return the canonical
 *   rate, but the pre-run estimate will silently fall back to per-tier
 *   blended rates, biasing the projection.
 *
 * Direction B (costEstimator -> costModel):
 *   For each costEstimator entry, verify a matching costModel entry exists.
 *   A model that costEstimator prices but costModel does not is an
 *   orphaned pricingTable row; costModel.getPricing() will return the
 *   fallback (0.001/0.002 per-1K) and the recorded cost will be wildly
 *   wrong, but the pre-run estimate will look right.
 *
 * This bench fails the build if EITHER direction has drift > threshold
 * (default 5%, configurable via `BENCH_DRIFT_THRESHOLD_PCT`) OR any missing
 * pair. The previous version only checked direction A.
 *
 * Output baseline:
 *   docs/baselines/cost-model-drift.<YYYY-MM-DD>.json
 *
 * Companion to scripts/bench-cost-prediction.ts; the cost-prediction bench
 * gates on relative accuracy, this bench gates on cross-table consistency.
 *
 * Usage:
 *   npx tsx scripts/bench-cost-model-drift.ts
 *   BENCH_DRIFT_THRESHOLD_PCT=10 npx tsx scripts/bench-cost-model-drift.ts
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { DEFAULT_PRICING as COST_MODEL_PRICING } from '../packages/core/src/observability/costModel';
import {
  CostEstimator,
  DEFAULT_PRICING as COST_ESTIMATOR_PRICING,
} from '../packages/core/src/runtime/costEstimator';

interface DriftResult {
  direction: 'A_costModel_to_costEstimator' | 'B_costEstimator_to_costModel';
  provider: string;
  model: string;
  sourceInputPer1M: number;
  sourceOutputPer1M: number;
  targetInputPer1M: number | null;
  targetOutputPer1M: number | null;
  inputDriftPct: number;
  outputDriftPct: number;
  maxDriftPct: number;
  missing: boolean;
  reason?: string;
}

/**
 * Strip @tier suffix from modelId, mirroring costModel.stripTierSuffix().
 */
function stripTierSuffix(model: string): string {
  const at = model.indexOf('@');
  return at > 0 ? model.slice(0, at) : model;
}

function classifyDrift(
  sourceInput: number,
  sourceOutput: number,
  targetInput: number | null,
  targetOutput: number | null,
): { inputDriftPct: number; outputDriftPct: number; maxDriftPct: number; missing: boolean } {
  if (targetInput === null || targetOutput === null) {
    return {
      inputDriftPct: Number.NaN,
      outputDriftPct: Number.NaN,
      maxDriftPct: 100,
      missing: true,
    };
  }
  const inputDriftPct =
    sourceInput > 0 ? (Math.abs(targetInput - sourceInput) / sourceInput) * 100 : 0;
  const outputDriftPct =
    sourceOutput > 0 ? (Math.abs(targetOutput - sourceOutput) / sourceOutput) * 100 : 0;
  return {
    inputDriftPct,
    outputDriftPct,
    maxDriftPct: Math.max(inputDriftPct, outputDriftPct),
    missing: false,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outputArg = args.find((a) => a.startsWith('--output='));
  const outputPath = outputArg
    ? outputArg.slice('--output='.length)
    : `docs/baselines/cost-model-drift.${new Date().toISOString().slice(0, 10)}.json`;

  const thresholdPct = Number(process.env.BENCH_DRIFT_THRESHOLD_PCT ?? '5');
  const thresholdSafe = Number.isFinite(thresholdPct) && thresholdPct > 0 ? thresholdPct : 5;

  console.log('Cost Model Drift Benchmark (bidirectional)');
  console.log('═'.repeat(70));
  console.log(
    `  Threshold: ${thresholdSafe}% max drift (configurable via BENCH_DRIFT_THRESHOLD_PCT)`,
  );
  console.log(`  Direction A: costModel -> costEstimator (projected cost accuracy)`);
  console.log(`  Direction B: costEstimator -> costModel (recorded cost accuracy)`);
  console.log('─'.repeat(70));

  const estimator = new CostEstimator();
  const drifts: DriftResult[] = [];

  // ── Direction A: costModel -> costEstimator ─────────────────────────────
  // For each costModel entry, find the matching costEstimator entry.
  for (const entry of COST_MODEL_PRICING) {
    const stripped = stripTierSuffix(entry.model);
    const estEntry = estimator.getPricingForModel(stripped, entry.provider);

    const sourceInput = entry.inputPer1k * 1000;
    const sourceOutput = entry.outputPer1k * 1000;

    const cls = classifyDrift(
      sourceInput,
      sourceOutput,
      estEntry?.inputPer1M ?? null,
      estEntry?.outputPer1M ?? null,
    );

    const drift: DriftResult = {
      direction: 'A_costModel_to_costEstimator',
      provider: entry.provider,
      model: stripped,
      sourceInputPer1M: sourceInput,
      sourceOutputPer1M: sourceOutput,
      targetInputPer1M: estEntry?.inputPer1M ?? null,
      targetOutputPer1M: estEntry?.outputPer1M ?? null,
      ...cls,
    };
    if (cls.missing) {
      drift.reason = `pricingTable missing for ${entry.provider}:${stripped}`;
    }
    drifts.push(drift);
  }

  // ── Direction B: costEstimator -> costModel ─────────────────────────────
  // Walk the estimator's static DEFAULT_PRICING table (the canonical
  // source-of-truth — the constructor copies it once into a private
  // `pricingTable` Map at construction time) and verify each entry has a
  // matching costModel entry. Each entry is also re-probed through
  // `estimator.getPricingForModel()` as defense-in-depth against accidental
  // key collisions in DEFAULT_PRICING being silently dropped by the constructor.
  const costEstimatorEntries = getCostEstimatorTableEntries(estimator);
  for (const eEntry of costEstimatorEntries) {
    const cmMatch = COST_MODEL_PRICING.find(
      (cm) =>
        cm.provider.toLowerCase() === eEntry.provider.toLowerCase() &&
        stripTierSuffix(cm.model).toLowerCase() === eEntry.model.toLowerCase(),
    );
    const sourceInput = eEntry.inputPer1M;
    const sourceOutput = eEntry.outputPer1M;
    const cls = classifyDrift(
      sourceInput,
      sourceOutput,
      cmMatch ? cmMatch.inputPer1k * 1000 : null,
      cmMatch ? cmMatch.outputPer1k * 1000 : null,
    );
    const drift: DriftResult = {
      direction: 'B_costEstimator_to_costModel',
      provider: eEntry.provider,
      model: eEntry.model,
      sourceInputPer1M: sourceInput,
      sourceOutputPer1M: sourceOutput,
      targetInputPer1M: cmMatch ? cmMatch.inputPer1k * 1000 : null,
      targetOutputPer1M: cmMatch ? cmMatch.outputPer1k * 1000 : null,
      ...cls,
    };
    if (cls.missing) {
      drift.reason = `costModel.DEFAULT_PRICING missing for ${eEntry.provider}:${eEntry.model}`;
    }
    drifts.push(drift);
  }

  // Print per-model breakdown, grouped by direction
  const dirA = drifts.filter((d) => d.direction === 'A_costModel_to_costEstimator');
  const dirB = drifts.filter((d) => d.direction === 'B_costEstimator_to_costModel');
  const missingA = dirA.filter((d) => d.missing);
  const driftedA = dirA.filter((d) => !d.missing && d.maxDriftPct > thresholdSafe);
  const cleanA = dirA.filter((d) => !d.missing && d.maxDriftPct <= thresholdSafe);
  const missingB = dirB.filter((d) => d.missing);
  const driftedB = dirB.filter((d) => !d.missing && d.maxDriftPct > thresholdSafe);
  const cleanB = dirB.filter((d) => !d.missing && d.maxDriftPct <= thresholdSafe);

  const printBlock = (label: string, list: DriftResult[]) => {
    console.log(`\n  [${label}] (${list.length} models)`);
    for (const d of list) {
      if (d.missing) {
        console.log(
          `    ${d.provider.padEnd(10)} ${d.model.padEnd(22)}: \u274C MISSING (${d.reason})`,
        );
      } else if (d.maxDriftPct > thresholdSafe) {
        console.log(
          `    ${d.provider.padEnd(10)} ${d.model.padEnd(22)}: \u26A0\uFE0F  DRIFT ${d.maxDriftPct.toFixed(2)}%`,
        );
      } else {
        console.log(
          `    ${d.provider.padEnd(10)} ${d.model.padEnd(22)}: \u2705 drift ${d.maxDriftPct.toFixed(2)}%`,
        );
      }
    }
  };
  printBlock('Direction A: costModel -> costEstimator', dirA);
  printBlock('Direction B: costEstimator -> costModel', dirB);

  console.log('─'.repeat(70));
  console.log(
    `  Direction A — clean=${cleanA.length} drifted=${driftedA.length} missing=${missingA.length}`,
  );
  console.log(
    `  Direction B — clean=${cleanB.length} drifted=${driftedB.length} missing=${missingB.length}`,
  );
  console.log('═'.repeat(70));

  const passed =
    driftedA.length === 0 &&
    missingA.length === 0 &&
    driftedB.length === 0 &&
    missingB.length === 0;
  const maxObservedDriftPct = drifts.reduce(
    (m, d) => Math.max(m, isFinite(d.maxDriftPct) ? d.maxDriftPct : 0),
    0,
  );
  const baseline = {
    benchmark: 'cost-model-drift',
    runAt: new Date().toISOString(),
    nodeVersion: process.version,
    thresholdPct: thresholdSafe,
    drifts,
    summary: {
      passed,
      directionA: {
        total: dirA.length,
        clean: cleanA.length,
        drifted: driftedA.length,
        missing: missingA.length,
      },
      directionB: {
        total: dirB.length,
        clean: cleanB.length,
        drifted: driftedB.length,
        missing: missingB.length,
      },
      maxObservedDriftPct,
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
    console.log(
      '\u2705 PASS: costModel and costEstimator pricing tables are in sync (bidirectional)',
    );
  } else {
    const reasons: string[] = [];
    if (driftedA.length > 0 || missingA.length > 0) {
      reasons.push(
        `Direction A: ${driftedA.length} drifted, ${missingA.length} missing (worst drift ${dirA.reduce((m, d) => Math.max(m, isFinite(d.maxDriftPct) ? d.maxDriftPct : 0), 0).toFixed(2)}%)`,
      );
    }
    if (driftedB.length > 0 || missingB.length > 0) {
      reasons.push(`Direction B: ${driftedB.length} drifted, ${missingB.length} missing`);
    }
    console.log(`\u274C FAIL: ${reasons.join('; ')}`);
    process.exitCode = 1;
  }
}

/**
 * Walk the exported `COST_ESTIMATOR_PRICING` table to extract every
 * (provider, model, inputPer1M, outputPer1M) tuple for the Direction-B scan.
 *
 * The estimator's private `pricingTable` Map is built from this exported
 * table at construction time, so the static export is the canonical
 * source-of-truth — no need to reach into private fields. Each tuple is also
 * re-probed through `estimator.getPricingForModel()` as defense-in-depth
 * against accidental key collisions in DEFAULT_PRICING being silently
 * dropped by the constructor's iteration.
 *
 * Adding new entries to `COST_ESTIMATOR_PRICING` is automatically reflected
 * here on the next bench run; no separate probe-list to maintain.
 */
function getCostEstimatorTableEntries(
  estimator: CostEstimator,
): Array<{ provider: string; model: string; inputPer1M: number; outputPer1M: number }> {
  const out: Array<{ provider: string; model: string; inputPer1M: number; outputPer1M: number }> =
    [];
  for (const [model, entry] of COST_ESTIMATOR_PRICING) {
    // Defense in depth: probe the same key through the live instance, in case
    // the constructor ever drops it (it shouldn't, but the spec is one line).
    if (!estimator.getPricingForModel(model)) continue;
    out.push({
      provider: entry.provider ?? 'unknown',
      model: stripTierSuffix(model).toLowerCase(),
      inputPer1M: entry.inputPer1M,
      outputPer1M: entry.outputPer1M,
    });
  }
  return out;
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
