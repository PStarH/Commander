/**
 * Unit tests for MultiAgentBenchmark metric correctness.
 *
 * These tests exercise the new metric surface added per the coordination lead report:
 *  - latencyComparable gate (won't compare latency when one path failed)
 *  - judge-rubric validator with Math.min keyword-floor guard against LLM false-positives
 *  - requiredKeywords-only fallback (deterministic)
 *  - budget enforcement sets completedEarly + stopReason
 *
 * Pure-logic tests: orchestrator is mocked, so no API key is required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  MultiAgentBenchmark,
  type BenchmarkTask,
  type TaskResult,
  type ABComparison,
  type UltimateExecutionResult,
  type UltimateOrchestrator,
} from '../../src/benchmark/multiAgentBenchmark';

// ---------------------------------------------------------------------------
// Mock orchestrator + helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal UltimateExecutionResult with controllable fields so each
 * test can simulate a specific pass/fail/cost/latency combination.
 */
function makeResult(
  overrides: Partial<{
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
    totalTokens: number;
    totalCostUsd: number;
    totalDurationMs: number;
    qualityScore: number;
    subAgentsSpawned: number;
    topologyUsed: 'SINGLE' | 'SEQUENTIAL' | 'PARALLEL' | 'HIERARCHICAL' | 'HYBRID';
    synthesis: string;
    errors: Array<{ nodeId: string; agentId: string; message: string; recovered: boolean }>;
    subAgentDurations: number[]; // wall-clock per completed sub-agent
  }>,
): UltimateExecutionResult {
  const completedDurations = overrides.subAgentDurations ?? [100];
  return {
    id: 'mock-exec',
    status: overrides.status ?? 'SUCCESS',
    summary: overrides.synthesis ?? 'mock output',
    synthesis: overrides.synthesis ?? 'mock output',
    artifacts: [],
    executionTree: completedDurations.map((durationMs, i) => ({
      id: `node-${i}`,
      parentId: null,
      goal: 'mock subtask',
      role: 'EXECUTOR' as const,
      isAtomic: true,
      subtasks: [],
      dependencies: [],
      context: { systemPrompt: '', availableTools: [], estimatedTokens: 1000 },
      status: 'COMPLETED' as const,
      result: 'ok',
      durationMs,
    })),
    metrics: {
      totalTokens: overrides.totalTokens ?? 1000,
      totalCostUsd: overrides.totalCostUsd ?? 0.01,
      totalDurationMs: overrides.totalDurationMs ?? 200,
      llmCalls: 1,
      toolCalls: 0,
      subAgentsSpawned: overrides.subAgentsSpawned ?? 1,
      artifactsCreated: 0,
      qualityScore: overrides.qualityScore ?? 0.7,
      topologyUsed: overrides.topologyUsed ?? 'PARALLEL',
      effortLevelUsed: 'MODERATE' as const,
    },
    errors: overrides.errors ?? [],
    reasoning: [],
  };
}

/**
 * Build a mock orchestrator that returns the given results in order, alternating
 * SINGLE-then-AUTO per task (matching the runTask contract).
 */
function makeMockOrchestrator(results: UltimateExecutionResult[]): UltimateOrchestrator {
  let callIndex = 0;
  return {
    execute: async () => {
      const r = results[callIndex++];
      if (!r) throw new Error('Mock orchestrator exhausted');
      return r;
    },
  } as unknown as UltimateOrchestrator;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultiAgentBenchmark metrics', () => {
  describe('latencyComparable gate', () => {
    it('sets latencyComparable=false and still picks multi via quality when single fails', async () => {
      // Single THROWS (e.g., 402 from provider → orchestrator.execute rejects),
      // which fires the catch path in executeWithTopology → codeCorrectnessScore=0.
      // Multi returns SUCCESS → codeCorrectnessScore=1.0 (validateOutput default).
      // So codeCorrectnessDelta=1.0 > 0.1 → winner='multi' even with the
      // latency gate suppressed.
      const multiResult = makeResult({
        status: 'SUCCESS',
        totalDurationMs: 5000,
        qualityScore: 0.8,
        subAgentDurations: [4800],
      });
      let callIndex = 0;
      const orch: UltimateOrchestrator = {
        execute: async () => {
          callIndex++;
          if (callIndex === 1) throw new Error('402 Payment Required');
          return multiResult;
        },
      } as unknown as UltimateOrchestrator;
      const task: BenchmarkTask = {
        id: 't1',
        tier: 'simple',
        goal: 'x',
        expectedCapability: 'x',
        maxTokens: 1,
        tools: [],
      };

      const bench = new MultiAgentBenchmark({
        customTasks: [task],
        runtime: {} as any,
        orchestrator: orch,
      });

      const comparison = await (bench as any).runTask(task);

      expect(comparison.latencyComparable).toBe(false);
      expect(comparison.single.status).toBe('failed');
      expect(comparison.multi.status).toBe('success');
      // Multi wins on the codeCorrectnessDelta (1.0 - 0 = 1.0 > 0.1).
      // The latency gate is correctly suppressed (latencyComparable=false).
      expect(comparison.winner).toBe('multi');
    });

    it('sets latencyComparable=true when both paths succeed', async () => {
      const singleResult = makeResult({
        status: 'SUCCESS',
        totalDurationMs: 100,
        subAgentDurations: [80],
      });
      const multiResult = makeResult({
        status: 'SUCCESS',
        totalDurationMs: 150,
        subAgentDurations: [120],
        qualityScore: 0.7,
      });
      const orch = makeMockOrchestrator([singleResult, multiResult]);
      const task: BenchmarkTask = {
        id: 't2',
        tier: 'simple',
        goal: 'x',
        expectedCapability: 'x',
        maxTokens: 1,
        tools: [],
      };
      const bench = new MultiAgentBenchmark({
        customTasks: [task],
        runtime: {} as any,
        orchestrator: orch,
      });
      const comparison = await (bench as any).runTask(task);
      expect(comparison.latencyComparable).toBe(true);
    });
  });

  describe('keyword coverage (validateOutput fallback path)', () => {
    let bench: MultiAgentBenchmark;
    beforeEach(() => {
      bench = new MultiAgentBenchmark({});
    });

    it('returns 1.0 when no requiredKeywords are configured', () => {
      const score = (bench as any).keywordCoverage('any synthesis', undefined);
      expect(score).toBe(1.0);
    });

    it('returns 1.0 when all keywords are present', () => {
      const score = (bench as any).keywordCoverage('this output mentions install, run, and test', [
        'install',
        'run',
        'test',
      ]);
      expect(score).toBe(1.0);
    });

    it('returns fraction for partial keyword coverage', () => {
      const score = (bench as any).keywordCoverage('this output mentions install only', [
        'install',
        'run',
        'test',
      ]);
      expect(score).toBeCloseTo(1 / 3, 5);
    });

    it('returns 0 when no keywords are present', () => {
      const score = (bench as any).keywordCoverage('no required words here', ['install', 'pnpm']);
      expect(score).toBe(0);
    });

    it('is case-insensitive', () => {
      const score = (bench as any).keywordCoverage('INSTALL, Run, tEsT', [
        'install',
        'run',
        'test',
      ]);
      expect(score).toBe(1.0);
    });
  });

  describe('judge-rubric Math.min guard (no LLM false-positive override)', () => {
    it('uses Math.min so a generous judge cannot exceed the keyword floor', async () => {
      let judgeCalled = false;
      const bench = new MultiAgentBenchmark({
        judgeLLMCall: async () => {
          judgeCalled = true;
          return '0.9';
        },
      });

      const task: BenchmarkTask = {
        id: 'guard-test',
        tier: 'simple',
        goal: 'x',
        expectedCapability: 'x',
        maxTokens: 1,
        tools: [],
        judgeRubric: 'should mention required topics',
        requiredKeywords: ['install', 'run', 'test'],
      };

      // Synthesis contains 0/3 keywords. The judge will say 0.9. The result should
      // be Math.min(0, 0.9) = 0, NOT Math.max(0, 0.9) = 0.9.
      const score = await (bench as any).validateOutput(task, '/tmp', 'no relevant content at all');

      expect(judgeCalled).toBe(true);
      expect(score).toBe(0);
    });

    it('falls back to keyword score when judge is not configured', async () => {
      const bench = new MultiAgentBenchmark({}); // no judgeLLMCall
      const task: BenchmarkTask = {
        id: 'fallback-test',
        tier: 'simple',
        goal: 'x',
        expectedCapability: 'x',
        maxTokens: 1,
        tools: [],
        judgeRubric: 'some rubric',
        requiredKeywords: ['install'],
      };
      // Synthesis must NOT contain 'install' (case-insensitive) so the keyword
      // coverage is genuinely 0. The previous 'no install here' string accidentally
      // contained the substring 'install' and gave a false 1.0.
      const score = await (bench as any).validateOutput(task, '/tmp', 'nothing relevant here');
      expect(score).toBe(0);
    });

    it('returns null from judgeLLM when the call throws', async () => {
      const bench = new MultiAgentBenchmark({
        judgeLLMCall: async () => {
          throw new Error('judge down');
        },
      });
      const score = await (bench as any).judgeLLM('synthesis', 'rubric');
      expect(score).toBeNull();
    });

    it('returns null from judgeLLM when the response has no parseable number', async () => {
      const bench = new MultiAgentBenchmark({
        judgeLLMCall: async () => 'the output is reasonable but I decline to score',
      });
      const score = await (bench as any).judgeLLM('synthesis', 'rubric');
      expect(score).toBeNull();
    });
  });

  describe('budget enforcement', () => {
    it('stops the run early and sets completedEarly+stopReason when budget is reached', async () => {
      // Each task: single=$0.5 + multi=$0.5 = $1.00.
      // Budget $0.50 with parallel=1: pre-check (0 < 0.5) runs task #1, then
      // post-batch (1.0 >= 0.5) breaks before task #2. So totalTasks === 1.
      const singleResult = makeResult({ status: 'SUCCESS', totalCostUsd: 0.5, totalDurationMs: 5 });
      const multiResult = makeResult({
        status: 'SUCCESS',
        totalCostUsd: 0.5,
        totalDurationMs: 10,
        qualityScore: 0.7,
      });
      const orch = makeMockOrchestrator([
        singleResult,
        multiResult,
        singleResult,
        multiResult,
        singleResult,
        multiResult,
      ]);
      const tasks: BenchmarkTask[] = [
        { id: 'a', tier: 'simple', goal: 'a', expectedCapability: 'x', maxTokens: 1, tools: [] },
        { id: 'b', tier: 'simple', goal: 'b', expectedCapability: 'x', maxTokens: 1, tools: [] },
        { id: 'c', tier: 'simple', goal: 'c', expectedCapability: 'x', maxTokens: 1, tools: [] },
      ];

      const bench = new MultiAgentBenchmark({
        customTasks: tasks,
        budgetUsd: 0.5,
        parallel: 1,
        runtime: {} as any,
        orchestrator: orch,
      });

      const summary = await bench.run();

      // Should have stopped after task #1 (post-task cost=1.0 >= 0.5 budget).
      expect(summary.totalTasks).toBe(1);
      expect(summary.completedEarly).toBe(true);
      expect(summary.stopReason).toContain('Budget cap');
      expect(summary.stopReason).toContain('0.50');
    });

    it('does NOT set completedEarly when budget is undefined or never reached', async () => {
      const singleResult = makeResult({ status: 'SUCCESS', totalCostUsd: 0.01 });
      const multiResult = makeResult({ status: 'SUCCESS', totalCostUsd: 0.01, qualityScore: 0.7 });
      const orch = makeMockOrchestrator([singleResult, multiResult]);
      const task: BenchmarkTask = {
        id: 'z',
        tier: 'simple',
        goal: 'z',
        expectedCapability: 'x',
        maxTokens: 1,
        tools: [],
      };
      const bench = new MultiAgentBenchmark({
        customTasks: [task],
        runtime: {} as any,
        orchestrator: orch,
      });
      const summary = await bench.run();
      expect(summary.completedEarly).toBeUndefined();
      expect(summary.stopReason).toBeUndefined();
      expect(summary.totalTasks).toBe(1);
    });
  });

  describe('per-sub-agent metrics on multi path', () => {
    it('records sumSubAgentMs and maxSubAgentMs only for AUTO/multi', async () => {
      const singleResult = makeResult({ topologyUsed: 'SINGLE', subAgentDurations: [100] });
      const multiResult = makeResult({
        topologyUsed: 'PARALLEL',
        subAgentDurations: [300, 500, 200],
      });
      const orch = makeMockOrchestrator([singleResult, multiResult]);

      const bench = new MultiAgentBenchmark({
        tasks: 0, // skip the BENCHMARK_TASKS set entirely
        runtime: {} as any,
        orchestrator: orch,
      });

      // Use a public surface that doesn't depend on the BENCHMARK_TASKS array:
      // call executeWithTopology directly on a synthetic task.
      const fakeTask: BenchmarkTask = {
        id: 'pm',
        tier: 'simple',
        goal: 'g',
        expectedCapability: 'c',
        maxTokens: 1,
        tools: [],
        requiredKeywords: ['x'],
      };
      const single = await (bench as any).executeWithTopology(fakeTask, 'SINGLE');
      const multi = await (bench as any).executeWithTopology(fakeTask, 'AUTO');

      expect(single.sumSubAgentMs).toBeUndefined();
      expect(single.maxSubAgentMs).toBeUndefined();
      // Multi: 3 sub-agents with durations 300, 500, 200 -> sum=1000, max=500.
      expect(multi.sumSubAgentMs).toBe(1000);
      expect(multi.maxSubAgentMs).toBe(500);
    });
  });
});
