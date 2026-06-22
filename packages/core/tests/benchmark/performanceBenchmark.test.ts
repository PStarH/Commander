import { describe, it, expect } from 'vitest';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';
import { CircuitBreaker } from '../../src/runtime/circuitBreaker';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { deliberate } from '../../src/ultimate/deliberation';
import { getBenchmarkRunner, BenchmarkResult } from './benchmarkRunner';

function realisticGoal(i: number): string {
  const goals = [
    'Fix the null pointer exception in the auth middleware when token is missing',
    'Add input validation to the user registration endpoint',
    'Refactor the database connection pool to handle connection timeouts',
    'Write unit tests for the payment processing module',
    'Implement rate limiting on the API gateway',
    'Debug the memory leak in the WebSocket connection handler',
    'Add CORS headers for the mobile app frontend domain',
    'Optimize the SQL query in the dashboard analytics endpoint',
    'Set up health check endpoints for load balancer integration',
    'Add structured logging for all API error responses',
  ];
  return goals[i % goals.length];
}

describe('Performance Benchmarks', () => {
  const runner = getBenchmarkRunner();

  it('topology selection latency', () => {
    const router = new TopologyRouter();
    const iterations = 100;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const plan = deliberate(realisticGoal(i));
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
    expect(p99).toBeLessThan(20);
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

    for (let i = 0; i < iterations; i++) {
      const state = {
        runId: `run-${i}`,
        agentId: 'bench',
        phase: 'execution' as const,
        stepNumber: i,
        attemptNumber: 1,
        messages: [{ role: 'user' as const, content: 'test' }],
        tokenUsage: { input: 100, output: 50, total: 150 },
        stepDurations: [],
        context: {
          agentId: 'bench',
          projectId: 'bench',
          goal: 'benchmark',
          availableTools: [],
          maxSteps: 100,
          tokenBudget: 100000,
        },
        totalDurationMs: 0,
      };

      const start = performance.now();
      checkpointer.checkpoint(state);
      const loaded = checkpointer.loadCheckpoint(`run-${i}`);
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
        ops_per_sec: Number(
          (1000 / (latencies.reduce((a, b) => a + b, 0) / iterations)).toFixed(1),
        ),
      },
      timestamp: new Date().toISOString(),
      durationMs: latencies.reduce((a, b) => a + b, 0),
      passed: p99 < 50,
      threshold: 50,
      actual: p99,
    };

    runner.addResult(result);
    expect(p99).toBeLessThan(200);
  });
});
