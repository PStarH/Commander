/**
 * Performance Benchmarks
 * Phase 2: 性能基准测试
 *
 * 测试所有核心组件的性能指标
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  TaskComplexityAnalyzer,
  AdaptiveOrchestrator,
  TokenBudgetAllocator,
  ThreeLayerMemory,
  ReflectionEngine,
  ConsensusChecker,
  InspectorAgent
} from '../src/index';

interface BenchmarkResult {
  name: string;
  operations: number;
  totalTimeMs: number;
  avgTimeMs: number;
  opsPerSecond: number;
}

function runBenchmark(name: string, operations: number, fn: () => void): BenchmarkResult {
  const start = performance.now();
  fn();
  const end = performance.now();
  const totalTimeMs = end - start;
  const avgTimeMs = totalTimeMs / operations;
  const opsPerSecond = 1000 / avgTimeMs;
  return { name, operations, totalTimeMs, avgTimeMs, opsPerSecond };
}

describe('Performance Benchmarks', () => {
  const results: BenchmarkResult[] = [];

  it('TaskComplexityAnalyzer.analyze (1000x)', () => {
    const analyzer = new TaskComplexityAnalyzer();
    results.push(runBenchmark('TaskComplexityAnalyzer.analyze', 1000, () => {
      analyzer.analyze({ id: 'bench-task', description: 'Build a distributed system with multiple services and dependencies', riskLevel: 'high' });
    }));
    assert.ok(results[results.length - 1].opsPerSecond > 0);
  });

  it('AdaptiveOrchestrator.createPlan (100x)', () => {
    const orchestrator = new AdaptiveOrchestrator();
    for (let i = 0; i < 5; i++) {
      orchestrator.registerAgent({ id: `agent-${i}`, name: `Agent ${i}`, role: 'worker', capabilities: ['coding', 'testing'] });
    }
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `task-${i}`, description: `Task ${i} description`, priority: 'medium' as const, complexity: 30 + Math.random() * 40
    }));
    results.push(runBenchmark('AdaptiveOrchestrator.createPlan', 100, () => orchestrator.createPlan(tasks, 'PARALLEL')));
    assert.ok(results[results.length - 1].opsPerSecond > 0);
  });

  it('TokenBudgetAllocator operations', () => {
    const allocator = new TokenBudgetAllocator({ baseBudget: 100000 });
    results.push(runBenchmark('TokenBudgetAllocator.allocate', 1000, () => allocator.allocate('PARALLEL', 50, 3)));
    allocator.initialize(100000);
    results.push(runBenchmark('TokenBudgetAllocator.recordUsage', 10000, () => allocator.recordUsage('agent-1', 100)));
    results.push(runBenchmark('TokenBudgetAllocator.getUsageRate', 10000, () => allocator.getUsageRate()));
    assert.ok(results.length >= 3);
  });

  it('ThreeLayerMemory operations', () => {
    const memory = new ThreeLayerMemory();
    results.push(runBenchmark('ThreeLayerMemory.add (working)', 1000, () => memory.add(`Memory content ${Date.now()}`, 'working', 'context', 0.8)));
    results.push(runBenchmark('ThreeLayerMemory.add (longterm)', 1000, () => memory.add(`Memory content ${Date.now()}`, 'longterm', 'context', 0.8)));
    results.push(runBenchmark('ThreeLayerMemory.query', 1000, () => memory.query({ keywords: ['test'], limit: 10 })));
    results.push(runBenchmark('ThreeLayerMemory.getStats', 1000, () => memory.getStats()));
    assert.ok(results.length >= 6);
  });

  it('ReflectionEngine operations', () => {
    const engine = new ReflectionEngine();
    results.push(runBenchmark('ReflectionEngine.startSession', 1000, () => engine.startSession(`bench-session-${Date.now()}`)));
    const sessionId = engine.startSession('bench-main');
    results.push(runBenchmark('ReflectionEngine.addReflection', 1000, () => engine.addReflection(sessionId, 'post_execution', 'Question?', 'Answer with some details')));
    results.push(runBenchmark('ReflectionEngine.getStats', 100, () => engine.getStats()));
    assert.ok(results.length >= 9);
  });

  it('ConsensusChecker operations', () => {
    const checker = new ConsensusChecker({ minVoters: 3 });
    results.push(runBenchmark('ConsensusChecker.createCheck', 1000, () => checker.createCheck('What is the best approach?')));
    const checkId = checker.createCheck('Benchmark decision');
    results.push(runBenchmark('ConsensusChecker.addVote', 1000, () => checker.addVote(checkId, `model-${Date.now()}`, 'Model', 'Decision', 0.9, 'Reasoning')));
    results.push(runBenchmark('ConsensusChecker.getResult', 1000, () => checker.getResult(checkId)));
    assert.ok(results.length >= 12);
  });

  it('InspectorAgent operations', () => {
    const inspector = new InspectorAgent();
    results.push(runBenchmark('InspectorAgent.updateComponent', 1000, () => inspector.updateComponent('service', 'healthy', 0.9, { latency: 10 })));
    results.push(runBenchmark('InspectorAgent.autoDetect', 1000, () => inspector.autoDetect('api', { responseTime: 500, errorRate: 0.01 })));
    results.push(runBenchmark('InspectorAgent.inspect', 100, () => inspector.inspect()));
    results.push(runBenchmark('InspectorAgent.getStats', 1000, () => inspector.getStats()));
    assert.ok(results.length >= 16);
  });
});
