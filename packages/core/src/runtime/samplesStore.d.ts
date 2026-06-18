import type { LLMRequest, LLMResponse, ApiCallRecord } from './types';
/**
 * Write-optimized audit trail for LLM API calls, verification results,
 * and evaluation samples. Every request/response pair is persisted as
 * a JSON Line — append-only, async-safe, easily greppable.
 *
 * Storage layout:
 *   .commander_samples/
 *   ├── llm_calls.ndjson        # All LLM request/response records
 *   ├── verifications.ndjson    # Verification results
 *   └── runs/
 *       └── {runId}.json        # Per-run manifest
 */
export declare class SamplesStore {
    private baseDir;
    private tenantId?;
    private writeQueue;
    private flushing;
    private readonly MAX_FILE_BYTES;
    private readonly MAX_ROTATED_FILES;
    constructor(baseDir?: string, tenantId?: string);
    /** Record an LLM API call. Thread-safe via write queue. */
    recordLLMCall(request: LLMRequest, response: LLMResponse | null, params: {
        provider: string;
        durationMs: number;
        attemptNumber: number;
        error?: string;
        /** Evaluation task ID (e.g. "HumanEval/64") — triggers code extraction */
        taskId?: string;
        /** Pre-extracted solution code (skips auto-extraction) */
        extractedCode?: string;
        /** Run ID for sub-agent correlation */
        runId?: string;
        /** Agent ID */
        agentId?: string;
        /** Tenant ID for multi-tenant isolation */
        tenantId?: string;
        /** Parent runId when this is a sub-agent call */
        parentRunId?: string;
    }): Promise<string>;
    /** Record a verification result. */
    recordVerification(goal: string, output: string, result: {
        passed: boolean;
        confidence: number;
        signalCount: number;
        tokensUsed: number;
        stagesRun: number[];
        skipReason?: string;
    }): Promise<void>;
    /** Create a run manifest with full parameter provenance. */
    recordRunManifest(runId: string, manifest: Record<string, unknown>): Promise<void>;
    /** Drain all pending writes to disk. Call before shutdown. */
    flush(): Promise<void>;
    /** Get total record count for llm_calls (approximate). */
    getCallCount(): number;
    /** Get total record count for verifications (approximate). */
    getVerificationCount(): number;
    /**
     * Export recorded LLM calls as evalplus-compatible samples.jsonl.
     * Returns the file path of the written output.
     *
     * Output format per line:
     *   {"task_id": "HumanEval/64", "solution": "def ..."}
     *
     * Two modes:
     *  - Structured: records were stored with explicit taskId and extractedCode
     *  - Recovery: extracts taskId from contentPrefix, code from contentPrefix
     *             (works with any existing SamplesStore data)
     */
    exportEvalPlusSamples(outputPath?: string): string;
    /**
     * Read all stored ApiCallRecords from disk, handling partial/corrupt lines.
     */
    readAllRecords(): ApiCallRecord[];
    /** Get the base directory path. */
    getBaseDir(): string;
    private ensureDir;
    /** Enqueue a write task to serialise concurrent access. */
    private enqueueWrite;
    private drainQueue;
    /** Append a JSON line to a given file with rotation. */
    private appendLine;
    private rotateFile;
    /** Read all non-empty lines from a file in the samples directory. */
    private readAllLines;
}
//# sourceMappingURL=samplesStore.d.ts.map