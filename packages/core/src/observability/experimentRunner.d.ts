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
import type { TokenUsage } from '../runtime/types';
import { type DatasetCase, type DatasetStore } from './dataset';
import { type EvalScorer } from './evalScorer';
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
    judgeTokens?: {
        input: number;
        output: number;
        total: number;
    };
    judgeError?: string;
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
export declare class ExperimentRunner {
    private readonly datasets;
    private readonly scorer;
    /** Active runs (id → AbortSignal). Supports cooperative cancellation. */
    private readonly activeRuns;
    /** Completed runs (capped to prevent unbounded memory). */
    private readonly completedRuns;
    private readonly maxCompletedRuns;
    constructor(datasets: DatasetStore, scorer: EvalScorer, config?: {
        maxCompletedRuns?: number;
    });
    /**
     * Allocate a run id without starting the experiment. Used by the
     * HTTP layer so it can return a runId to the client immediately
     * (Braintrust parity) while the experiment runs in the background.
     */
    allocateRunId(): string;
    /**
     * Run an experiment with a caller-supplied runId. Returns the
     * completed run. Use `cancel(runId)` from another async context to
     * abort. This is the async-return-id entry point the HTTP route
     * uses; for tests + the programmatic API, `run()` is simpler.
     */
    runWithId(runId: string, datasetId: string, executeCase: CaseExecutor, config?: ExperimentRunConfig): Promise<ExperimentRun>;
    /** Parallel variant of `runWithId`. */
    runParallelWithId(runId: string, datasetId: string, executeCase: CaseExecutor, config?: ExperimentRunConfig): Promise<ExperimentRun>;
    /** List the runIds of in-flight experiments (for tests / shutdown). */
    listActiveRunIds(): string[];
    /**
     * Run an experiment sequentially. Returns the completed run.
     * Use `cancel(runId)` from another async context to abort.
     */
    run(datasetId: string, executeCase: CaseExecutor, config?: ExperimentRunConfig): Promise<ExperimentRun>;
    /** Run cases in parallel up to `concurrency`. */
    runParallel(datasetId: string, executeCase: CaseExecutor, config?: ExperimentRunConfig): Promise<ExperimentRun>;
    /** Cancel an in-flight run. */
    cancel(runId: string): boolean;
    /** Get a completed run. */
    getRun(runId: string): ExperimentRun | undefined;
    /** List recent completed runs (newest first). */
    listRuns(limit?: number): ExperimentRun[];
    private initRunWithId;
    private executeRun;
    private initRun;
    private runCases;
    private runOneCase;
    private finalizeRun;
    private rememberRun;
}
//# sourceMappingURL=experimentRunner.d.ts.map