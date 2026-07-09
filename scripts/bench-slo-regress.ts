#!/usr/bin/env tsx
/**
 * bench-slo-regress.ts — SLO 回归检测脚本
 *
 * 对比今日 SLO baseline 与昨日 baseline，检测延迟回归。
 * 默认阈值：任何指标恶化超过 25% 即判定为回归。
 *
 * Usage:
 *   npx tsx scripts/bench-slo-regress.ts
 *   npx tsx scripts/bench-slo-regress.ts --today=docs/baselines/slo-baseline.2026-07-06.json --yesterday=docs/baselines/slo-baseline.2026-07-05.json
 *   REGRESSION_THRESHOLD_PCT=30 npx tsx scripts/bench-slo-regress.ts
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const THRESHOLD_PCT = parseInt(process.env.REGRESSION_THRESHOLD_PCT ?? '25', 10);

interface SLOBaseline {
  benchmark: string;
  runAt: string;
  measurements: Array<{ name: string; actualMs: number; thresholdMs: number; passed: boolean }>;
}

function findLatestBaseline(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .reverse();
  return files.length > 0 ? resolve(dir, files[0]) : null;
}

function loadBaseline(path: string): SLOBaseline | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const todayArg = args.find((a) => a.startsWith('--today='));
  const yesterdayArg = args.find((a) => a.startsWith('--yesterday='));

  const baselinesDir = resolve('docs/baselines');

  const todayPath =
    todayArg?.slice('--today='.length) ?? findLatestBaseline(baselinesDir, 'slo-baseline.');
  if (!todayPath) {
    console.error('ERROR: No SLO baseline found. Run bench-slo-baseline.ts first.');
    process.exit(2);
  }

  // Find yesterday's baseline (second most recent)
  let yesterdayPath = yesterdayArg?.slice('--yesterday='.length);
  if (!yesterdayPath) {
    if (existsSync(baselinesDir)) {
      const files = readdirSync(baselinesDir)
        .filter((f) => f.startsWith('slo-baseline.') && f.endsWith('.json'))
        .sort()
        .reverse();
      if (files.length >= 2) {
        yesterdayPath = resolve(baselinesDir, files[1]);
      }
    }
  }

  const today = loadBaseline(todayPath);
  if (!today) {
    console.error(`ERROR: Cannot load today's baseline from ${todayPath}`);
    process.exit(2);
  }

  console.log('SLO Regression Check');
  console.log('═'.repeat(70));
  console.log(`  Today:     ${todayPath} (${today.runAt})`);

  if (!yesterdayPath) {
    console.log('  Yesterday: (no previous baseline — skipping regression check)');
    console.log('  ✅ PASS: First run, no regression possible');
    process.exit(0);
  }

  const yesterday = loadBaseline(yesterdayPath);
  if (!yesterday) {
    console.log(`  Yesterday: Cannot load from ${yesterdayPath} — skipping`);
    process.exit(0);
  }

  console.log(`  Yesterday: ${yesterdayPath} (${yesterday.runAt})`);
  console.log(`  Threshold: ${THRESHOLD_PCT}% regression`);
  console.log('─'.repeat(70));

  let hasRegression = false;

  for (const todayM of today.measurements) {
    const yesterdayM = yesterday.measurements.find((m) => m.name === todayM.name);
    if (!yesterdayM) {
      console.log(`  ${todayM.name.padEnd(15)}: NEW (no previous data)`);
      continue;
    }

    const delta = todayM.actualMs - yesterdayM.actualMs;
    const deltaPct = yesterdayM.actualMs > 0 ? (delta / yesterdayM.actualMs) * 100 : 0;
    const regressed = deltaPct > THRESHOLD_PCT;

    const icon = regressed ? '❌' : deltaPct > 0 ? '⚠' : '✅';
    console.log(
      `  ${todayM.name.padEnd(15)}: ${todayM.actualMs}ms vs ${yesterdayM.actualMs}ms  ` +
        `Δ=${delta >= 0 ? '+' : ''}${delta}ms (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)  ${icon}`,
    );

    if (regressed) {
      hasRegression = true;
    }
  }

  console.log('═'.repeat(70));

  if (hasRegression) {
    console.log(`❌ FAIL: SLO regression detected (>${THRESHOLD_PCT}% degradation)`);
    process.exit(1);
  }
  console.log('✅ PASS: No SLO regression');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
