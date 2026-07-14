#!/usr/bin/env tsx
/**
 * Run security benchmarks through Commander's real defense stack via
 * createCommanderDefender.
 *
 * Usage:
 *   npx tsx scripts/benchmark-agentdojo.ts                           # AgentDojo only
 *   npx tsx scripts/benchmark-agentdojo.ts --all                     # all benchmarks
 *   npx tsx scripts/benchmark-agentdojo.ts --benchmark injecagent    # InjecAgent only
 *   npx tsx scripts/benchmark-agentdojo.ts --benchmark agentsafetybench
 *   npx tsx scripts/benchmark-agentdojo.ts --benchmark agentharm
 *   npx tsx scripts/benchmark-agentdojo.ts --benchmark cyberseceval
 *   npx tsx scripts/benchmark-agentdojo.ts --benchmark harmbench
 *   npx tsx scripts/benchmark-agentdojo.ts --benchmark assebench
 */
import {
  SecurityBenchmarkRunner,
  getCasesForBenchmark,
} from '../packages/core/src/security/securityBenchmarkRunner';
import { createCommanderDefender } from '../packages/core/src/security/commanderDefender';
import type {
  BenchmarkRunReport,
  BenchmarkTestResult,
} from '../packages/core/src/security/securityBenchmarkRunner';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const runner = new SecurityBenchmarkRunner({
  enabled: true,
  minScorePass: 100,
  failOnCriticalMissed: true,
});
// Harmful content check is opt-in (default false in createCommanderDefender).
// For AgentSafetyBench / AgentHarm direct harmful-content benchmarks, and for
// combined --all runs, we enable Layer 0 HarmfulContentClassifier by default so
// the combined report reflects the full defense stack.
const args = process.argv.slice(2);
const runAll = args.includes('--all');
const singleBenchmark = parseBenchmarkArg(args);
const enableHarmfulContentCheck =
  args.includes('--with-harmful') ||
  runAll ||
  singleBenchmark === 'agentsafetybench' ||
  singleBenchmark === 'agentharm' ||
  singleBenchmark === 'cyberseceval' ||
  singleBenchmark === 'harmbench' ||
  singleBenchmark === 'assebench';
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

function spawnAndExit(command: string): void {
  try {
    const child = execSync(command, { stdio: 'inherit' });
    process.exit(0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.status ?? 2;
    process.exit(code);
  }
}

function getSubcommandArgs(args: string[], subcommand: string): string {
  const idx = args.indexOf(subcommand);
  if (idx !== -1 && idx + 1 < args.length) {
    return args.slice(idx + 1).join(' ');
  }
  return '';
}

function getArgsAfterBenchmarkName(args: string[], benchmarkName: string): string {
  const idx = args.indexOf('--benchmark');
  if (idx !== -1 && idx + 1 < args.length && args[idx + 1] === benchmarkName) {
    return args.slice(idx + 2).join(' ');
  }
  return '';
}

function parseBenchmarkArg(
  args: string[],
):
  | 'agentdojo'
  | 'agentsafetybench'
  | 'agentharm'
  | 'injecagent'
  | 'cyberseceval'
  | 'harmbench'
  | 'assebench'
  | 'webarena'
  | 'agentbench'
  | 'gaia'
  | 'osworld'
  | 'crab'
  | 'swebench'
  | 'mlcommons:ailuminate'
  | 'caict:ai-safety'
  | undefined {
  const idx = args.indexOf('--benchmark');
  if (idx !== -1 && args[idx + 1]) {
    const value = args[idx + 1];
    if (
      value === 'agentdojo' ||
      value === 'agentsafetybench' ||
      value === 'agentharm' ||
      value === 'injecagent' ||
      value === 'cyberseceval' ||
      value === 'harmbench' ||
      value === 'assebench' ||
      value === 'webarena' ||
      value === 'agentbench' ||
      value === 'gaia' ||
      value === 'osworld' ||
      value === 'crab' ||
      value === 'swebench' ||
      value === 'mlcommons:ailuminate' ||
      value === 'caict:ai-safety'
    ) {
      return value;
    }
    console.error(`Unknown benchmark: ${value}`);
    process.exit(2);
  }
  return undefined;
}

function ensureInjecAgentDataset(): void {
  const cacheDir = 'packages/core/.cache/injecagent';
  const required = [
    'test_cases_dh_base.json',
    'test_cases_dh_enhanced.json',
    'test_cases_ds_base.json',
    'test_cases_ds_enhanced.json',
  ];
  const missing = required.some((f) => !fs.existsSync(path.join(cacheDir, f)));
  if (missing) {
    console.log('InjecAgent dataset not cached; downloading...');
    execSync('bash scripts/download-injecagent-dataset.sh', { stdio: 'inherit' });
  }
}

function ensureCyberSecEvalDataset(): void {
  const cacheDir = 'packages/core/.cache/cyberseceval';
  const required = [
    'mitre_benchmark_100_per_category_with_augmentation.json',
    'prompt_injection.json',
    'interpreter.json',
  ];
  const missing = required.some((f) => !fs.existsSync(path.join(cacheDir, f)));
  if (missing) {
    console.log('CyberSecEval dataset not cached; downloading...');
    execSync('bash scripts/download-cyberseceval-dataset.sh', { stdio: 'inherit' });
  }
}

function ensureHarmBenchDataset(): void {
  const cacheDir = 'packages/core/.cache/harmbench';
  const file = 'harmbench_behaviors_text_all.csv';
  if (!fs.existsSync(path.join(cacheDir, file))) {
    console.log('HarmBench dataset not cached; downloading...');
    execSync('bash scripts/download-harmbench-dataset.sh', { stdio: 'inherit' });
  }
}

function ensureAssEBenchDataset(): void {
  const cacheDir = 'packages/core/.cache/assebench';
  const required = ['assebench_records.json'];
  const missing = required.some((f) => !fs.existsSync(path.join(cacheDir, f)));
  if (missing) {
    console.log('ASSEBench dataset not cached; download will be required for full run.');
    console.log(`  Expected: ${required.map((f) => path.join(cacheDir, f)).join(', ')}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (
    runAll ||
    singleBenchmark === 'injecagent' ||
    singleBenchmark === 'cyberseceval' ||
    singleBenchmark === 'harmbench' ||
    singleBenchmark === 'assebench'
  ) {
    ensureInjecAgentDataset();
    ensureCyberSecEvalDataset();
    ensureHarmBenchDataset();
    ensureAssEBenchDataset();
  }

  console.log('Commander Security Benchmark — Real Defense Stack');
  console.log('Defender: createCommanderDefender()');
  console.log(
    `Mode: ${runAll ? 'ALL benchmarks (agentdojo + agentsafetybench + agentharm + injecagent + cyberseceval + harmbench + assebench)' : singleBenchmark ? `SINGLE benchmark (${singleBenchmark})` : 'AgentDojo only'}`,
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
    printReport(all.cyberSecEval);
    printReport(all.harmBench);
    printReport(all.asseBench);

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
  }

  if (singleBenchmark === 'webarena' || singleBenchmark === 'agentbench') {
    const target =
      singleBenchmark === 'webarena'
        ? path.join('scripts', 'benchmark-webarena.ts')
        : path.join('scripts', 'benchmark-agentbench.ts');
    const extraArgs = getArgsAfterBenchmarkName(args, singleBenchmark);
    const command = extraArgs ? `npx tsx ${target} ${extraArgs}` : `npx tsx ${target}`;
    console.log(`Spawning capability scaffold: ${command}`);
    spawnAndExit(command);
  }

  if (singleBenchmark === 'gaia') {
    const target = path.join('scripts', 'benchmark-gaia.ts');
    const extraArgs = getArgsAfterBenchmarkName(args, 'gaia');
    const command = extraArgs ? `npx tsx ${target} ${extraArgs}` : `npx tsx ${target}`;
    console.log(`Spawning GAIA benchmark: ${command}`);
    spawnAndExit(command);
  }

  const capabilityScaffolds: Record<string, string> = {
    osworld: 'benchmark-osworld.ts',
    crab: 'benchmark-crab.ts',
    swebench: 'benchmark-swebench.ts',
    'mlcommons:ailuminate': 'benchmark-mlcommons-ailuminate.ts',
    'caict:ai-safety': 'benchmark-caict-ai-safety.ts',
  };
  if (capabilityScaffolds[singleBenchmark]) {
    const target = path.join('scripts', capabilityScaffolds[singleBenchmark]);
    console.log(`Spawning capability scaffold: ${target}`);
    spawnAndExit(`npx tsx ${target}`);
  }

  if (singleBenchmark) {
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
