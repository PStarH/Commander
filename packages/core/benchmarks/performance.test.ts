/**
 * Performance Benchmarks
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
  operations: number;
  totalTimeMs: number;
  avgTimeMs: number;
  opsPerSecond: number;
  memoryUsedBytes?: number;
}

function runBenchmark(
  name: string,
  operations: number,
  fn: () => void
): BenchmarkResult {
  const start = performance.now();
  fn();
  const end = performance.now();
  
  const totalTimeMs = end - start;
  const avgTimeMs = totalTimeMs / operations;
  const opsPerSecond = 1000 / avgTimeMs;

  return {
    name,
    operations,
    totalTimeMs,
    avgTimeMs,
    opsPerSecond
  };
}

function printResults(results: BenchmarkResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('📊 PERFORMANCE BENCHMARK RESULTS');
  console.log('='.repeat(80));
  
  for (const result of results) {
    console.log(`\n${result.name}:`);
    console.log(`  Operations: ${result.operations.toLocaleString()}`);
    console.log(`  Total Time: ${result.totalTimeMs.toFixed(2)}ms`);
    console.log(`  Avg Time: ${result.avgTimeMs.toFixed(4)}ms`);
    console.log(`  Ops/sec: ${result.opsPerSecond.toFixed(0)}`);
  }
  
  console.log('\n' + '='.repeat(80));
}

// ========================================
// Benchmarks
// ========================================

export function runPerformanceBenchmarks(): void {
  const results: BenchmarkResult[] = [];

  // ========================================
  // 1. Task Complexity Analyzer
  // ========================================
  
  console.log('\n🔍 Benchmarking TaskComplexityAnalyzer...');
  
  const analyzer = new TaskComplexityAnalyzer();
  
  results.push(runBenchmark('TaskComplexityAnalyzer.analyze', 1000, () => {
    analyzer.analyze({
      id: 'bench-task',
      description: 'Build a distributed system with multiple services and dependencies',
      riskLevel: 'high'
    });
  }));

  // ========================================
  // 2. Adaptive Orchestrator
  // ========================================
  
  console.log('\n🎯 Benchmarking AdaptiveOrchestrator...');
  
  const orchestrator = new AdaptiveOrchestrator();
  
  // Register agents
  for (let i = 0; i < 5; i++) {
    orchestrator.registerAgent({
      id: `agent-${i}`,
      name: `Agent ${i}`,
      role: 'worker',
      capabilities: ['coding', 'testing']
    });
  }
  
  const tasks = Array.from({ length: 10 }, (_, i) => ({
    id: `task-${i}`,
    description: `Task ${i} description`,
    priority: 'medium' as const,
    complexity: 30 + Math.random() * 40
  }));
  
  results.push(runBenchmark('AdaptiveOrchestrator.createPlan', 100, () => {
    orchestrator.createPlan(tasks, 'PARALLEL');
  }));

  results.push(runBenchmark('AdaptiveOrchestrator.getMetrics', 1000, () => {
    orchestrator.getMetrics();
  }));

  results.push(runBenchmark('AdaptiveOrchestrator.getAgents', 1000, () => {
    orchestrator.getAgents();
  }));

  // ========================================
  // 3. Token Budget Allocator
  // ========================================
  
  console.log('\n💰 Benchmarking TokenBudgetAllocator...');
  
  const allocator = new TokenBudgetAllocator({ baseBudget: 100000 });
  
  results.push(runBenchmark('TokenBudgetAllocator.allocate', 1000, () => {
    allocator.allocate('PARALLEL', 50, 3);
  }));
  
  allocator.initialize(100000);
  
  results.push(runBenchmark('TokenBudgetAllocator.recordUsage', 10000, () => {
    allocator.recordUsage('agent-1', 100);
  }));
  
  results.push(runBenchmark('TokenBudgetAllocator.getUsageRate', 10000, () => {
    allocator.getUsageRate();
  }));
  
  results.push(runBenchmark('TokenBudgetAllocator.getWarnings', 10000, () => {
    allocator.getWarnings();
  }));

  // ========================================
  // 4. Three-Layer Memory
  // ========================================
  
  console.log('\n🧠 Benchmarking ThreeLayerMemory...');
  
  const memory = new ThreeLayerMemory();
  
  results.push(runBenchmark('ThreeLayerMemory.add (working)', 1000, () => {
    memory.add(`Memory content ${Date.now()}`, 'working', 'context', 0.8);
  }));
  
  results.push(runBenchmark('ThreeLayerMemory.add (longterm)', 1000, () => {
    memory.add(`Memory content ${Date.now()}`, 'longterm', 'context', 0.8);
  }));
  
  results.push(runBenchmark('ThreeLayerMemory.get', 10000, () => {
    const entries = memory.getByLayer('working');
    if (entries.length > 0) {
      memory.get(entries[0].id);
    }
  }));
  
  results.push(runBenchmark('ThreeLayerMemory.query', 1000, () => {
    memory.query({ keywords: ['test'], limit: 10 });
  }));
  
  results.push(runBenchmark('ThreeLayerMemory.getStats', 1000, () => {
    memory.getStats();
  }));
  
  results.push(runBenchmark('ThreeLayerMemory.getWorkingContext', 1000, () => {
    memory.getWorkingContext(10);
  }));

  // ========================================
  // 5. Reflection Engine
  // ========================================
  
  console.log('\n🔄 Benchmarking ReflectionEngine...');
  
  const engine = new ReflectionEngine();
  
  results.push(runBenchmark('ReflectionEngine.startSession', 1000, () => {
    engine.startSession(`bench-session-${Date.now()}`);
  }));
  
  const sessionId = engine.startSession('bench-main');
  
  results.push(runBenchmark('ReflectionEngine.addReflection', 1000, () => {
    engine.addReflection(sessionId, 'post_execution', 'Question?', 'Answer with some details');
  }));
  
  results.push(runBenchmark('ReflectionEngine.getSession', 1000, () => {
    engine.getSession(sessionId);
  }));
  
  results.push(runBenchmark('ReflectionEngine.getRecommendations', 1000, () => {
    engine.getRecommendations();
  }));
  
  results.push(runBenchmark('ReflectionEngine.getStats', 100, () => {
    engine.getStats();
  }));

  // ========================================
  // 6. Consensus Checker
  // ========================================
  
  console.log('\n🗳️ Benchmarking ConsensusChecker...');
  
  const checker = new ConsensusChecker({ minVoters: 3 });
  
  results.push(runBenchmark('ConsensusChecker.createCheck', 1000, () => {
    checker.createCheck('What is the best approach?');
  }));
  
  const checkId = checker.createCheck('Benchmark decision');
  
  results.push(runBenchmark('ConsensusChecker.addVote', 1000, () => {
    checker.addVote(checkId, `model-${Date.now()}`, 'Model', 'Decision', 0.9, 'Reasoning');
  }));
  
  results.push(runBenchmark('ConsensusChecker.getResult', 1000, () => {
    checker.getResult(checkId);
  }));
  
  results.push(runBenchmark('ConsensusChecker.getStats', 100, () => {
    checker.getStats();
  }));

  // ========================================
  // 7. Inspector Agent
  // ========================================
  
  console.log('\n🔍 Benchmarking InspectorAgent...');
  
  const inspector = new InspectorAgent();
  
  results.push(runBenchmark('InspectorAgent.updateComponent', 1000, () => {
    inspector.updateComponent('service', 'healthy', 0.9, { latency: 10 });
  }));
  
  results.push(runBenchmark('InspectorAgent.autoDetect', 1000, () => {
    inspector.autoDetect('api', { responseTime: 500, errorRate: 0.01 });
  }));
  
  results.push(runBenchmark('InspectorAgent.inspect', 100, () => {
    inspector.inspect();
  }));
  
  results.push(runBenchmark('InspectorAgent.getStats', 1000, () => {
    inspector.getStats();
  }));
  
  results.push(runBenchmark('InspectorAgent.getOpenIssues', 1000, () => {
    inspector.getOpenIssues();
  }));

  // ========================================
  // Print Results
  // ========================================
  
  printResults(results);
  
  // Summary
  const totalOps = results.reduce((sum, r) => sum + r.operations, 0);
  const totalTime = results.reduce((sum, r) => sum + r.totalTimeMs, 0);
  
  console.log('\n📈 SUMMARY:');
  console.log(`  Total Operations: ${totalOps.toLocaleString()}`);
  console.log(`  Total Time: ${totalTime.toFixed(2)}ms`);
  console.log(`  Overall Ops/sec: ${(totalOps / totalTime * 1000).toFixed(0)}`);
}

// ========================================
// Run Benchmarks
// ========================================

export { runPerformanceBenchmarks };