"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExperimentRunner = void 0;
class ExperimentRunner {
    constructor(datasets, scorer, config = {}) {
        var _a;
        /** Active runs (id → AbortSignal). Supports cooperative cancellation. */
        this.activeRuns = new Map();
        /** Completed runs (capped to prevent unbounded memory). */
        this.completedRuns = new Map();
        this.datasets = datasets;
        this.scorer = scorer;
        this.maxCompletedRuns = (_a = config.maxCompletedRuns) !== null && _a !== void 0 ? _a : 100;
    }
    // ────────── run lifecycle ──────────
    /**
     * Allocate a run id without starting the experiment. Used by the
     * HTTP layer so it can return a runId to the client immediately
     * (Braintrust parity) while the experiment runs in the background.
     */
    allocateRunId() {
        return generateId('exp');
    }
    /**
     * Run an experiment with a caller-supplied runId. Returns the
     * completed run. Use `cancel(runId)` from another async context to
     * abort. This is the async-return-id entry point the HTTP route
     * uses; for tests + the programmatic API, `run()` is simpler.
     */
    async runWithId(runId, datasetId, executeCase, config = {}) {
        const dataset = this.datasets.get(datasetId);
        if (!dataset)
            throw new Error(`dataset_not_found: ${datasetId}`);
        const run = this.initRunWithId(runId, dataset, config);
        return this.executeRun(run, dataset, executeCase, config, false);
    }
    /** Parallel variant of `runWithId`. */
    async runParallelWithId(runId, datasetId, executeCase, config = {}) {
        const dataset = this.datasets.get(datasetId);
        if (!dataset)
            throw new Error(`dataset_not_found: ${datasetId}`);
        const run = this.initRunWithId(runId, dataset, config);
        return this.executeRun(run, dataset, executeCase, config, true);
    }
    /** List the runIds of in-flight experiments (for tests / shutdown). */
    listActiveRunIds() {
        return Array.from(this.activeRuns.keys());
    }
    /**
     * Run an experiment sequentially. Returns the completed run.
     * Use `cancel(runId)` from another async context to abort.
     */
    async run(datasetId, executeCase, config = {}) {
        const dataset = this.datasets.get(datasetId);
        if (!dataset)
            throw new Error(`dataset_not_found: ${datasetId}`);
        const run = this.initRun(dataset, config);
        return this.executeRun(run, dataset, executeCase, config, false);
    }
    /** Run cases in parallel up to `concurrency`. */
    async runParallel(datasetId, executeCase, config = {}) {
        const dataset = this.datasets.get(datasetId);
        if (!dataset)
            throw new Error(`dataset_not_found: ${datasetId}`);
        const run = this.initRun(dataset, config);
        return this.executeRun(run, dataset, executeCase, config, true);
    }
    /** Cancel an in-flight run. */
    cancel(runId) {
        const ctrl = this.activeRuns.get(runId);
        if (!ctrl)
            return false;
        ctrl.abort();
        return true;
    }
    /** Get a completed run. */
    getRun(runId) {
        return this.completedRuns.get(runId);
    }
    /** List recent completed runs (newest first). */
    listRuns(limit = 50) {
        return Array.from(this.completedRuns.values())
            .sort((a, b) => (b.startedAt < a.startedAt ? -1 : 1))
            .slice(0, limit);
    }
    // ────────── private ──────────
    initRunWithId(runId, dataset, config) {
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
    async executeRun(run, dataset, executeCase, config, parallel) {
        var _a;
        const abort = new AbortController();
        this.activeRuns.set(run.id, abort);
        try {
            if (parallel) {
                const concurrency = Math.max(1, (_a = config.concurrency) !== null && _a !== void 0 ? _a : 1);
                let cursor = 0;
                const workers = [];
                for (let w = 0; w < concurrency; w++) {
                    workers.push((async () => {
                        while (cursor < dataset.cases.length) {
                            if (abort.signal.aborted) {
                                // Drain remaining cases as cancelled so the run
                                // summary reflects the cancellation (mirrors the
                                // sequential branch in `runCases`).
                                const idx = cursor++;
                                if (idx < dataset.cases.length) {
                                    run.results.push(erroredResult(dataset.cases[idx].id, 'cancelled'));
                                }
                                continue;
                            }
                            const idx = cursor++;
                            const datasetCase = dataset.cases[idx];
                            await this.runOneCase(run, dataset, datasetCase, executeCase, abort.signal);
                            const lastResult = run.results[run.results.length - 1];
                            if (config.stopOnFailure && lastResult && lastResult.status !== 'passed') {
                                abort.abort();
                                return;
                            }
                        }
                    })());
                }
                await Promise.all(workers);
            }
            else {
                await this.runCases(run, dataset, executeCase, abort.signal, config);
            }
        }
        finally {
            this.activeRuns.delete(run.id);
            this.finalizeRun(run);
            this.rememberRun(run);
        }
        return run;
    }
    initRun(dataset, config) {
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
    async runCases(run, dataset, executeCase, signal, config) {
        const startedAt = Date.now();
        for (const datasetCase of dataset.cases) {
            if (signal.aborted) {
                // Mark every remaining case as cancelled so the run summary
                // reflects the cancellation rather than silently dropping them.
                run.results.push(erroredResult(datasetCase.id, 'cancelled'));
                continue;
            }
            if (config.budgetMs && Date.now() - startedAt > config.budgetMs)
                break;
            await this.runOneCase(run, dataset, datasetCase, executeCase, signal);
            const lastResult = run.results[run.results.length - 1];
            if (config.stopOnFailure && lastResult && lastResult.status !== 'passed')
                break;
        }
    }
    async runOneCase(run, dataset, datasetCase, executeCase, signal) {
        var _a, _b;
        let execution;
        try {
            if (signal.aborted) {
                run.results.push(erroredResult(datasetCase.id, 'cancelled'));
                return;
            }
            execution = await executeCase(datasetCase);
        }
        catch (err) {
            run.results.push(erroredResult(datasetCase.id, err instanceof Error ? err.message : String(err)));
            return;
        }
        // Build the eval target from the execution + the case's expected.
        const target = {
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
        const rubricId = (_a = datasetCase.rubricId) !== null && _a !== void 0 ? _a : dataset.rubricId;
        const judgeResult = await this.scorer.score(target, rubricId);
        const passThreshold = (_b = run.config.passThreshold) !== null && _b !== void 0 ? _b : 0.5;
        const status = execution.error
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
        });
    }
    finalizeRun(run) {
        run.completedAt = new Date().toISOString();
        const results = run.results;
        const passed = results.filter((r) => r.status === 'passed').length;
        const failed = results.filter((r) => r.status === 'failed').length;
        const errored = results.filter((r) => r.status === 'errored').length;
        const scores = results.map((r) => r.score);
        const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
        const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
        const totalTokens = results.reduce((s, r) => s + r.tokenUsage.totalTokens, 0);
        const totalJudgeTokens = results.reduce((s, r) => { var _a, _b; return s + ((_b = (_a = r.judgeTokens) === null || _a === void 0 ? void 0 : _a.total) !== null && _b !== void 0 ? _b : 0); }, 0);
        const wallClock = Date.parse(run.completedAt) - Date.parse(run.startedAt);
        run.summary = {
            totalCases: results.length,
            passed,
            failed,
            errored,
            passRate: results.length > 0 ? passed / results.length : 0,
            avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0,
            avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
            p95DurationMs: p95(durations),
            avgCostUsd: results.length > 0 ? totalCost / results.length : 0,
            totalCostUsd: totalCost,
            totalTokens,
            totalJudgeTokens,
            wallClockMs: wallClock,
        };
    }
    rememberRun(run) {
        if (this.completedRuns.size >= this.maxCompletedRuns) {
            // Evict the oldest by startedAt.
            const sorted = Array.from(this.completedRuns.entries()).sort(([, a], [, b]) => a.startedAt < b.startedAt ? 1 : -1);
            const oldest = sorted[sorted.length - 1];
            if (oldest)
                this.completedRuns.delete(oldest[0]);
        }
        this.completedRuns.set(run.id, run);
    }
}
exports.ExperimentRunner = ExperimentRunner;
// ────────── helpers ──────────
function emptySummary() {
    return {
        totalCases: 0,
        passed: 0,
        failed: 0,
        errored: 0,
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
function erroredResult(caseId, message) {
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
    };
}
function p95(sorted) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return sorted[idx];
}
function generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
