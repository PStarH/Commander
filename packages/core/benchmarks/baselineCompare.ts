#!/usr/bin/env node
/**
 * Benchmark Baseline Comparison
 *
 * Compares current benchmark results against a stored baseline JSON.
 * Exits with code 1 if any benchmark regressed by more than 10%.
 *
 * Usage:
 *   npx tsx packages/core/benchmarks/baselineCompare.ts --current results.json
 *   npx tsx packages/core/benchmarks/baselineCompare.ts --save  # Save current as baseline
 *   npx tsx packages/core/benchmarks/baselineCompare.ts         # Show baseline
 */
import * as fs from 'fs';
import * as path from 'path';

const BASELINE_FILE = path.join(__dirname, 'baseline.json');
const REGRESSION_THRESHOLD = 0.10; // 10% regression allowed

interface BenchmarkEntry {
  name: string;
  score: number;
  date: string;
}

interface BaselineData {
  benchmarks: BenchmarkEntry[];
}

interface ComparisonResult {
  name: string;
  baselineScore: number;
  currentScore: number;
  changePercent: number;
  status: 'improved' | 'unchanged' | 'regressed';
}

function loadBaseline(): BaselineData {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
  } catch {
    return { benchmarks: [] };
  }
}

function loadCurrent(filePath: string): BaselineData {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf-8'));
  } catch (err) {
    console.error(`Error: Cannot load current results from "${filePath}"`);
    process.exit(1);
  }
}

function saveBaseline(data: BaselineData): void {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
  console.log(`Baseline saved to ${BASELINE_FILE}`);
}

function compare(baseline: BaselineData, current: BaselineData): ComparisonResult[] {
  const results: ComparisonResult[] = [];

  for (const b of baseline.benchmarks) {
    const c = current.benchmarks.find((cb: BenchmarkEntry) => cb.name === b.name);
    if (!c) {
      console.warn(`Warning: "${b.name}" not found in current results — skipping`);
      continue;
    }
    const changePercent = ((c.score - b.score) / b.score) * 100;
    results.push({
      name: b.name,
      baselineScore: b.score,
      currentScore: c.score,
      changePercent: Math.round(changePercent * 100) / 100,
      status: changePercent < -REGRESSION_THRESHOLD * 100 ? 'regressed' :
              changePercent > REGRESSION_THRESHOLD * 100 ? 'improved' : 'unchanged',
    });
  }

  return results;
}

function printTable(results: ComparisonResult[]): void {
  console.log('\n=== Benchmark Regression Report ===\n');
  console.log(`${'Benchmark'.padEnd(25)} ${'Baseline'.padEnd(10)} ${'Current'.padEnd(10)} ${'Change'.padEnd(10)} Status`);
  console.log('-'.repeat(75));
  for (const r of results) {
    const changeStr = `${r.changePercent > 0 ? '+' : ''}${r.changePercent}%`;
    const statusStr = r.status === 'regressed' ? '❌ REGRESSED' :
                      r.status === 'improved' ? '✅ improved' : '  unchanged';
    console.log(
      `${r.name.padEnd(25)} ${String(r.baselineScore).padEnd(10)} ${String(r.currentScore).padEnd(10)} ${changeStr.padEnd(10)} ${statusStr}`
    );
  }
  console.log('');
}

function main(): void {
  const args = process.argv.slice(2);
  const saveFlag = args.includes('--save');
  const currentFlag = args.indexOf('--current');

  const baseline = loadBaseline();

  if (baseline.benchmarks.length === 0 && !saveFlag) {
    console.log('No baseline found. Run with --save to create one.');
    process.exit(0);
  }

  if (saveFlag) {
    saveBaseline(baseline);
    return;
  }

  if (currentFlag === -1) {
    // Just display baseline
    console.log('\n=== Current Baseline ===\n');
    for (const b of baseline.benchmarks) {
      console.log(`  ${b.name.padEnd(25)} ${String(b.score).padStart(8)}  (${b.date})`);
    }
    console.log('');
    return;
  }

  const currentFile = args[currentFlag + 1];
  if (!currentFile) {
    console.error('Error: --current requires a file path');
    process.exit(1);
  }

  const current = loadCurrent(currentFile);
  const results = compare(baseline, current);
  printTable(results);

  const regressions = results.filter(r => r.status === 'regressed');
  if (regressions.length > 0) {
    console.error(`❌ ${regressions.length} benchmark(s) regressed!`);
    process.exit(1);
  }

  console.log('✅ All benchmarks within acceptable range.');
}

main();
