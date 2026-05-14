/**
 * Performance Benchmark Suite
 * Phase 2: 性能基准测试
 * 
 * 测试所有核心组件的性能指标
 */

import {
  TaskComplexityAnalyzer,
  AdaptiveOrchestrator,
  TokenBudgetAllocator,
  ThreeLayerMemory,
  ReflectionEngine,
  ConsensusChecker,
  InspectorAgent
} from '../src/index';

// ========================================
// Benchmark Utilities
// ========================================

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTimeMs: number;
  avgTimeMs: number;
  minTimeMs: number;
  maxTimeMs: number;
  opsPerSecond: number;
  memoryUsed?: number;
}

interface BenchmarkSuite {
  timestamp: string;
  results: BenchmarkResult[];
  systemInfo: {
    nodeVersion: string;
    platform: string;
    cpuCores: number;
    totalMemory: number;
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function runBenchmark<T>(
  name: string,
  fn: () => T,
  iterations: number = 1000
): BenchmarkResult {
  const times: number[] = [];
  let result: T;
  let memoryBefore = 0;

  // Warm up
  for (let i = 0; i < Math.min(10, iterations); i++) {
    result = fn();
  }

  // Measure
  if (global.gc) global.gc();
  memoryBefore = process.memoryUsage().heapUsed;

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    result = fn();
  }
  const end = performance.now();

  const totalTimeMs = end - start;
  const memoryAfter = process.memoryUsage().heapUsed;

  return {
    name,
    iterations,
    totalTimeMs,
    avgTimeMs: totalTimeMs / iterations,
    minTimeMs: Math.min(...times) || totalTimeMs / iterations,
    maxTimeMs: Math.max(...times) || totalTimeMs / iterations,
    opsPerSecond: iterations / (totalTimeMs / 1000),
    memoryUsed: memoryAfter - memoryBefore
  };
}

function runAsyncBenchmark<T>(
  name: string,
  fn: () => Promise<T>,
  iterations: number = 100
): BenchmarkResult {
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    fn(); // Fire and don't wait for individual iteration
  }
  
  const end = performance.now();
  const totalTimeMs = end - start;

  return {
    name,
    iterations,
    totalTimeMs,
    avgTimeMs: totalTimeMs / iterations,
    minTimeMs: totalTimeMs / iterations,
    maxTimeMs: totalTimeMs / iterations,
    opsPerSecond: iterations / (totalTimeMs / 1000)
  };
}

// ========================================
// Benchmark Suites
// ========================================

function benchmarkTaskComplexityAnalyzer(): BenchmarkResult[] {
  const analyzer = new TaskComplexityAnalyzer();
  const simpleTask = {
    id: 'bench-1',
    description: 'Simple task',
    riskLevel: 'low' as const
  };
  const complexTask = {
    id: 'bench-2',
    description: 'Build a distributed system with multiple services, database integration, API gateway, monitoring, and scaling requirements',
    riskLevel: 'high' as const
  };

  return [
    runBenchmark('TaskComplexity.analyze(simple)', () => {
      analyzer.analyze(simpleTask);
    }, 10000),

    runBenchmark('TaskComplexity.analyze(complex)', () => {
      analyzer.analyze(complexTask);
    }, 5000)
  ];
}

function benchmarkAdaptiveOrchestrator(): BenchmarkResult[] {
  const orchestrator = new AdaptiveOrchestrator();
  
  orchestrator.registerAgent({
    id: 'bench-agent-1',
    name: 'Agent 1',
    role: 'test',
    capabilities: ['coding', 'testing']
  });
  orchestrator.registerAgent({
    id: 'bench-agent-2',
    name: 'Agent 2',
    role: 'test',
    capabilities: ['coding', 'testing']
  });

  const tasks = [
    { id: 't1', description: 'Task 1', priority: 'medium' as const, complexity: 30 },
    { id: 't2', description: 'Task 2', priority: 'medium' as const, complexity: 50 },
    { id: 't3', description: 'Task 3', priority: 'high' as const, complexity: 70 }
  ];

  return [
    runBenchmark('Orchestrator.createPlan(sequential)', () => {
      orchestrator.createPlan(tasks, 'SEQUENTIAL');
    }, 1000),

    runBenchmark('Orchestrator.createPlan(parallel)', () => {
      orchestrator.createPlan(tasks, 'PARALLEL');
    }, 1000),

    runBenchmark('Orchestrator.getMetrics', () => {
      orchestrator.getMetrics();
    }, 10000)
  ];
}

function benchmarkTokenBudgetAllocator(): BenchmarkResult[] {
  const allocator = new TokenBudgetAllocator();

  return [
    runBenchmark('TokenBudget.allocate(SEQUENTIAL)', () => {
      allocator.allocate('SEQUENTIAL', 50, 1);
    }, 10000),

    runBenchmark('TokenBudget.allocate(PARALLEL)', () => {
      allocator.allocate('PARALLEL', 50, 3);
    }, 10000),

    runBenchmark('TokenBudget.allocate(CONSENSUS)', () => {
      allocator.allocate('CONSENSUS', 80, 3);
    }, 5000),

    runBenchmark('TokenBudget.recordUsage', () => {
      allocator.recordUsage('lead', 1000, 'execution');
    }, 10000),

    runBenchmark('TokenBudget.getRemaining', () => {
      allocator.getRemaining();
    }, 50000)
  ];
}

function benchmarkThreeLayerMemory(): BenchmarkResult[] {
  const memory = new ThreeLayerMemory();

  // Pre-populate
  for (let i = 0; i < 100; i++) {
    memory.add(`Content ${i}`, 'working', 'bench', 0.5, ['bench']);
    memory.add(`Content ${i}`, 'episodic', 'bench', 0.5, ['bench']);
    memory.add(`Content ${i}`, 'longterm', 'bench', 0.5, ['bench']);
  }

  return [
    runBenchmark('Memory.add(working)', () => {
      memory.add('New content', 'working', 'bench', 0.5);
    }, 10000),

    runBenchmark('Memory.getByLayer(working)', () => {
      memory.getByLayer('working');
    }, 10000),

    runBenchmark('Memory.query(keywords)', () => {
      memory.query({ keywords: ['bench'], limit: 10 });
    }, 5000),

    runBenchmark('Memory.getStats', () => {
      memory.getStats();
    }, 10000),

    runBenchmark('Memory.getWorkingContext', () => {
      memory.getWorkingContext(10);
    }, 10000)
  ];
}

function benchmarkReflectionEngine(): BenchmarkResult[] {
  const engine = new ReflectionEngine();

  // Pre-populate sessions
  for (let i = 0; i < 50; i++) {
    const sessionId = engine.startSession(`bench-${i}`);
    engine.addReflection(sessionId, 'post_execution', 'How?', 'Good');
    engine.completeSession(sessionId, 'success');
  }

  return [
    runBenchmark('Reflection.startSession', () => {
      engine.startSession('new-task');
    }, 10000),

    runBenchmark('Reflection.addReflection', () => {
      const sessionId = engine.startSession('temp');
      engine.addReflection(sessionId, 'post_execution', 'How?', 'Good');
    }, 5000),

    runBenchmark('Reflection.getStats', () => {
      engine.getStats();
    }, 10000),

    runBenchmark('Reflection.getRecommendations', () => {
      engine.getRecommendations();
    }, 5000)
  ];
}

function benchmarkConsensusChecker(): BenchmarkResult[] {
  const checker = new ConsensusChecker();

  return [
    runBenchmark('Consensus.createCheck', () => {
      checker.createCheck('Test question?');
    }, 5000),

    runBenchmark('Consensus.addVote', () => {
      const checkId = checker.createCheck('Temp?');
      checker.addVote(checkId, 'm1', 'Model 1', 'Answer', 0.9, 'Reason');
    }, 2000),

    runBenchmark('Consensus.getResult', () => {
      const checkId = checker.createCheck('Test?');
      checker.addVote(checkId, 'm1', 'Model 1', 'A', 0.9, 'R');
      checker.addVote(checkId, 'm2', 'Model 2', 'A', 0.85, 'R');
      checker.addVote(checkId, 'm3', 'Model 3', 'A', 0.88, 'R');
      checker.getResult(checkId);
    }, 1000)
  ];
}

function benchmarkInspectorAgent(): BenchmarkResult[] {
  const inspector = new InspectorAgent();

  inspector.updateComponent('test-service', 'healthy', 0.9, { latency: 10 });

  return [
    runBenchmark('Inspector.updateComponent', () => {
      inspector.updateComponent('test', 'healthy', 0.9);
    }, 10000),

    runBenchmark('Inspector.autoDetect', () => {
      inspector.autoDetect('test', { responseTime: 500, errorRate: 0.01 });
    }, 5000),

    runBenchmark('Inspector.inspect', () => {
      inspector.inspect();
    }, 5000),

    runBenchmark('Inspector.getStats', () => {
      inspector.getStats();
    }, 10000)
  ];
}

// ========================================
// Run All Benchmarks
// ========================================

export function runPerformanceBenchmarks(): BenchmarkSuite {
  console.log('Starting Performance Benchmarks...\n');

  const results: BenchmarkResult[] = [];

  console.log('1. Task Complexity Analyzer...');
  results.push(...benchmarkTaskComplexityAnalyzer());

  console.log('2. Adaptive Orchestrator...');
  results.push(...benchmarkAdaptiveOrchestrator());

  console.log('3. Token Budget Allocator...');
  results.push(...benchmarkTokenBudgetAllocator());

  console.log('4. Three-Layer Memory...');
  results.push(...benchmarkThreeLayerMemory());

  console.log('5. Reflection Engine...');
  results.push(...benchmarkReflectionEngine());

  console.log('6. Consensus Checker...');
  results.push(...benchmarkConsensusChecker());

  console.log('7. Inspector Agent...');
  results.push(...benchmarkInspectorAgent());

  const suite: BenchmarkSuite = {
    timestamp: new Date().toISOString(),
    results,
    systemInfo: {
      nodeVersion: process.version,
      platform: process.platform,
      cpuCores: require('os').cpus().length,
      totalMemory: require('os').totalmem()
    }
  };

  return suite;
}

// ========================================
// Print Results
// ========================================

export function printBenchmarkResults(suite: BenchmarkSuite): void {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                    Performance Benchmark Results                     ║
╚══════════════════════════════════════════════════════════════════════╝
  `);

  console.log(`Timestamp: ${suite.timestamp}`);
  console.log(`Platform: ${suite.systemInfo.platform} (${suite.systemInfo.cpuCores} cores)`);
  console.log(`Node: ${suite.systemInfo.nodeVersion}`);
  console.log('\n' + '='.repeat(90));

  // Group by component
  const byComponent: Record<string, BenchmarkResult[]> = {};
  for (const result of suite.results) {
    const component = result.name.split('.')[0];
    if (!byComponent[component]) byComponent[component] = [];
    byComponent[component].push(result);
  }

  for (const [component, results] of Object.entries(byComponent)) {
    console.log(`\n📊 ${component.toUpperCase()}`);
    console.log('-'.repeat(90));
    console.log('Operation'.padEnd(40) + 'Ops/sec'.padEnd(15) + 'Avg(ms)'.padEnd(12) + 'Total(ms)');
    console.log('-'.repeat(90));

    for (const r of results) {
      const name = r.name.split('.')[1] || r.name;
      const ops = r.opsPerSecond.toFixed(0).padEnd(15);
      const avg = r.avgTimeMs.toFixed(4).padEnd(12);
      const total = r.totalTimeMs.toFixed(2);
      console.log(`${name.substring(0, 40).padEnd(40)}${ops}${avg}${total}`);
    }
  }

  console.log('\n' + '='.repeat(90));

  // Summary
  const fastest = suite.results.reduce((a, b) => 
    a.avgTimeMs < b.avgTimeMs ? a : b
  );
  const slowest = suite.results.reduce((a, b) => 
    a.avgTimeMs > b.avgTimeMs ? a : b
  );

  console.log('\n📈 SUMMARY');
  console.log('-'.repeat(90));
  console.log(`Fastest: ${fastest.name} (${fastest.avgTimeMs.toFixed(4)}ms, ${fastest.opsPerSecond.toFixed(0)} ops/sec)`);
  console.log(`Slowest: ${slowest.name} (${slowest.avgTimeMs.toFixed(4)}ms, ${slowest.opsPerSecond.toFixed(0)} ops/sec)`);

  const totalOps = suite.results.reduce((sum, r) => sum + r.iterations, 0);
  const totalTime = suite.results.reduce((sum, r) => sum + r.totalTimeMs, 0);
  console.log(`Total Operations: ${totalOps.toLocaleString()}`);
  console.log(`Total Time: ${totalTime.toFixed(2)}ms`);
  console.log('\n');
}

// ========================================
// Main
// ========================================

if (require.main === module) {
  const suite = runPerformanceBenchmarks();
  printBenchmarkResults(suite);
}

export { printBenchmarkResults };