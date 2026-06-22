import { describe, it, expect } from 'vitest';
import { TopologyRouter } from '../../src/ultimate/topologyRouter';
import { TokenGovernor } from '../../src/runtime/tokenGovernor';
import { CircuitBreakerRegistry } from '../../src/runtime/circuitBreakerRegistry';
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

describe('Load Benchmarks', () => {
  const runner = getBenchmarkRunner();

  it('concurrent topology selection (1000 requests)', async () => {
    const router = new TopologyRouter();
    const concurrency = 1000;

    const start = performance.now();
    const promises = Array.from({ length: concurrency }, (_, i) => {
      const plan = deliberate(realisticGoal(i));
      return Promise.resolve(router.route(plan));
    });
    await Promise.all(promises);
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      name: 'concurrent_topology_selection',
      category: 'load',
      metrics: {
        concurrent_requests: concurrency,
        total_duration_ms: Number(durationMs.toFixed(2)),
        requests_per_sec: Number((concurrency / (durationMs / 1000)).toFixed(0)),
        avg_latency_ms: Number((durationMs / concurrency).toFixed(3)),
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: durationMs < 5000,
      threshold: 5000,
      actual: durationMs,
    };

    runner.addResult(result);
    expect(durationMs).toBeLessThan(5000);
  });

  it('concurrent token governor checks (10000 requests)', async () => {
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

    const concurrency = 10000;
    const start = performance.now();

    const promises = Array.from({ length: concurrency }, () =>
      Promise.resolve(governor.getState()),
    );
    await Promise.all(promises);
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      name: 'concurrent_token_governor_checks',
      category: 'load',
      metrics: {
        concurrent_requests: concurrency,
        total_duration_ms: Number(durationMs.toFixed(2)),
        requests_per_sec: Number((concurrency / (durationMs / 1000)).toFixed(0)),
        avg_latency_ms: Number((durationMs / concurrency).toFixed(4)),
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: durationMs < 3000,
      threshold: 3000,
      actual: durationMs,
    };

    runner.addResult(result);
    expect(durationMs).toBeLessThan(3000);
  });

  it('concurrent circuit breaker operations (100000 requests)', async () => {
    const registry = new CircuitBreakerRegistry();
    const concurrency = 100000;

    for (let i = 0; i < 10; i++) {
      registry.register(`provider-${i}`);
    }

    const start = performance.now();

    const promises = Array.from({ length: concurrency }, (_, i) =>
      Promise.resolve(registry.get(`provider-${i % 10}`)!.isAvailable()),
    );
    await Promise.all(promises);
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      name: 'concurrent_circuit_breaker_ops',
      category: 'load',
      metrics: {
        concurrent_requests: concurrency,
        total_duration_ms: Number(durationMs.toFixed(2)),
        requests_per_sec: Number((concurrency / (durationMs / 1000)).toFixed(0)),
        avg_latency_us: Number(((durationMs / concurrency) * 1000).toFixed(2)),
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: durationMs < 2000,
      threshold: 2000,
      actual: durationMs,
    };

    runner.addResult(result);
    expect(durationMs).toBeLessThan(2000);
  });

  it('sustained load (10000 sequential requests)', async () => {
    const router = new TopologyRouter();
    const requests = 10000;
    const latencies: number[] = [];

    const start = performance.now();
    for (let i = 0; i < requests; i++) {
      const plan = deliberate(realisticGoal(i));
      const reqStart = performance.now();
      router.route(plan);
      latencies.push(performance.now() - reqStart);
    }
    const totalDurationMs = performance.now() - start;

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    const result: BenchmarkResult = {
      name: 'sustained_load_sequential',
      category: 'load',
      metrics: {
        total_requests: requests,
        total_duration_ms: Number(totalDurationMs.toFixed(2)),
        requests_per_sec: Number((requests / (totalDurationMs / 1000)).toFixed(0)),
        p50_ms: Number(p50.toFixed(3)),
        p95_ms: Number(p95.toFixed(3)),
        p99_ms: Number(p99.toFixed(3)),
      },
      timestamp: new Date().toISOString(),
      durationMs: totalDurationMs,
      passed: p99 < 5,
      threshold: 5,
      actual: p99,
    };

    runner.addResult(result);
    expect(p99).toBeLessThan(5);
  });
});
