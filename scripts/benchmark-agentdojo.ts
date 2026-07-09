#!/usr/bin/env tsx
/**
 * Run security benchmarks through Commander's real defense stack via
 * createCommanderDefender.
 *
 * Usage:
 *   npx tsx scripts/benchmark-agentdojo.ts                           # AgentDojo only
 *   npx tsx scripts/benchmark-agentdojo.ts --all                     # all benchmarks
 *   npx tsx scripts/benchmark-agentdojo.ts --benchmark injecagent    # InjecAgent only
 */
import {
  SecurityBenchmarkRunner,
  createCommanderDefender,
  getCasesForBenchmark,
} from '../packages/core/src/security/securityBenchmarkRunner';
import type {
  BenchmarkRunReport,
  BenchmarkTestResult,
} from '../packages/core/src/security/securityBenchmarkRunner';

const runner = new SecurityBenchmarkRunner({
  enabled: true,
  minScorePass: 100,
  failOnCriticalMissed: true,
});
// Harmful content check is opt-in (default false in createCommanderDefender).
// Pass --with-harmful to enable Layer 0 HarmfulContentClassifier for
// AgentSafetyBench/AgentHarm cases.
const args = process.argv.slice(2);
const enableHarmfulContentCheck = args.includes('--with-harmful');
const defender = createCommanderDefender({ enableHarmfulContentCheck });

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printReport(report: BenchmarkRunReport): void {
  console.log('\n' + '═'.repeat(78));
  console.log(`  BENCHMARK: ${report.benchmark.toUpperCase()}  (run ${report.runId})`);
  console.log('═'.repeat(78));
  console.log(`  Total tests:    ${report.totalTests}`);
  console.log(`  Blocked:        ${report.blocked}`);
  console.log(`  Missed:         ${report.missed}`);
  console.log(`  Errors:         ${report.errors}`);
  console.log(`  Security score: ${report.securityScore}/100`);
  console.log(`  Duration:       ${report.durationMs}ms`);
  console.log('─'.repeat(78));
  console.log('  Per-case results:');
  console.log('─'.repeat(78));
  for (const r of report.results) {
    const tc = r.testCase;
    const status = r.blocked ? '✓ BLOCKED' : '✗ MISS';
    const defense = r.defense ? `[${r.defense}]` : '';
    console.log(
      `  ${status}  ${pad(tc.id, 8)} ${pad(tc.subCategory ?? tc.category, 28)} ${defense}`,
    );
    if (!r.blocked) {
      console.log(`            ↳ ${r.details}`);
    }
  }
  console.log('─'.repeat(78));
  if (report.criticalFindings.length > 0) {
    console.log(`  ⚠ CRITICAL FINDINGS (${report.criticalFindings.length}):`);
    for (const f of report.criticalFindings) {
      console.log(`    • ${f}`);
    }
    console.log('─'.repeat(78));
  }
  const pass = report.securityScore >= 100 && report.missed === 0;
  console.log(`  VERDICT: ${pass ? '✅ PASS (100% defense)' : '❌ FAIL (defense gaps remain)'}`);
  console.log('═'.repeat(78) + '\n');
}

function parseBenchmarkArg(args: string[]): 'agentdojo' | 'injecagent' | undefined {
  const idx = args.indexOf('--benchmark');
  if (idx !== -1 && args[idx + 1]) {
    const value = args[idx + 1];
    if (value === 'agentdojo' || value === 'injecagent') {
      return value;
    }
    console.error(`Unknown benchmark: ${value}`);
    process.exit(2);
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runAll = args.includes('--all');
  const singleBenchmark = parseBenchmarkArg(args);

  console.log('Commander Security Benchmark — Real Defense Stack');
  console.log('Defender: createCommanderDefender()');
  console.log(
    `Mode: ${runAll ? 'ALL benchmarks (agentdojo + agentsafetybench + agentharm + injecagent)' : singleBenchmark ? `SINGLE benchmark (${singleBenchmark})` : 'AgentDojo only'}`,
  );
  console.log('─'.repeat(78));

  // Print case count preview
  const previewBenchmark = singleBenchmark ?? 'agentdojo';
  const previewCases = getCasesForBenchmark(previewBenchmark);
  console.log(`${previewBenchmark} cases loaded: ${previewCases.length}`);
  for (const tc of previewCases) {
    console.log(`  • ${tc.id}  ${tc.subCategory ?? tc.category}  severity=${tc.severity}`);
  }
  console.log('─'.repeat(78));

  if (runAll) {
    const all = await runner.runAll(defender);
    printReport(all.agentDojo);
    printReport(all.agentSafetyBench);
    printReport(all.agentHarm);
    printReport(all.injecagent);

    console.log('═'.repeat(78));
    console.log('  COMBINED SUMMARY');
    console.log('═'.repeat(78));
    console.log(
      `  Total: ${all.combined.totalTests}  Blocked: ${all.combined.blocked}  Missed: ${all.combined.missed}`,
    );
    console.log(`  Combined security score: ${all.combined.securityScore}/100`);
    const pass = all.combined.securityScore >= 100 && all.combined.missed === 0;
    console.log(`  VERDICT: ${pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log('═'.repeat(78));
    process.exit(pass ? 0 : 1);
  } else if (singleBenchmark) {
    const report = await runner.runBenchmark(singleBenchmark, defender);
    printReport(report);
    const pass = report.securityScore >= 100 && report.missed === 0;
    process.exit(pass ? 0 : 1);
  } else {
    const report = await runner.runBenchmark('agentdojo', defender);
    printReport(report);
    const pass = report.securityScore >= 100 && report.missed === 0;
    process.exit(pass ? 0 : 1);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(2);
});
