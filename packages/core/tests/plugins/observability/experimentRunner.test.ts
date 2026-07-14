/**
 * Tests for the P-obs-3 ExperimentRunner.
 *
 * Coverage:
 *  - run() executes every case in the dataset, scores via EvalScorer, builds a summary
 *  - pass/fail threshold honored: score >= passThreshold → 'passed'
 *  - execution errors → 'errored' status (no throw to caller)
 *  - judge errors → 'errored' status with judgeError populated
 *  - runParallel() with concurrency > 1 processes every case
 *  - cancel() flips the abort signal; subsequent cases are 'errored' with 'cancelled'
 *  - getRun() / listRuns() return completed runs
 *  - summary stats: totalCases, passRate, avgScore, p95Duration, totals
 *  - maxCompletedRuns eviction
 *  - dataset_not_found error for unknown dataset
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatasetStore } from '../../../src/observability/dataset';
import {
  EvalScorer,
  type JudgeProvider,
  type LLMRequest,
  type LLMResponse,
} from '../../../src/plugins/builtin/observability/evalScorer';
import {
  ExperimentRunner,
  type CaseExecutionResult,
  type CaseExecutor,
  type DatasetCase,
} from '../../../src/plugins/builtin/observability/experimentRunner';

function mockJudge(score: number, reasoning = 'ok'): JudgeProvider {
  return {
    name: 'mock',
    async call(): Promise<LLMResponse> {
      return {
        content: JSON.stringify({ score, reasoning }),
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        finishReason: 'stop',
      };
    },
  };
}

function stubExecutor(output: string, durationMs = 10, tools: string[] = []): CaseExecutor {
  return async (): Promise<CaseExecutionResult> => ({
    output,
    toolCallsMade: tools,
    tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    costUsd: 0.001,
    durationMs,
  });
}

function makeDataset(n: number, name = 'demo'): { store: DatasetStore; id: string } {
  const store = new DatasetStore();
  const cases: DatasetCase[] = Array.from({ length: n }, (_, i) => ({
    id: `c-${i}`,
    input: { goal: `task ${i}` },
    expected: { outputContains: ['ok'] },
  }));
  const ds = store.create({ name, rubricId: 'default-quality', cases });
  return { store, id: ds.id };
}

describe('ExperimentRunner — sequential', () => {
  it('runs every case and builds a summary', async () => {
    const { store, id } = makeDataset(3);
    const scorer = new EvalScorer(mockJudge(0.9));
    const runner = new ExperimentRunner(store, scorer);
    const run = await runner.run(id, stubExecutor('ok'));
    expect(run.results).toHaveLength(3);
    expect(run.summary.totalCases).toBe(3);
    expect(run.summary.passed).toBe(3);
    expect(run.summary.failed).toBe(0);
    expect(run.summary.errored).toBe(0);
    expect(run.summary.passRate).toBe(1);
    expect(run.summary.avgScore).toBeCloseTo(0.9);
    expect(run.summary.totalTokens).toBe(90);
    expect(run.completedAt).toBeTruthy();
  });

  it('classifies scores below passThreshold as failed', async () => {
    const { store, id } = makeDataset(4);
    const scorer = new EvalScorer(mockJudge(0.3));
    const runner = new ExperimentRunner(store, scorer, { maxCompletedRuns: 100 });
    const run = await runner.run(id, stubExecutor('ok'), { passThreshold: 0.5 });
    expect(run.summary.passed).toBe(0);
    expect(run.summary.failed).toBe(4);
  });

  it('execution errors are surfaced as errored results, not thrown', async () => {
    const { store, id } = makeDataset(2);
    const scorer = new EvalScorer(mockJudge(0.9));
    const runner = new ExperimentRunner(store, scorer);
    const executor: CaseExecutor = async (): Promise<CaseExecutionResult> => ({
      output: '',
      toolCallsMade: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costUsd: 0,
      durationMs: 0,
      error: 'boom',
    });
    const run = await runner.run(id, executor);
    expect(run.summary.errored).toBe(2);
    expect(run.results.every((r) => r.status === 'errored')).toBe(true);
  });

  it('judge errors are surfaced as errored with judgeError populated', async () => {
    const { store, id } = makeDataset(1);
    const broken: JudgeProvider = {
      name: 'broken',
      async call(): Promise<LLMResponse> {
        throw new Error('judge down');
      },
    };
    const scorer = new EvalScorer(broken);
    const runner = new ExperimentRunner(store, scorer);
    const run = await runner.run(id, stubExecutor('ok'));
    expect(run.summary.errored).toBe(1);
    expect(run.results[0]!.judgeError).toContain('judge down');
  });

  it('throws dataset_not_found for unknown id', async () => {
    const store = new DatasetStore();
    const scorer = new EvalScorer(mockJudge(0.9));
    const runner = new ExperimentRunner(store, scorer);
    await expect(runner.run('ds-missing', stubExecutor('ok'))).rejects.toThrow(/dataset_not_found/);
  });

  it('cancel() flips the signal; subsequent cases return errored+cancelled', async () => {
    const { store, id } = makeDataset(10);
    const scorer = new EvalScorer(mockJudge(0.9));
    const runner = new ExperimentRunner(store, scorer);
    // Deterministic cancel: pre-allocate the runId, then cancel it
    // mid-flight using listActiveRunIds() (added for this purpose).
    const runId = runner.allocateRunId();
    const executor: CaseExecutor = async (): Promise<CaseExecutionResult> => {
      // After the first case starts, cancel the run via the active id.
      const active = runner.listActiveRunIds();
      if (active.length > 0) {
        runner.cancel(active[0]!);
      }
      await new Promise((r) => setTimeout(r, 10));
      return {
        output: 'ok',
        toolCallsMade: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        costUsd: 0,
        durationMs: 10,
      };
    };
    const run = await runner.runWithId(runId, id, executor);
    // The first case completes, the remaining 9 are marked 'cancelled'
    // (errored with error='cancelled') so the run summary reflects the
    // cancellation rather than silently dropping them.
    expect(run.results.length).toBe(10);
    const cancelled = run.results.filter((r) => r.error === 'cancelled');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(run.summary.errored).toBe(cancelled.length);
  });

  it('stopOnFailure aborts the run on first non-passed case', async () => {
    const { store, id } = makeDataset(5);
    const scorer = new EvalScorer(mockJudge(0.2));
    const runner = new ExperimentRunner(store, scorer);
    const run = await runner.run(id, stubExecutor('ok'), {
      passThreshold: 0.5,
      stopOnFailure: true,
    });
    expect(run.results.length).toBe(1);
    expect(run.results[0]!.status).toBe('failed');
  });
});

describe('ExperimentRunner — parallel', () => {
  it('processes every case when concurrency > 1', async () => {
    const { store, id } = makeDataset(8);
    const scorer = new EvalScorer(mockJudge(0.8));
    const runner = new ExperimentRunner(store, scorer);
    const run = await runner.runParallel(id, stubExecutor('ok'), { concurrency: 4 });
    expect(run.results).toHaveLength(8);
    expect(run.summary.passed).toBe(8);
  });

  it('rejects concurrency < 1 by clamping to 1', async () => {
    const { store, id } = makeDataset(2);
    const scorer = new EvalScorer(mockJudge(0.8));
    const runner = new ExperimentRunner(store, scorer);
    const run = await runner.runParallel(id, stubExecutor('ok'), { concurrency: 0 });
    expect(run.results).toHaveLength(2);
  });
});

describe('ExperimentRunner — run registry', () => {
  it('getRun / listRuns return completed runs', async () => {
    const { store, id } = makeDataset(1);
    const scorer = new EvalScorer(mockJudge(0.9));
    const runner = new ExperimentRunner(store, scorer);
    const run = await runner.run(id, stubExecutor('ok'));
    expect(runner.getRun(run.id)).toBeDefined();
    expect(runner.listRuns().map((r) => r.id)).toContain(run.id);
  });

  it('maxCompletedRuns evicts the oldest entry', async () => {
    const { store, id } = makeDataset(1);
    const scorer = new EvalScorer(mockJudge(0.9));
    const runner = new ExperimentRunner(store, scorer, { maxCompletedRuns: 2 });
    const a = await runner.run(id, stubExecutor('ok'));
    const b = await runner.run(id, stubExecutor('ok'));
    const c = await runner.run(id, stubExecutor('ok'));
    expect(runner.getRun(a.id)).toBeUndefined(); // evicted
    expect(runner.getRun(b.id)).toBeDefined();
    expect(runner.getRun(c.id)).toBeDefined();
  });
});
