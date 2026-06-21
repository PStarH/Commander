import { describe, it, expect } from 'vitest';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';
import { CircuitBreaker } from '../../src/runtime/circuitBreaker';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { DeliberationPlan } from '../../src/ultimate/types';
import { getBenchmarkRunner, BenchmarkResult } from './benchmarkRunner';

function createDeliberationPlan(taskType: 'CODING' | 'RESEARCH'): DeliberationPlan {
  return {
    requiresExternalInfo: false,
    taskType,
    recommendedTopology: 'SINGLE',
    estimatedAgentCount: 1,
    estimatedSteps: 5,
    estimatedTokens: 10000,
    estimatedDurationMs: 30000,
    tokenBudget: { thinking: 2000, execution: 7000, synthesis: 1000 },
    decompositionStrategy: 'NONE',
    capabilitiesNeeded: [],
    confidence: 0.8,
    reasoning: ['test task'],
    suitableForSpeculation: false,
    taskNature: 'COMPUTE_BOUND',
    timeBudgetPerAgentMs: 30000,
  };
}

describe('Performance Benchmarks', () => {
  const runner = getBenchmarkRunner();

  it('topology selection latency', () => {
    const router = new TopologyRouter();
    const iterations = 100;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const plan = createDeliberationPlan(i % 2 === 0 ? 'CODING' : 'RESEARCH');
      const start = performance.now();
      router.route(plan);
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const result: BenchmarkResult = {
      name: 'topology_selection_latency',
      category: 'performance',
      metrics: {
        iterations,
        p50_ms: Number(p50.toFixed(3)),
        p95_ms: Number(p95.toFixed(3)),
        p99_ms: Number(p99.toFixed(3)),
        avg_ms: Number((latencies.reduce((a, b) => a + b, 0) / iterations).toFixed(3)),
        target_p99_ms: 10,
      },
      timestamp: new Date().toISOString(),
      durationMs: latencies.reduce((a, b) => a + b, 0),
      passed: p99 < 10,
      threshold: 10,
      actual: p99,
    };

    runner.addResult(result);
    expect(p99).toBeLessThan(10);
  });

  it('token governor state calculation', () => {
    const governor = new TokenGovernor({
      totalBudget: 100000,
      thresholds: {
        relaxed: 0.6,
        moderate: 0.8,
        tight: 0.9,
        critical: 0.95,
      },
      enableLearning: false,
    });

    const iterations = 1000;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      governor.getState();
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const result: BenchmarkResult = {
      name: 'token_governor_state_calculation',
      category: 'performance',
      metrics: {
        iterations,
        p50_us: Number((p50 * 1000).toFixed(2)),
        p99_us: Number((p99 * 1000).toFixed(2)),
        target_p99_us: 100,
      },
      timestamp: new Date().toISOString(),
      durationMs: latencies.reduce((a, b) => a + b, 0),
      passed: p99 < 0.1,
      threshold: 0.1,
      actual: p99,
    };

    runner.addResult(result);
    expect(p99).toBeLessThan(0.1);
  });

  it('circuit breaker state transitions', () => {
    const breaker = new CircuitBreaker(5);

    const iterations = 1000;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      breaker.isAvailable();
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const result: BenchmarkResult = {
      name: 'circuit_breaker_state_transitions',
      category: 'performance',
      metrics: {
        iterations,
        p50_us: Number((p50 * 1000).toFixed(2)),
        p99_us: Number((p99 * 1000).toFixed(2)),
        target_p99_us: 100,
      },
      timestamp: new Date().toISOString(),
      durationMs: latencies.reduce((a, b) => a + b, 0),
      passed: p99 < 0.1,
      threshold: 0.1,
      actual: p99,
    };

    runner.addResult(result);
    expect(p99).toBeLessThan(0.1);
  });

  it('checkpoint write/read cycle', async () => {
    const checkpointer = new StateCheckpointer('/tmp/benchmark-checkpoints');
    const iterations = 100;
    const latencies: number[] = [];

    const state = {
      runId: 'bench-1',
      phase: 'execution' as const,
      stepNumber: 1,
      messages: [{ role: 'user' as const, content: 'test' }],
      tokenUsage: { input: 100, output: 50 },
      context: {} as any,
    };

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await checkpointer.checkpoint(`run-${i}`, state);
      await checkpointer.loadCheckpoint(`run-${i}`);
      latencies.push(performance.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const result: BenchmarkResult = {
      name: 'checkpoint_write_read_cycle',
      category: 'performance',
      metrics: {
        iterations,
        p50_ms: Number(p50.toFixed(2)),
        p95_ms: Number(p95.toFixed(2)),
        p99_ms: Number(p99.toFixed(2)),
        ops_per_sec: Number((1000 / (latencies.reduce((a, b) => a + b, 0) / iterations)).toFixed(1)),
      },
      timestamp: new Date().toISOString(),
      durationMs: latencies.reduce((a, b) => a + b, 0),
      passed: p99 < 50,
      threshold: 50,
      actual: p99,
    };

    runner.addResult(result);
    expect(p99).toBeLessThan(50);
  });
});
