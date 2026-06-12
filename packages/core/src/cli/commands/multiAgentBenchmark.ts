import {
  $, cmdHeader, kv, startSpinner, fatalError,
  createRuntime, TELOSOrchestrator, UltimateOrchestrator, detectProvider,
} from './_shared';
import { MultiAgentBenchmark } from '../../benchmark/multiAgentBenchmark';
import type { BenchmarkSummary } from '../../benchmark/multiAgentBenchmark';
import { getGlobalLogger } from '../../logging';

function printSummary(s: BenchmarkSummary) {
  console.log();
  kv('Tasks', `${s.completedTasks}/${s.totalTasks}`, $.cyan);
  kv('Multi wins', String(s.overall.multiWins), $.green);
  kv('Single wins', String(s.overall.singleWins), $.yellow);
  kv('Ties', String(s.overall.ties), $.dim);
  console.log();

  for (const tier of ['simple', 'moderate', 'complex'] as const) {
    const t = s.byTier[tier];
    if (!t || t.total === 0) continue;
    console.log(`  ${$.bold}${tier.toUpperCase()}${$.reset} (${t.total} tasks)`);
    console.log(`    Multi wins: ${t.multiWins}  Single wins: ${t.singleWins}  Ties: ${t.ties}`);
    console.log(`    Quality Δ: ${t.avgQualityDelta > 0 ? '+' : ''}${(t.avgQualityDelta * 100).toFixed(1)}pp`);
    console.log(`    Latency Δ: ${t.avgLatencyDelta > 0 ? '+' : ''}${(t.avgLatencyDelta).toFixed(0)}ms`);
    console.log(`    Cost Δ: ${t.avgCostDelta > 0 ? '+' : ''}${(t.avgCostDelta * 100).toFixed(1)}%`);
  }

  console.log();
  console.log(`  ${$.bold}OVERALL${$.reset}`);
  console.log(`    Quality: ${(s.overall.avgQualityImprovement * 100).toFixed(1)}pp improvement`);
  console.log(`    Cost: ${(s.overall.avgCostOverhead * 100).toFixed(1)}% overhead`);
  console.log(`    p-value: ${s.overall.statisticalSignificance.toFixed(4)}`);
  console.log(`    Significant: ${s.overall.statisticalSignificance < 0.05 ? 'YES' : 'NO'}`);

  if (s.recommendations.length > 0) {
    console.log();
    console.log(`  ${$.bold}Recommendations:${$.reset}`);
    for (const r of s.recommendations) {
      console.log(`    ${r}`);
    }
  }
}

export async function cmdMultiAgentBenchmark(args: string[]) {
  const provider = detectProvider();
  if (!provider) {
    fatalError('No API key found.', 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart');
  }

  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const [k, v] = arg.split('=');
      flags[k.replace(/^--/, '')] = v;
    } else if (arg.startsWith('--')) {
      flags[arg.replace(/^--/, '')] = 'true';
    }
  }

  cmdHeader('Multi-Agent Topology Benchmark');
  kv('Provider', provider.type, $.cyan);
  if (flags.tasks) kv('Tasks', flags.tasks, $.cyan);
  if (flags.tier) kv('Tier', flags.tier, $.cyan);
  console.log();

  const runtime = createRuntime();
  if (!runtime) {
    fatalError('Failed to create runtime.', 'Check your API key and provider configuration.');
  }

  const testSpinner = startSpinner('Testing API connectivity...');
  try {
    const testResult = await runtime.execute({
      agentId: ' connectivity-test',
      projectId: 'benchmark',
      goal: 'Reply with exactly: OK',
      contextData: {},
      availableTools: [],
      maxSteps: 1,
      tokenBudget: 50,
    });
    testSpinner();
    if (testResult.status !== 'success') {
      fatalError('API test failed.', `Provider returned status: ${testResult.status}. Check your API key credits.`);
    }
  } catch (err) {
    testSpinner();
    const msg = err instanceof Error ? err.message : String(err);
    fatalError('API test failed.', `${msg}\n\nFix: add credits or set a working API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)`);
  }

  const telos = new TELOSOrchestrator(runtime);
  const orchestrator = new UltimateOrchestrator(telos, runtime);

  const bench = new MultiAgentBenchmark({
    tasks: flags.tasks ? parseInt(flags.tasks, 10) : undefined,
    tier: flags.tier as 'simple' | 'moderate' | 'complex' | undefined,
    parallel: flags.parallel ? parseInt(flags.parallel, 10) : 2,
    runtime,
    orchestrator,
  });

  const spinner = startSpinner('Running benchmark...');
  const summary = await bench.run();
  spinner();

  printSummary(summary);
}
