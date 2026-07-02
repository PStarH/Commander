/**
 * P-obs-3: ExperimentRunner (Braintrust-style dataset → experiment).
 *
 * Loads a Dataset, executes each case through a caller-supplied
 * `executeCase` function (typically wrapping AgentRuntime.execute),
 * scores each result via the EvalScorer, and builds an ExperimentRun
 * with per-case results + an aggregated summary.
 *
 * Braintrust parity:
 *  - experiment = a single run of a dataset
 *  - per-case result has score, output, toolCallsMade, tokens, cost, duration
 *  - summary has totalCases, passed, failed, avgScore, p50/p95 duration
 *  - "passed" = score >= passThreshold
 *
 * Async + cancellation:
 *  - `run(datasetId, executeCase)` returns a promise to the run
 *  - `runSync` blocks on each case sequentially (deterministic)
 *  - `runParallel` runs up to `concurrency` cases at once
 *  - `cancel(runId)` aborts an in-flight run (cooperative)
 */

import type { TokenUsage } from '../../../runtime/types';
import { type Dataset, type DatasetCase, type DatasetStore } from './dataset';
import { type EvalScorer, type EvalTarget } from './evalScorer';

export interface ExperimentRunConfig {
  /** Minimum score to count a case as 'passed'. Default 0.5. */
  passThreshold?: number;
  /** Concurrency for `runParallel`. Default 1 (sequential). */
  concurrency?: number;
  /** Default model to use when a case doesn't specify one. */
  defaultModel?: string;
  /** Wall-clock budget for the entire experiment in ms. */
  budgetMs?: number;
  /** Stop on first failure? Default false. */
  stopOnFailure?: boolean;
}

export interface ExperimentCaseResult {
  caseId: string;
  status: 'passed' | 'failed' | 'errored';
  score: number;
  output: string;
  toolCallsMade: string[];
  tokenUsage: TokenUsage;
  costUsd: number;
  durationMs: number;
  error?: string;
  judgeReasoning?: string;
  judgeTokens?: { input: number; output: number; total: number };
  judgeError?: string;
  /**
   * Whether the judge actually ran on this case. Mirror of
   * EvalScore.graded — `false` means the judge was intentionally
   * skipped (regression-safety guard fired, typically because the
   * dataset case had missing/empty `expected`). Aggregations in
   * `finalizeRun()` filter on `r.graded === true` before computing
   * `passed`, `failed`, `passRate`, and `avgScore` so ungraded cases
   * don't bleed into the headline numbers. Always set; never undefined.
   */
  graded: boolean;
}

export interface ExperimentRun {
  id: string;
  datasetId: string;
  datasetName: string;
  rubricId: string;
  startedAt: string;
  completedAt?: string;
  results: ExperimentCaseResult[];
  summary: ExperimentSummary;
  config: ExperimentRunConfig;
}

export interface ExperimentSummary {
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  /**
   * Number of cases where `graded === false` — judge was intentionally
   * skipped due to missing/empty `expected`. These cases are ALSO
   * present in `errored` (status was set to 'errored' because
   * `judgeResult.error` was populated), but they are EXCLUDED from
   * `passed`, `failed`, `passRate`, and `avgScore` so a dataset with
   * blank labels cannot inflate or deflate the headline number.
   * Future dataset audits MUST report this counter alongside passRate.
   */
  ungraded: number;
  passRate: number;
  avgScore: number;
  avgDurationMs: number;
  p95DurationMs: number;
  avgCostUsd: number;
  totalCostUsd: number;
  totalTokens: number;
  totalJudgeTokens: number;
  wallClockMs: number;
}

/** Result of executing a single case. Returned by the caller's `executeCase` function. */
export interface CaseExecutionResult {
  output: string;
  toolCallsMade: string[];
  tokenUsage: TokenUsage;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export type CaseExecutor = (datasetCase: DatasetCase) => Promise<CaseExecutionResult>;

export class ExperimentRunner {
  private readonly datasets: DatasetStore;
  private readonly scorer: EvalScorer;
  /** Active runs (id → AbortSignal). Supports cooperative cancellation. */
  private readonly activeRuns: Map<string, AbortController> = new Map();
  /** Completed runs (capped to prevent unbounded memory). */
  private readonly completedRuns: Map<string, ExperimentRun> = new Map();
  private readonly maxCompletedRuns: number;

  constructor(
    datasets: DatasetStore,
    scorer: EvalScorer,
    config: { maxCompletedRuns?: number } = {},
  ) {
    this.datasets = datasets;
    this.scorer = scorer;
    this.maxCompletedRuns = config.maxCompletedRuns ?? 100;
  }

  // ────────── run lifecycle ──────────

  /**
   * Allocate a run id without starting the experiment. Used by the
   * HTTP layer so it can return a runId to the client immediately
   * (Braintrust parity) while the experiment runs in the background.
   */
  allocateRunId(): string {
    return generateId('exp');
  }

  /**
   * Run an experiment with a caller-supplied runId. Returns the
   * completed run. Use `cancel(runId)` from another async context to
   * abort. This is the async-return-id entry point the HTTP route
   * uses; for tests + the programmatic API, `run()` is simpler.
   */
  async runWithId(
    runId: string,
    datasetId: string,
    executeCase: CaseExecutor,
    config: ExperimentRunConfig = {},
  ): Promise<ExperimentRun> {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) throw new Error(`dataset_not_found: ${datasetId}`);
    const run = this.initRunWithId(runId, dataset, config);
    return this.executeRun(run, dataset, executeCase, config, false);
  }

  /** Parallel variant of `runWithId`. */
  async runParallelWithId(
    runId: string,
    datasetId: string,
    executeCase: CaseExecutor,
    config: ExperimentRunConfig = {},
  ): Promise<ExperimentRun> {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) throw new Error(`dataset_not_found: ${datasetId}`);
    const run = this.initRunWithId(runId, dataset, config);
    return this.executeRun(run, dataset, executeCase, config, true);
  }

  /** List the runIds of in-flight experiments (for tests / shutdown). */
  listActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys());
  }

  /**
   * Run an experiment sequentially. Returns the completed run.
   * Use `cancel(runId)` from another async context to abort.
   */
  async run(
    datasetId: string,
    executeCase: CaseExecutor,
    config: ExperimentRunConfig = {},
  ): Promise<ExperimentRun> {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) throw new Error(`dataset_not_found: ${datasetId}`);

    const run = this.initRun(dataset, config);
    return this.executeRun(run, dataset, executeCase, config, false);
  }

  /** Run cases in parallel up to `concurrency`. */
  async runParallel(
    datasetId: string,
    executeCase: CaseExecutor,
    config: ExperimentRunConfig = {},
  ): Promise<ExperimentRun> {
    const dataset = this.datasets.get(datasetId);
    if (!dataset) throw new Error(`dataset_not_found: ${datasetId}`);

    const run = this.initRun(dataset, config);
    return this.executeRun(run, dataset, executeCase, config, true);
  }

  /** Cancel an in-flight run. */
  cancel(runId: string): boolean {
    const ctrl = this.activeRuns.get(runId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** Get a completed run. */
  getRun(runId: string): ExperimentRun | undefined {
    return this.completedRuns.get(runId);
  }

  /** List recent completed runs (newest first). */
  listRuns(limit = 50): ExperimentRun[] {
    return Array.from(this.completedRuns.values())
      .sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1))
      .slice(0, limit);
  }

  // ────────── private ──────────

  private initRunWithId(
    runId: string,
    dataset: Dataset,
    config: ExperimentRunConfig,
  ): ExperimentRun {
    return {
      id: runId,
      datasetId: dataset.id,
      datasetName: dataset.name,
      rubricId: dataset.rubricId,
      startedAt: new Date().toISOString(),
      results: [],
      summary: emptySummary(),
      config,
    };
  }

  private async executeRun(
    run: ExperimentRun,
    dataset: Dataset,
    executeCase: CaseExecutor,
    config: ExperimentRunConfig,
    parallel: boolean,
  ): Promise<ExperimentRun> {
    const abort = new AbortController();
    this.activeRuns.set(run.id, abort);
    try {
      if (parallel) {
        const concurrency = Math.max(1, config.concurrency ?? 1);
        let cursor = 0;
        const workers: Array<Promise<void>> = [];
        for (let w = 0; w < concurrency; w++) {
          workers.push(
            (async () => {
              while (cursor < dataset.cases.length) {
                if (abort.signal.aborted) {
                  // Drain remaining cases as cancelled so the run
                  // summary reflects the cancellation (mirrors the
                  // sequential branch in `runCases`).
                  const idx = cursor++;
                  if (idx < dataset.cases.length) {
                    run.results.push(erroredResult(dataset.cases[idx]!.id, 'cancelled'));
                  }
                  continue;
                }
                const idx = cursor++;
                const datasetCase = dataset.cases[idx]!;
                await this.runOneCase(run, dataset, datasetCase, executeCase, abort.signal);
                const lastResult = run.results[run.results.length - 1];
                if (config.stopOnFailure && lastResult && lastResult.status !== 'passed') {
                  abort.abort();
                  return;
                }
              }
            })(),
          );
        }
        await Promise.all(workers);
      } else {
        await this.runCases(run, dataset, executeCase, abort.signal, config);
      }
    } finally {
      this.activeRuns.delete(run.id);
      this.finalizeRun(run);
      this.rememberRun(run);
    }
    return run;
  }

  private initRun(dataset: Dataset, config: ExperimentRunConfig): ExperimentRun {
    return {
      id: generateId('exp'),
      datasetId: dataset.id,
      datasetName: dataset.name,
      rubricId: dataset.rubricId,
      startedAt: new Date().toISOString(),
      results: [],
      summary: emptySummary(),
      config,
    };
  }

  private async runCases(
    run: ExperimentRun,
    dataset: Dataset,
    executeCase: CaseExecutor,
    signal: AbortSignal,
    config: ExperimentRunConfig,
  ): Promise<void> {
    const startedAt = Date.now();
    for (const datasetCase of dataset.cases) {
      if (signal.aborted) {
        // Mark every remaining case as cancelled so the run summary
        // reflects the cancellation rather than silently dropping them.
        run.results.push(erroredResult(datasetCase.id, 'cancelled'));
        continue;
      }
      if (config.budgetMs && Date.now() - startedAt > config.budgetMs) break;
      await this.runOneCase(run, dataset, datasetCase, executeCase, signal);
      const lastResult = run.results[run.results.length - 1];
      if (config.stopOnFailure && lastResult && lastResult.status !== 'passed') break;
    }
  }

  private async runOneCase(
    run: ExperimentRun,
    dataset: Dataset,
    datasetCase: DatasetCase,
    executeCase: CaseExecutor,
    signal: AbortSignal,
  ): Promise<void> {
    let execution: CaseExecutionResult;
    try {
      if (signal.aborted) {
        run.results.push(erroredResult(datasetCase.id, 'cancelled'));
        return;
      }
      execution = await executeCase(datasetCase);
    } catch (err) {
      run.results.push(
        erroredResult(datasetCase.id, err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    // Build the eval target from the execution + the case's expected.
    const target: EvalTarget = {
      input: datasetCase.input,
      output: execution.output,
      expected: datasetCase.expected,
      toolsCalled: execution.toolCallsMade,
      durationMs: execution.durationMs,
      costUsd: execution.costUsd,
      tokens: execution.tokenUsage.totalTokens,
      metadata: {
        runId: run.id,
        caseId: datasetCase.id,
        datasetId: dataset.id,
      },
    };
    const rubricId = datasetCase.rubricId ?? dataset.rubricId;
    const judgeResult = await this.scorer.score(target, rubricId);

    const passThreshold = run.config.passThreshold ?? 0.5;
    const status: ExperimentCaseResult['status'] = execution.error
      ? 'errored'
      : judgeResult.error
        ? 'errored'
        : judgeResult.score >= passThreshold
          ? 'passed'
          : 'failed';

    run.results.push({
      caseId: datasetCase.id,
      status,
      score: judgeResult.score,
      output: execution.output,
      toolCallsMade: execution.toolCallsMade,
      tokenUsage: execution.tokenUsage,
      costUsd: execution.costUsd,
      durationMs: execution.durationMs,
      error: execution.error,
      judgeReasoning: judgeResult.reasoning,
      judgeTokens: judgeResult.judgeTokens,
      judgeError: judgeResult.error,
      // Back-compat with legacy EvalScore (no graded field): undefined
      // implies a real judge call and thus graded=true.
      graded: judgeResult.graded !== false,
    });
  }

  private finalizeRun(run: ExperimentRun): void {
    run.completedAt = new Date().toISOString();
    const results = run.results;
    // Ungraded cases (judge skipped due to missing/empty expected)
    // MUST be excluded from pass/fail and avgScore so they don't drag
    // the headline downward. They are still counted in errored
    // (judgeError is set), and surface in the dedicated ungraded counter.
    const graded = results.filter((r) => r.graded);
    const ungraded = results.length - graded.length;
    const passed = graded.filter((r) => r.status === 'passed').length;
    const failed = graded.filter((r) => r.status === 'failed').length;
    const errored = results.filter((r) => r.status === 'errored').length;
    const scores = graded.map((r) => r.score);
    const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
    const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
    const totalTokens = results.reduce((s, r) => s + r.tokenUsage.totalTokens, 0);
    const totalJudgeTokens = results.reduce((s, r) => s + (r.judgeTokens?.total ?? 0), 0);
    const wallClock = Date.parse(run.completedAt) - Date.parse(run.startedAt);
    run.summary = {
      totalCases: results.length,
      passed,
      failed,
      errored,
      ungraded,
      passRate: graded.length > 0 ? passed / graded.length : 0,
      avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
      avgDurationMs:
        durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      p95DurationMs: p95(durations),
      avgCostUsd: results.length > 0 ? totalCost / results.length : 0,
      totalCostUsd: totalCost,
      totalTokens,
      totalJudgeTokens,
      wallClockMs: wallClock,
    };
  }

  private rememberRun(run: ExperimentRun): void {
    if (this.completedRuns.size >= this.maxCompletedRuns) {
      // Evict the oldest by startedAt.
      const sorted = Array.from(this.completedRuns.entries()).sort(([, a], [, b]) =>
        a.startedAt < b.startedAt ? 1 : -1,
      );
      const oldest = sorted[sorted.length - 1];
      if (oldest) this.completedRuns.delete(oldest[0]);
    }
    this.completedRuns.set(run.id, run);
  }
}

// ────────── helpers ──────────

function emptySummary(): ExperimentSummary {
  return {
    totalCases: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    ungraded: 0,
    passRate: 0,
    avgScore: 0,
    avgDurationMs: 0,
    p95DurationMs: 0,
    avgCostUsd: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalJudgeTokens: 0,
    wallClockMs: 0,
  };
}

function erroredResult(caseId: string, message: string): ExperimentCaseResult {
  return {
    caseId,
    status: 'errored',
    score: 0,
    output: '',
    toolCallsMade: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    costUsd: 0,
    durationMs: 0,
    error: message,
    // Execution failures never reach the judge, so they are NOT the
    // empty-expected ungraded case — the absence of a ground truth
    // is the judge's specific failure mode. Set graded=true here so
    // these cases don't get double-counted in the ungraded counter
    // (which is intended to surface judge-side regressions).
    graded: true,
  };
}

function p95(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx]!;
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
