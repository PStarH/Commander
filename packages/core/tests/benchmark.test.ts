/**
 * Performance Benchmarks
 * Phase 2: 性能基准测试
 * 
 * 测试各组件的性能指标
 */

import { describe, it, before } from 'node:test';
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

// ========================================
// Benchmark Utilities
// ========================================

interface BenchmarkResult {
  name: string;
  iterations: number;
  totalTime: number;
  avgTime: number;
  opsPerSecond: number;
  memoryUsed?: number;
}

function benchmark(
  name: string,
  iterations: number,
  fn: () => void
): BenchmarkResult {
  // Warm up
  for (let i = 0; i < 3; i++) fn();

  // Actual benchmark
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();

  const totalTime = end - start;
  const avgTime = totalTime / iterations;
  const opsPerSecond = 1000 / avgTime;

  return {
    name,
    iterations,
    totalTime,
    avgTime,
    opsPerSecond
  };
}

function printResults(results: BenchmarkResult[]) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 Performance Benchmark Results');
  console.log('='.repeat(70));
  console.log('\nComponent              Iterations   Total(ms)   Avg(μs)    Ops/sec');
  console.log('-'.repeat(70));

  for (const r of results) {
    const name = r.name.padEnd(22);
    const iters = r.iterations.toString().padStart(11);
    const total = r.totalTime.toFixed(2).padStart(10);
    const avg = (r.avgTime * 1000).toFixed(2).padStart(10);
    const ops = r.opsPerSecond.toFixed(0).padStart(10);
    console.log(`${name}${iters}${total}${avg}${ops}`);
  }

  console.log('-'.repeat(70));
}

// ========================================
// Benchmarks
// ========================================

describe('Performance Benchmarks', () => {
  const ITERATIONS = 1000;

  // ========================================
  // Task Complexity Analyzer
  // ========================================
  describe('TaskComplexityAnalyzer', () => {
    let analyzer: TaskComplexityAnalyzer;

    before(() => {
      analyzer = new TaskComplexityAnalyzer();
    });

    it('analyze simple task', () => {
      const task = {
        id: 'bench-1',
        description: 'Write a simple function',
        riskLevel: 'low' as const
      };
      
      const result = benchmark('TaskComplexityAnalyzer.analyze()', ITERATIONS, () => {
        analyzer.analyze(task);
      });

      assert.ok(result.avgTime < 1); // Should be < 1ms
      console.log(`\n✓ TaskComplexityAnalyzer.analyze(): ${result.avgTime.toFixed(3)}ms avg`);
    });
  });

  // ========================================
  // Adaptive Orchestrator
  // ========================================
  describe('AdaptiveOrchestrator', () => {
    let orchestrator: AdaptiveOrchestrator;

    before(() => {
      orchestrator = new AdaptiveOrchestrator();
      for (let i = 0; i < 5; i++) {
        orchestrator.registerAgent({
          id: `agent-${i}`,
          name: `Agent ${i}`,
          role: 'worker',
          capabilities: ['coding', 'testing']
        });
      }
    });

    it('createPlan SEQUENTIAL', () => {
      const tasks = [{
        id: 'bench-1',
        description: 'Simple task',
        complexity: 20,
        priority: 'low' as const
      }];

      const result = benchmark('Orchestrator.createPlan()', ITERATIONS, () => {
        orchestrator.createPlan(tasks, 'SEQUENTIAL');
      });

      assert.ok(result.avgTime < 5); // Should be < 5ms
      console.log(`\n✓ Orchestrator.createPlan(): ${result.avgTime.toFixed(3)}ms avg`);
    });

    it('createPlan PARALLEL (10 agents)', () => {
      const orchestratorLarge = new AdaptiveOrchestrator();
      for (let i = 0; i < 10; i++) {
        orchestratorLarge.registerAgent({
          id: `agent-${i}`,
          name: `Agent ${i}`,
          role: 'worker',
          capabilities: ['coding']
        });
      }

      const tasks = Array.from({ length: 10 }, (_, i) => ({
        id: `task-${i}`,
        description: 'Task',
        complexity: 30,
        priority: 'medium' as const
      }));

      const result = benchmark('Orchestrator.createPlan(PARALLEL)', ITERATIONS / 10, () => {
        orchestratorLarge.createPlan(tasks, 'PARALLEL');
      });

      assert.ok(result.avgTime < 20);
      console.log(`\n✓ Orchestrator.createPlan(PARALLEL): ${result.avgTime.toFixed(3)}ms avg`);
    });
  });

  // ========================================
  // Token Budget Allocator
  // ========================================
  describe('TokenBudgetAllocator', () => {
    let allocator: TokenBudgetAllocator;

    before(() => {
      allocator = new TokenBudgetAllocator({ baseBudget: 100000 });
    });

    it('allocate', () => {
      const result = benchmark('TokenBudget.allocate()', ITERATIONS, () => {
        allocator.allocate('SEQUENTIAL', 50, 3);
      });

      assert.ok(result.avgTime < 0.5); // Should be very fast
      console.log(`\n✓ TokenBudget.allocate(): ${(result.avgTime * 1000).toFixed(3)}μs avg`);
    });

    it('recordUsage + getUsageRate', () => {
      allocator.initialize(100000);

      const result = benchmark('TokenBudget.recordUsage()', ITERATIONS, () => {
        allocator.recordUsage('agent-1', 100);
        allocator.getUsageRate();
      });

      assert.ok(result.avgTime < 0.2);
      console.log(`\n✓ TokenBudget.recordUsage(): ${(result.avgTime * 1000).toFixed(3)}μs avg`);
    });
  });

  // ========================================
  // Three-Layer Memory
  // ========================================
  describe('ThreeLayerMemory', () => {
    let memory: ThreeLayerMemory;

    before(() => {
      memory = new ThreeLayerMemory();
    });

    it('add + get', () => {
      let entryId: string;

      const result = benchmark('Memory.add()', ITERATIONS, () => {
        const entry = memory.add(
          'Test content',
          'working',
          'context',
          0.8,
          ['test']
        );
        entryId = entry.id;
      });

      assert.ok(result.avgTime < 1);
      console.log(`\n✓ Memory.add(): ${(result.avgTime * 1000).toFixed(3)}μs avg`);
    });

    it('query (100 entries)', () => {
      // Pre-populate
      for (let i = 0; i < 100; i++) {
        memory.add(`Content ${i}`, 'longterm', 'context', 0.5, ['test']);
      }

      const result = benchmark('Memory.query() [100 entries]', ITERATIONS / 10, () => {
        memory.query({ keywords: ['Content'], limit: 10 });
      });

      assert.ok(result.avgTime < 5);
      console.log(`\n✓ Memory.query(): ${result.avgTime.toFixed(3)}ms avg [100 entries]`);
    });

    it('getWorkingContext', () => {
      // Pre-populate
      for (let i = 0; i < 20; i++) {
        memory.add(`Working ${i}`, 'working', 'context', 0.7);
        memory.add(`Episodic ${i}`, 'episodic', 'context', 0.6);
        memory.add(`Longterm ${i}`, 'longterm', 'context', 0.5);
      }

      const result = benchmark('Memory.getWorkingContext()', ITERATIONS, () => {
        memory.getWorkingContext(10);
      });

      assert.ok(result.avgTime < 2);
      console.log(`\n✓ Memory.getWorkingContext(): ${result.avgTime.toFixed(3)}ms avg`);
    });
  });

  // ========================================
  // Reflection Engine
  // ========================================
  describe('ReflectionEngine', () => {
    let engine: ReflectionEngine;

    before(() => {
      engine = new ReflectionEngine();
    });

    it('startSession + addReflection', () => {
      const result = benchmark('ReflectionEngine.session()', ITERATIONS, () => {
        const sessionId = engine.startSession('bench-task');
        engine.addReflection(sessionId, 'post_execution', 'How?', 'Good');
      });

      assert.ok(result.avgTime < 2);
      console.log(`\n✓ ReflectionEngine.session(): ${result.avgTime.toFixed(3)}ms avg`);
    });

    it('getStats (100 sessions)', () => {
      // Pre-populate
      for (let i = 0; i < 100; i++) {
        const sessionId = engine.startSession(`task-${i}`);
        engine.addReflection(sessionId, 'post_execution', 'Result?', 'Success');
        engine.completeSession(sessionId, 'success');
      }

      const result = benchmark('ReflectionEngine.getStats() [100 sessions]', ITERATIONS / 10, () => {
        engine.getStats();
      });

      assert.ok(result.avgTime < 5);
      console.log(`\n✓ ReflectionEngine.getStats(): ${result.avgTime.toFixed(3)}ms avg [100 sessions]`);
    });
  });

  // ========================================
  // Consensus Checker
  // ========================================
  describe('ConsensusChecker', () => {
    let checker: ConsensusChecker;

    before(() => {
      checker = new ConsensusChecker({ minVoters: 3 });
    });

    it('createCheck + addVote', () => {
      const result = benchmark('ConsensusChecker.vote()', ITERATIONS, () => {
        const checkId = checker.createCheck('Question?');
        checker.addVote(checkId, 'm1', 'Model A', 'Yes', 0.9, 'Good');
      });

      assert.ok(result.avgTime < 2);
      console.log(`\n✓ ConsensusChecker.vote(): ${result.avgTime.toFixed(3)}ms avg`);
    });

    it('getResult (3 votes)', () => {
      const checkId = checker.createCheck('Question?');
      checker.addVote(checkId, 'm1', 'Model A', 'Yes', 0.9, 'Good');
      checker.addVote(checkId, 'm2', 'Model B', 'Yes', 0.85, 'OK');
      checker.addVote(checkId, 'm3', 'Model C', 'Yes', 0.88, 'Fine');

      const result = benchmark('ConsensusChecker.getResult()', ITERATIONS, () => {
        checker.getResult(checkId);
      });

      assert.ok(result.avgTime < 1);
      console.log(`\n✓ ConsensusChecker.getResult(): ${result.avgTime.toFixed(3)}ms avg`);
    });
  });

  // ========================================
  // Inspector Agent
  // ========================================
  describe('InspectorAgent', () => {
    let inspector: InspectorAgent;

    before(() => {
      inspector = new InspectorAgent();
    });

    it('updateComponent + inspect', () => {
      inspector.updateComponent('test-service', 'healthy', 0.9, { latency: 100 });

      const result = benchmark('InspectorAgent.inspect()', ITERATIONS, () => {
        inspector.inspect();
      });

      assert.ok(result.avgTime < 3);
      console.log(`\n✓ InspectorAgent.inspect(): ${result.avgTime.toFixed(3)}ms avg`);
    });

    it('autoDetect issues', () => {
      const result = benchmark('InspectorAgent.autoDetect()', ITERATIONS, () => {
        inspector.autoDetect('api', {
          responseTime: 2000,
          errorRate: 0.1,
          memoryUsage: 0.85
        });
      });

      assert.ok(result.avgTime < 2);
      console.log(`\n✓ InspectorAgent.autoDetect(): ${result.avgTime.toFixed(3)}ms avg`);
    });
  });

  // ========================================
  // Full Workflow Benchmark
  // ========================================
  describe('Full Workflow', () => {
    it('analyze → allocate → plan → memory → reflect → inspect', () => {
      const analyzer = new TaskComplexityAnalyzer();
      const allocator = new TokenBudgetAllocator();
      const orchestrator = new AdaptiveOrchestrator();
      const memory = new ThreeLayerMemory();
      const reflection = new ReflectionEngine();
      const inspector = new InspectorAgent();

      orchestrator.registerAgent({
        id: 'lead',
        name: 'Lead',
        role: 'architect',
        capabilities: ['design']
      });

      const result = benchmark('Full Workflow', ITERATIONS / 10, () => {
        // 1. Analyze
        const complexity = analyzer.analyze({
          id: 'wf-task',
          description: 'Build feature',
          riskLevel: 'medium'
        });

        // 2. Allocate
        const budget = allocator.allocate(complexity.recommendedMode, complexity.score, 2);

        // 3. Plan
        const plan = orchestrator.createPlan([{
          id: 'wf-task',
          description: 'Build feature',
          complexity: complexity.score,
          priority: 'medium' as const
        }], complexity.recommendedMode);

        // 4. Memory
        memory.add('Task started', 'working', 'wf-task', 0.8);

        // 5. Reflect
        const sessionId = reflection.startSession('wf-task');
        reflection.addReflection(sessionId, 'post_execution', 'Result?', 'Done');
        reflection.completeSession(sessionId, 'success');

        // 6. Inspect
        inspector.updateComponent('workflow', 'healthy', 0.95);
        inspector.inspect();
      });

      assert.ok(result.avgTime < 50); // Full workflow should be < 50ms
      console.log(`\n✓ Full Workflow: ${result.avgTime.toFixed(3)}ms avg`);
    });
  });

  // ========================================
  // Scalability Tests
  // ========================================
  describe('Scalability', () => {
    it('Memory handles 1000 entries', () => {
      const memory = new ThreeLayerMemory();
      
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        memory.add(`Content ${i}`, 'longterm', 'context', 0.5);
      }
      const writeTime = performance.now() - start;

      const queryStart = performance.now();
      const results = memory.query({ keywords: ['Content'], limit: 50 });
      const queryTime = performance.now() - queryStart;

      console.log(`\n✓ Memory 1000 entries: write=${writeTime.toFixed(1)}ms, query=${queryTime.toFixed(1)}ms`);
      assert.ok(results.length > 0);
    });

    it('Reflection handles 500 sessions', () => {
      const engine = new ReflectionEngine();
      
      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        const sessionId = engine.startSession(`task-${i}`);
        engine.addReflection(sessionId, 'post_execution', 'Result?', 'Good');
        engine.completeSession(sessionId, 'success');
      }
      const createTime = performance.now() - start;

      const statsStart = performance.now();
      const stats = engine.getStats();
      const statsTime = performance.now() - statsStart;

      console.log(`\n✓ Reflection 500 sessions: create=${createTime.toFixed(1)}ms, getStats=${statsTime.toFixed(1)}ms`);
      assert.strictEqual(stats.totalSessions, 500);
    });

    it('Inspector handles 50 components', () => {
      const inspector = new InspectorAgent();
      
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        inspector.updateComponent(`service-${i}`, 'healthy', 0.8 + Math.random() * 0.2, {
          latency: 50 + Math.random() * 100
        });
      }
      const updateTime = performance.now() - start;

      const reportStart = performance.now();
      const report = inspector.inspect();
      const reportTime = performance.now() - reportStart;

      console.log(`\n✓ Inspector 50 components: update=${updateTime.toFixed(1)}ms, report=${reportTime.toFixed(1)}ms`);
      assert.strictEqual(report.components.length, 50);
    });
  });
});