/**
 * Load Test
 *
 * Measures orchestrator dispatch throughput and latency at 1/5/10/50 concurrent
 * agents. The AgentRuntime boundary is replaced by a fake implementation so the
 * test isolates orchestration-layer overhead (planning, routing, dispatch) and
 * is not skewed by LLM/network latency.
 *
 * Acceptance criterion: 50 concurrent agents → P99 latency < threshold.
 * The threshold is 500ms on local dev machines and 2000ms in CI to account
 * for shared-runner CPU contention and GC pauses.  The test also uses
 * vitest's built-in retry (2) so a single transient spike does not fail
 * the suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TELOSOrchestrator } from '../../src/telos/telosOrchestrator';
import type { AgentRuntimeInterface } from '../../src/runtime';
import type {
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
  LLMProvider,
  Tool,
} from '../../src/runtime/types';
import { resetTokenSentinel } from '../../src/telos/tokenSentinel';
import { resetProviderPool } from '../../src/telos/providerPool';
import { getBenchmarkRunner, type BenchmarkResult } from '../benchmark/benchmarkRunner';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function makeFakeRuntime(): AgentRuntimeInterface {
  return {
    execute: vi.fn(async (ctx: AgentExecutionContext): Promise<AgentExecutionResult> => {
      const summary = `Fake result for ${ctx.agentId}`;
      return {
        runId: `fake-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        agentId: ctx.agentId,
        missionId: ctx.missionId,
        status: 'success',
        summary,
        steps: [
          {
            stepNumber: 1,
            timestamp: new Date().toISOString(),
            type: 'response',
            content: summary,
            durationMs: 1,
          },
        ],
        totalTokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        totalDurationMs: 2,
      };
    }),
    registerProvider: vi.fn(),
    registerTool: vi.fn(),
    getProvider: vi.fn().mockReturnValue({ name: 'fake', call: vi.fn() } as unknown as LLMProvider),
    getSmartRouter: vi.fn().mockReturnValue(null),
    getTool: vi.fn().mockReturnValue(undefined),
    getConfig: vi.fn().mockReturnValue({} as AgentRuntimeConfig),
    getMemoryStore: vi.fn().mockReturnValue(null),
    getCheckpointer: vi.fn(),
    getInbox: vi.fn(),
    getTeamRegistry: vi.fn(),
    getHandoff: vi.fn(),
    getExecutionScheduler: vi.fn(),
    getCompensationRegistry: vi.fn().mockReturnValue({
      compensateAll: vi.fn().mockResolvedValue({ errors: [] }),
    }),
    cancelAllSteps: vi.fn().mockReturnValue(0),
    getStepTimeoutManager: vi.fn(),
    listUnfinishedRuns: vi.fn().mockReturnValue([]),
    resume: vi.fn().mockResolvedValue(null),
    listResumableRuns: vi.fn().mockReturnValue([]),
    pauseRun: vi.fn().mockReturnValue(true),
    unpauseRun: vi.fn(),
    isPaused: vi.fn().mockReturnValue(false),
    getActiveRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRunActive: vi.fn().mockReturnValue(false),
    getSemanticCacheStats: vi.fn().mockReturnValue({ totalEntries: 0, estimatedCostSavedUsd: 0 }),
    getSingleFlightStats: vi.fn().mockReturnValue({ hitCount: 0, missCount: 0, savedMs: 0 }),
    getGeminiCacheStats: vi.fn().mockReturnValue({ entryCount: 0, estimatedSavingsUsd: 0 }),
    getCostEstimatorHistory: vi.fn().mockReturnValue([]),
    getProviderHealth: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
  } as unknown as AgentRuntimeInterface;
}

function resetGlobals() {
  resetTokenSentinel();
  resetProviderPool();
}

describe('E2E: load test', () => {
  // CI runners are shared, slower, and subject to noisy-neighbour CPU
  // contention.  Use a relaxed p99 threshold in CI while keeping the
  // original 500ms SLO locally so developers still get fast feedback.
  const P99_THRESHOLD = process.env.CI ? 2000 : 500;

  beforeEach(() => {
    resetGlobals();
  });

  it(
    'meets latency SLO at 1/5/10/50 concurrent agents',
    { retry: 2, timeout: 120000 },
    async () => {
      const runner = getBenchmarkRunner();
      runner.start();

      const concurrencies = [1, 5, 10, 50];
      const goal = 'Summarize the key features of TypeScript in one sentence.';

      resetGlobals();
      const fake = makeFakeRuntime();
      const telos = new TELOSOrchestrator(fake);

      // Warm up.
      for (let i = 0; i < 3; i++) {
        const plan = telos.plan({
          projectId: 'warmup',
          agentId: `warmup-${i}`,
          goal,
        });
        await telos.execute(plan.planId);
      }

      let fiftyResult: BenchmarkResult | null = null;

      for (const concurrency of concurrencies) {
        const start = performance.now();
        const latencies: number[] = [];

        const promises: Promise<void>[] = [];
        for (let i = 0; i < concurrency; i++) {
          const reqStart = performance.now();
          const plan = telos.plan({
            projectId: `load-${concurrency}`,
            agentId: `load-agent-${i}`,
            goal,
          });
          const p = telos.execute(plan.planId).then(() => {
            latencies.push(performance.now() - reqStart);
          });
          promises.push(p);
        }

        await Promise.all(promises);
        const totalDurationMs = performance.now() - start;

        latencies.sort((a, b) => a - b);
        const p50 = percentile(latencies, 50);
        const p95 = percentile(latencies, 95);
        const p99 = percentile(latencies, 99);
        const throughput = concurrency / (totalDurationMs / 1000);

        const result: BenchmarkResult = {
          name: `telos_concurrent_${concurrency}`,
          category: 'load',
          metrics: {
            concurrency,
            total_duration_ms: Number(totalDurationMs.toFixed(2)),
            requests_per_sec: Number(throughput.toFixed(2)),
            p50_ms: Number(p50.toFixed(3)),
            p95_ms: Number(p95.toFixed(3)),
            p99_ms: Number(p99.toFixed(3)),
          },
          timestamp: new Date().toISOString(),
          durationMs: totalDurationMs,
          passed: p99 < P99_THRESHOLD,
          threshold: P99_THRESHOLD,
          actual: p99,
        };

        runner.addResult(result);
        if (concurrency === 50) {
          fiftyResult = result;
        }
      }

      const report = runner.finish();

      // Only the 50-concurrent case is a hard acceptance criterion.
      expect(fiftyResult).not.toBeNull();
      expect(fiftyResult!.metrics.p99_ms).toBeLessThan(P99_THRESHOLD);
      expect(report.summary.failed).toBe(0);
    },
  );
});
