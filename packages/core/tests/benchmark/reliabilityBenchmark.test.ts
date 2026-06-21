import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../src/runtime/circuitBreaker';
import { CircuitBreakerRegistry } from '../../src/runtime/circuitBreakerRegistry';
import { StateCheckpointer } from '../../src/runtime/stateCheckpointer';
import { DeadLetterQueue } from '../../src/runtime/deadLetterQueue';
import { CompensationRegistry } from '../../src/runtime/compensationRegistry';
import { getBenchmarkRunner, BenchmarkResult } from './benchmarkRunner';

describe('Reliability Benchmarks', () => {
  const runner = getBenchmarkRunner();

  it('circuit breaker recovery time', async () => {
    const breaker = new CircuitBreaker(5);

    for (let i = 0; i < 5; i++) {
      breaker.onFailure();
    }

    expect(breaker.isAvailable()).toBe(false);

    const start = performance.now();
    await new Promise(resolve => setTimeout(resolve, 150));
    const recoveryTimeMs = performance.now() - start;

    breaker.isAvailable();
    breaker.onSuccess();
    breaker.onSuccess();
    breaker.onSuccess();

    const result: BenchmarkResult = {
      name: 'circuit_breaker_recovery_time',
      category: 'reliability',
      metrics: {
        failure_threshold: 5,
        actual_recovery_ms: Number(recoveryTimeMs.toFixed(2)),
        target_recovery_ms: 200,
      },
      timestamp: new Date().toISOString(),
      durationMs: recoveryTimeMs,
      passed: recoveryTimeMs < 200,
      threshold: 200,
      actual: recoveryTimeMs,
    };

    runner.addResult(result);
    expect(recoveryTimeMs).toBeLessThan(200);
  });

  it('checkpoint crash recovery', async () => {
    const checkpointer = new StateCheckpointer('/tmp/benchmark-recovery');
    const runId = 'recovery-test-1';

    const state1 = {
      runId,
      agentId: 'benchmark-agent',
      missionId: 'benchmark',
      timestamp: new Date().toISOString(),
      phase: 'tool_execution' as const,
      stepNumber: 5,
      attemptNumber: 1,
      messages: [{ role: 'user' as const, content: 'test message' }],
      tokenUsage: { input: 1000, output: 500 },
      stepDurations: [100, 200, 150, 180, 120],
      context: {
        agentId: 'benchmark-agent',
        missionId: 'benchmark',
        projectId: 'benchmark-project',
        goal: 'test goal',
        availableTools: [],
        maxSteps: 10,
        tokenBudget: 50000,
      },
      totalDurationMs: 750,
    };

    const start = performance.now();
    checkpointer.checkpoint(state1);
    const savedState = checkpointer.loadCheckpoint(runId);
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      name: 'checkpoint_crash_recovery',
      category: 'reliability',
      metrics: {
        state_size_bytes: JSON.stringify(state1).length,
        save_load_duration_ms: Number(durationMs.toFixed(2)),
        state_integrity: savedState?.stepNumber === 5,
        target_duration_ms: 50,
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: savedState?.stepNumber === 5 && durationMs < 50,
      threshold: 50,
      actual: durationMs,
    };

    runner.addResult(result);
    expect(savedState?.stepNumber).toBe(5);
  });

  it('dead letter queue throughput', async () => {
    const dlq = new DeadLetterQueue('/tmp/benchmark-dlq');
    const iterations = 1000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      dlq.record({
        category: 'TOOL_ERROR',
        operationName: `test-operation-${i}`,
        errorMessage: `Error ${i}`,
        runId: `run-${i}`,
        agentId: 'benchmark',
        missionId: 'benchmark-mission',
        timestamp: Date.now(),
      });
    }
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      name: 'dead_letter_queue_throughput',
      category: 'reliability',
      metrics: {
        total_enqueued: iterations,
        enqueue_duration_ms: Number(durationMs.toFixed(2)),
        enqueue_rate_per_sec: Number((iterations / (durationMs / 1000)).toFixed(0)),
        target_rate_per_sec: 10000,
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: iterations / (durationMs / 1000) >= 10000,
      threshold: 10000,
      actual: iterations / (durationMs / 1000),
    };

    runner.addResult(result);
    const rate = iterations / (durationMs / 1000);
    expect(rate).toBeGreaterThanOrEqual(10000);
  });

  it('compensation registry execution', async () => {
    const registry = new CompensationRegistry();
    const iterations = 100;

    const compensationCalls: number[] = [];
    registry.register('bench-tool', async (action) => {
      const idx = parseInt(action.actionId.replace('action-', ''), 10);
      compensationCalls.push(idx);
      return { success: true };
    });

    for (let i = 0; i < iterations; i++) {
      registry.recordAction({
        actionId: `action-${i}`,
        toolName: 'bench-tool',
        args: {},
        description: `test action ${i}`,
        tags: ['benchmark'],
      });
    }

    const start = performance.now();
    await registry.compensateAll();
    const durationMs = performance.now() - start;

    const result: BenchmarkResult = {
      name: 'compensation_registry_execution',
      category: 'reliability',
      metrics: {
        registered_compensations: iterations,
        executed_compensations: compensationCalls.length,
        execution_duration_ms: Number(durationMs.toFixed(2)),
        avg_compensation_ms: Number((durationMs / iterations).toFixed(3)),
        target_duration_ms: 100,
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: durationMs < 100 && compensationCalls.length === iterations,
      threshold: 100,
      actual: durationMs,
    };

    runner.addResult(result);
    expect(compensationCalls.length).toBe(iterations);
    expect(durationMs).toBeLessThan(100);
  });

  it('concurrent circuit breakers under load', async () => {
    const registry = new CircuitBreakerRegistry();
    const concurrency = 1000;
    const operationsPerBreaker = 100;

    for (let i = 0; i < 10; i++) {
      registry.register(`provider-${i}`);
    }

    const start = performance.now();
    const promises = Array.from({ length: concurrency }, (_, i) =>
      Promise.resolve(
        Array.from({ length: operationsPerBreaker }, () =>
          registry.get(`provider-${i % 10}`)!.isAvailable()
        )
      )
    );
    await Promise.all(promises);
    const durationMs = performance.now() - start;

    const totalOps = concurrency * operationsPerBreaker;
    const result: BenchmarkResult = {
      name: 'concurrent_circuit_breakers_load',
      category: 'reliability',
      metrics: {
        concurrent_breakers: 10,
        operations_per_breaker: operationsPerBreaker,
        total_operations: totalOps,
        total_duration_ms: Number(durationMs.toFixed(2)),
        ops_per_sec: Number((totalOps / (durationMs / 1000)).toFixed(0)),
        avg_latency_us: Number(((durationMs / totalOps) * 1000).toFixed(2)),
        target_ops_per_sec: 100000,
      },
      timestamp: new Date().toISOString(),
      durationMs,
      passed: totalOps / (durationMs / 1000) >= 100000,
      threshold: 100000,
      actual: totalOps / (durationMs / 1000),
    };

    runner.addResult(result);
    const rate = totalOps / (durationMs / 1000);
    expect(rate).toBeGreaterThanOrEqual(100000);
  });
});
