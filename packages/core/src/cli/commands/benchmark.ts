/**
 * Commander benchmark — A/B comparison of optimized vs baseline execution.
 *
 * Usage:
 *   commander benchmark                    # run default tasks
 *   commander benchmark --tasks=5          # run 5 default tasks
 *   commander benchmark --task="do X"      # run a single custom task
 *   commander benchmark --repeats=3        # repeat each task 3 times (averages)
 */
import {
  createRuntime, loadTools, $, section, kv, bullet, cmdHeader, startSpinner, onboardingMessage, fatalError,
  TELOSOrchestrator, UltimateOrchestrator, detectProvider,
} from './_shared';
import { DEFAULT_ULTIMATE_CONFIG } from '../../ultimate/types';
import type { UltimateOrchestratorConfig } from '../../ultimate/types';
import {
  DEFAULT_TASKS,
  buildOptimizedConfig,
  buildBaselineConfig,
  formatBenchmarkReport,
} from '../../benchmark/abBenchmark';
import type { BenchmarkTask, RunMetrics, ABResult, BenchmarkSummary } from '../../benchmark/abBenchmark';

// ============================================================================
// Single run executor
// ============================================================================

async function runOnce(
  task: BenchmarkTask,
  config: Partial<UltimateOrchestratorConfig>,
  tools: string[],
): Promise<RunMetrics> {
  const runtime = createRuntime()!;
  const telos = new TELOSOrchestrator(runtime);
  const orch = new UltimateOrchestrator(telos, runtime, config);

  const startTime = Date.now();

  try {
    const result = await orch.execute({
      projectId: 'benchmark',
      agentId: `benchmark-${task.id}`,
      goal: task.goal,
      effortLevel: task.effortLevel,
      contextData: {
        availableTools: tools,
        governanceProfile: { riskLevel: 'LOW' },
      },
    });

    return {
      totalTokens: result.metrics.totalTokens,
      totalCostUsd: result.metrics.totalCostUsd,
      elapsedMs: Date.now() - startTime,
      qualityScore: result.metrics.qualityScore ?? 0,
      status: result.status,
      subAgentsSpawned: result.metrics.subAgentsSpawned ?? 1,
      synthesisLength: result.synthesis?.length ?? 0,
    };
  } catch (err) {
    return {
      totalTokens: 0,
      totalCostUsd: 0,
      elapsedMs: Date.now() - startTime,
      qualityScore: 0,
      status: 'ERROR',
      subAgentsSpawned: 0,
      synthesisLength: 0,
    };
  }
}

// ============================================================================
// A/B comparison for a single task
// ============================================================================

async function benchmarkTask(
  task: BenchmarkTask,
  tools: string[],
): Promise<ABResult> {
  const optimized = await runOnce(task, buildOptimizedConfig(), tools);
  const baseline = await runOnce(task, buildBaselineConfig(), tools);

  const tokenSaving = baseline.totalTokens > 0
    ? ((baseline.totalTokens - optimized.totalTokens) / baseline.totalTokens) * 100
    : 0;

  const costSaving = baseline.totalCostUsd > 0
    ? ((baseline.totalCostUsd - optimized.totalCostUsd) / baseline.totalCostUsd) * 100
    : 0;

  const latencyChange = baseline.elapsedMs > 0
    ? ((optimized.elapsedMs - baseline.elapsedMs) / baseline.elapsedMs) * 100
    : 0;

  const qualityChange = optimized.qualityScore - baseline.qualityScore;

  return { task, optimized, baseline, tokenSaving, costSaving, latencyChange, qualityChange };
}

// ============================================================================
// CLI command
// ============================================================================

export async function cmdBenchmark(args: string[]) {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    fatalError('No API key found.', 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart');
  }

  // Parse flags
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const [k, v] = arg.split('=');
      flags[k.replace(/^--/, '')] = v;
    } else if (arg.startsWith('--')) {
      flags[arg.replace(/^--/, '')] = 'true';
    } else {
      positional.push(arg);
    }
  }

  const taskCount = flags.tasks ? parseInt(flags.tasks, 10) : DEFAULT_TASKS.length;
  const repeats = flags.repeats ? parseInt(flags.repeats, 10) : 1;
  const customTask = flags.task;

  // Build task list
  let tasks: BenchmarkTask[];
  if (customTask) {
    tasks = [{ id: 'custom', label: customTask.slice(0, 27), goal: customTask }];
  } else {
    tasks = DEFAULT_TASKS.slice(0, taskCount);
  }

  const tools = loadTools();

  cmdHeader('A/B Benchmark');
  kv('Tasks', String(tasks.length), $.cyan);
  kv('Repeats', String(repeats), $.cyan);
  kv('Provider', provider.type, $.cyan);
  console.log();

  const allResults: ABResult[] = [];

  for (let r = 0; r < repeats; r++) {
    if (repeats > 1) {
      console.log(`  ${$.dim}Round ${r + 1}/${repeats}${$.reset}`);
    }

    for (const task of tasks) {
      const spinner = startSpinner(`  ${task.label}...`);
      const result = await benchmarkTask(task, tools);
      spinner();

      allResults.push(result);

      // Inline result
      const tokDelta = result.tokenSaving;
      const sign = tokDelta >= 0 ? '-' : '+';
      const color = tokDelta > 10 ? $.green : tokDelta > 0 ? $.dim : $.red;
      console.log(
        `  ${color}${sign}${Math.abs(tokDelta).toFixed(0)}% tokens${$.reset}` +
        `  ${$.dim}${result.optimized.totalTokens} vs ${result.baseline.totalTokens}${$.reset}` +
        `  ${$.dim}${task.label}${$.reset}`
      );
    }
    console.log();
  }

  // Aggregate across repeats
  const byTask = new Map<string, ABResult[]>();
  for (const r of allResults) {
    const list = byTask.get(r.task.id) ?? [];
    list.push(r);
    byTask.set(r.task.id, list);
  }

  const avgResults: ABResult[] = [];
  for (const [, runs] of byTask) {
    const avg = (fn: (r: ABResult) => number) => runs.reduce((s, r) => s + fn(r), 0) / runs.length;

    avgResults.push({
      task: runs[0].task,
      optimized: {
        totalTokens: Math.round(avg(r => r.optimized.totalTokens)),
        totalCostUsd: avg(r => r.optimized.totalCostUsd),
        elapsedMs: Math.round(avg(r => r.optimized.elapsedMs)),
        qualityScore: avg(r => r.optimized.qualityScore),
        status: runs[0].optimized.status,
        subAgentsSpawned: Math.round(avg(r => r.optimized.subAgentsSpawned)),
        synthesisLength: Math.round(avg(r => r.optimized.synthesisLength)),
      },
      baseline: {
        totalTokens: Math.round(avg(r => r.baseline.totalTokens)),
        totalCostUsd: avg(r => r.baseline.totalCostUsd),
        elapsedMs: Math.round(avg(r => r.baseline.elapsedMs)),
        qualityScore: avg(r => r.baseline.qualityScore),
        status: runs[0].baseline.status,
        subAgentsSpawned: Math.round(avg(r => r.baseline.subAgentsSpawned)),
        synthesisLength: Math.round(avg(r => r.baseline.synthesisLength)),
      },
      tokenSaving: avg(r => r.tokenSaving),
      costSaving: avg(r => r.costSaving),
      latencyChange: avg(r => r.latencyChange),
      qualityChange: avg(r => r.qualityChange),
    });
  }

  // Summary
  const avgTokenSaving = avgResults.reduce((s, r) => s + r.tokenSaving, 0) / avgResults.length;
  const avgCostSaving = avgResults.reduce((s, r) => s + r.costSaving, 0) / avgResults.length;
  const avgLatencyChange = avgResults.reduce((s, r) => s + r.latencyChange, 0) / avgResults.length;
  const avgQualityChange = avgResults.reduce((s, r) => s + r.qualityChange, 0) / avgResults.length;
  const totalTokensSaved = avgResults.reduce(
    (s, r) => s + (r.baseline.totalTokens - r.optimized.totalTokens), 0,
  );
  const totalCostSaved = avgResults.reduce(
    (s, r) => s + (r.baseline.totalCostUsd - r.optimized.totalCostUsd), 0,
  );

  const summary: BenchmarkSummary = {
    results: avgResults,
    avgTokenSaving,
    avgCostSaving,
    avgLatencyChange,
    avgQualityChange,
    totalTokensSaved,
    totalCostSaved,
  };

  console.log(formatBenchmarkReport(summary));
}
