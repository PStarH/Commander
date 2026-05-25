#!/usr/bin/env node
/**
 * CI Benchmark Regression Check
 *
 * Runs key performance benchmarks, compares ops/sec against stored baselines,
 * and exits with code 1 if any metric regressed beyond the threshold.
 *
 * Usage:
 *   npx tsx packages/core/benchmarks/ci-benchmark-check.ts
 *
 * Environment:
 *   CI_BENCHMARK_UPDATE=1    Save current results as new baselines
 *   CI_BENCHMARK_THRESHOLD   Regression threshold as decimal (default: 0.20 = 20%)
 */
import * as fs from 'fs';
import * as path from 'path';

const THRESHOLD = parseFloat(process.env.CI_BENCHMARK_THRESHOLD || '0.20');
const BASELINE_FILE = path.join(__dirname, 'ci-benchmark-baseline.json');

interface MetricSample {
  name: string;
  opsPerSecond: number;
}

interface BaselineEntry {
  name: string;
  opsPerSecond: number;
  date: string;
}

interface BaselineData {
  metrics: BaselineEntry[];
}

function loadBaseline(): BaselineData {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
  } catch {
    return { metrics: [] };
  }
}

function saveBaseline(samples: MetricSample[]): void {
  const data: BaselineData = {
    metrics: samples.map(s => ({
      name: s.name,
      opsPerSecond: Math.round(s.opsPerSecond * 100) / 100,
      date: new Date().toISOString().slice(0, 10),
    })),
  };
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
  console.log(`\n✅ Baseline saved to ${BASELINE_FILE}`);
}

function loadTools(): string[] {
  return (process.env.COMMANDER_TOOLS || 'web_search,web_fetch,file_read,file_write').split(',');
}

// Helper: run benchmark with timing
function runBenchmark(name: string, operations: number, fn: () => void): MetricSample {
  // Warmup
  for (let w = 0; w < 3; w++) fn();

  const start = performance.now();
  for (let i = 0; i < operations; i++) fn();
  const totalMs = performance.now() - start;
  const avgMs = totalMs / operations;
  const opsPerSec = 1000 / avgMs;
  console.log(`  ${name.padEnd(45)} ${String(operations).padStart(6)} ops  ${avgMs.toFixed(4).padStart(10)} ms/op  ${opsPerSec.toFixed(1).padStart(10)} ops/s`);
  return { name, opsPerSecond: Math.round(opsPerSec * 100) / 100 };
}

async function runAll(): Promise<MetricSample[]> {
  const samples: MetricSample[] = [];

  console.log('\n=== CI Benchmark Regression Check ===\n');
  console.log(`${'Benchmark'.padEnd(45)} ${'Ops'.padStart(6)} ${'Avg Time'.padStart(10)} ${'Throughput'.padStart(10)}`);
  console.log('-'.repeat(80));

  // Dynamic imports to avoid needing all modules at parse time
  const { TaskComplexityAnalyzer } = await import('../src/index');
  const { AdaptiveOrchestrator } = await import('../src/index');
  const { TokenBudgetAllocator } = await import('../src/index');
  const { ThreeLayerMemory } = await import('../src/index');
  const { ReflectionEngine } = await import('../src/index');
  const { ConsensusChecker } = await import('../src/index');
  const { InspectorAgent } = await import('../src/index');

  // 1. TaskComplexityAnalyzer
  const analyzer = new TaskComplexityAnalyzer();
  samples.push(runBenchmark('TaskComplexityAnalyzer.analyze', 1000, () => {
    analyzer.analyze({ id: 'bench-task', description: 'Build a distributed system with multiple services and dependencies', riskLevel: 'high' });
  }));

  // 2. AdaptiveOrchestrator
  const orchestrator = new AdaptiveOrchestrator();
  for (let i = 0; i < 5; i++) orchestrator.registerAgent({ id: `agent-${i}`, name: `Agent ${i}`, role: 'worker', capabilities: ['coding', 'testing'] });
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    id: `task-${i}`, description: `Task ${i}`, priority: 'medium' as const, complexity: 30 + Math.random() * 40,
  }));
  samples.push(runBenchmark('AdaptiveOrchestrator.createPlan', 100, () => orchestrator.createPlan(tasks, 'PARALLEL')));

  // 3. TokenBudgetAllocator
  const allocator = new TokenBudgetAllocator({ baseBudget: 100000 });
  samples.push(runBenchmark('TokenBudgetAllocator.allocate', 1000, () => allocator.allocate('PARALLEL', 50, 3)));
  allocator.initialize(100000);
  samples.push(runBenchmark('TokenBudgetAllocator.recordUsage', 10000, () => allocator.recordUsage('agent-1', 100)));
  samples.push(runBenchmark('TokenBudgetAllocator.getUsageRate', 10000, () => allocator.getUsageRate()));

  // 4. ThreeLayerMemory
  const memory = new ThreeLayerMemory();
  samples.push(runBenchmark('ThreeLayerMemory.add', 1000, () => memory.add(`content ${Date.now()}`, 'working', 'context', 0.8)));
  samples.push(runBenchmark('ThreeLayerMemory.query', 1000, () => memory.query({ keywords: ['test'], limit: 10 })));
  samples.push(runBenchmark('ThreeLayerMemory.getStats', 1000, () => memory.getStats()));

  // 5. ReflectionEngine
  const engine = new ReflectionEngine();
  samples.push(runBenchmark('ReflectionEngine.startSession', 1000, () => engine.startSession(`session-${Date.now()}`)));
  const sessionId = engine.startSession('bench-main');
  samples.push(runBenchmark('ReflectionEngine.addReflection', 1000, () => engine.addReflection(sessionId, 'post_execution', 'Question?', 'Answer')));
  samples.push(runBenchmark('ReflectionEngine.getStats', 100, () => engine.getStats()));

  // 6. ConsensusChecker
  const checker = new ConsensusChecker({ minVoters: 3 });
  samples.push(runBenchmark('ConsensusChecker.createCheck', 1000, () => checker.createCheck('Best approach?')));
  const checkId = checker.createCheck('Decision');
  samples.push(runBenchmark('ConsensusChecker.addVote', 1000, () => checker.addVote(checkId, `model-${Date.now()}`, 'Model', 'Decision', 0.9, 'Reasoning')));
  samples.push(runBenchmark('ConsensusChecker.getResult', 1000, () => checker.getResult(checkId)));

  // 7. InspectorAgent
  const inspector = new InspectorAgent();
  samples.push(runBenchmark('InspectorAgent.updateComponent', 1000, () => inspector.updateComponent('service', 'healthy', 0.9, { latency: 10 })));
  samples.push(runBenchmark('InspectorAgent.autoDetect', 1000, () => inspector.autoDetect('api', { responseTime: 500, errorRate: 0.01 })));
  samples.push(runBenchmark('InspectorAgent.inspect', 100, () => inspector.inspect()));
  samples.push(runBenchmark('InspectorAgent.getStats', 1000, () => inspector.getStats()));

  return samples;
}

async function main(): Promise<void> {
  const updateBaseline = !!process.env.CI_BENCHMARK_UPDATE;

  console.log(`Threshold: ${(THRESHOLD * 100).toFixed(0)}% regression allowed\n`);

  const samples = await runAll();
  const baseline = loadBaseline();

  if (updateBaseline || baseline.metrics.length === 0) {
    saveBaseline(samples);
    return;
  }

  // Compare against baseline
  let hasRegression = false;
  console.log('\n=== Regression Report ===\n');
  console.log(`${'Metric'.padEnd(45)} ${'Baseline'.padStart(10)} ${'Current'.padStart(10)} ${'Change'.padStart(10)}`);
  console.log('-'.repeat(80));

  for (const sample of samples) {
    const base = baseline.metrics.find((b: BaselineEntry) => b.name === sample.name);
    if (!base) {
      console.log(`  ${sample.name.padEnd(45)} ${'(new)'.padStart(10)} ${String(sample.opsPerSecond).padStart(10)}`);
      continue;
    }
    const change = ((sample.opsPerSecond - base.opsPerSecond) / base.opsPerSecond);
    const changePct = (change * 100).toFixed(1);
    const isRegression = change < -THRESHOLD;
    const status = isRegression ? '❌ REGRESSED' : change > THRESHOLD ? '✅ improved' : '  ok';
    console.log(`  ${sample.name.padEnd(45)} ${String(base.opsPerSecond).padStart(10)} ${String(sample.opsPerSecond).padStart(10)} ${(change > 0 ? '+' : '') + changePct + '%'.padStart(6)} ${status}`);
    if (isRegression) hasRegression = true;
  }

  console.log('');
  if (hasRegression) {
    console.error('❌ Some benchmarks regressed beyond threshold.');
    process.exit(1);
  }
  console.log('✅ All benchmarks within acceptable range.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
