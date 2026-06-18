"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SamplesStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const codeExtractor_1 = require("./codeExtractor");
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
class SamplesStore {
    constructor(baseDir, tenantId) {
        this.writeQueue = [];
        this.flushing = false;
        this.MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
        this.MAX_ROTATED_FILES = 3;
        this.tenantId = tenantId;
        const base = baseDir !== null && baseDir !== void 0 ? baseDir : path.join(process.cwd(), '.commander_samples');
        this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
        this.ensureDir();
    }
    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------
    /** Record an LLM API call. Thread-safe via write queue. */
    async recordLLMCall(request, response, params) {
        var _a, _b, _c, _d, _e, _f, _g;
        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const content = (_b = (_a = response === null || response === void 0 ? void 0 : response.content) !== null && _a !== void 0 ? _a : params.error) !== null && _b !== void 0 ? _b : '';
        const record = {
            callId,
            runId: params.runId,
            agentId: params.agentId,
            tenantId: params.tenantId,
            parentRunId: params.parentRunId,
            model: request.model,
            provider: params.provider,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            reasoningConfig: request.reasoningConfig,
            promptTokens: (_c = response === null || response === void 0 ? void 0 : response.usage.promptTokens) !== null && _c !== void 0 ? _c : 0,
            completionTokens: (_d = response === null || response === void 0 ? void 0 : response.usage.completionTokens) !== null && _d !== void 0 ? _d : 0,
            totalTokens: (_e = response === null || response === void 0 ? void 0 : response.usage.totalTokens) !== null && _e !== void 0 ? _e : 0,
            durationMs: params.durationMs,
            finishReason: (_f = response === null || response === void 0 ? void 0 : response.finishReason) !== null && _f !== void 0 ? _f : 'error',
            attemptNumber: params.attemptNumber,
            contentPrefix: content.slice(0, 500),
            fullMessages: request.messages,
            fullResponse: response,
            reasoningContent: response === null || response === void 0 ? void 0 : response.reasoningContent,
            extractedCode: (_g = params.extractedCode) !== null && _g !== void 0 ? _g : (params.taskId ? (0, codeExtractor_1.extractCode)(content) : undefined),
            error: params.error,
            taskId: params.taskId,
            timestamp: new Date().toISOString(),
        };
        this.enqueueWrite(() => this.appendLine('llm_calls.ndjson', record));
        return callId;
    }
    /** Record a verification result. */
    async recordVerification(goal, output, result) {
        const record = {
            timestamp: new Date().toISOString(),
            goalPrefix: goal.slice(0, 200),
            outputPrefix: output.slice(0, 200),
            passed: result.passed,
            confidence: result.confidence,
            signalCount: result.signalCount,
            tokensUsed: result.tokensUsed,
            stagesRun: result.stagesRun,
            skipReason: result.skipReason,
        };
        this.enqueueWrite(() => this.appendLine('verifications.ndjson', record));
    }
    /** Create a run manifest with full parameter provenance. */
    async recordRunManifest(runId, manifest) {
        const dir = path.join(this.baseDir, 'runs');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${runId}.json`);
        this.enqueueWrite(async () => {
            fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
        });
    }
    /** Drain all pending writes to disk. Call before shutdown. */
    async flush() {
        if (this.flushing)
            return;
        this.flushing = true;
        try {
            let idx = 0;
            while (idx < this.writeQueue.length) {
                const task = this.writeQueue[idx++];
                if (task)
                    await task();
            }
        }
        finally {
            this.writeQueue.length = 0;
            this.flushing = false;
        }
    }
    /** Get total record count for llm_calls (approximate). */
    getCallCount() {
        return this.readAllLines('llm_calls.ndjson').length;
    }
    /** Get total record count for verifications (approximate). */
    getVerificationCount() {
        return this.readAllLines('verifications.ndjson').length;
    }
    // ---------------------------------------------------------------------------
    // EvalPlus Export
    // ---------------------------------------------------------------------------
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
    exportEvalPlusSamples(outputPath) {
        var _a;
        const records = this.readAllRecords();
        const evalMap = new Map();
        for (const r of records) {
            let taskId = r.taskId;
            let code = r.extractedCode;
            // Recovery mode: try to infer taskId from content
            if (!taskId) {
                taskId = (_a = (0, codeExtractor_1.extractTaskId)(r.contentPrefix)) !== null && _a !== void 0 ? _a : undefined;
            }
            if (!taskId)
                continue;
            // Recovery mode: auto-extract code from stored content
            if (!code && !r.error) {
                const fullContent = r.contentPrefix + (r.contentPrefix.length >= 500 ? '...' : '');
                code = (0, codeExtractor_1.extractCode)(fullContent);
            }
            if (!code || !(0, codeExtractor_1.isValidSolution)(code))
                continue;
            // Prefer the latest successful attempt per task
            evalMap.set(taskId, code);
        }
        const evalEntries = [];
        for (const [taskId, solution] of evalMap) {
            evalEntries.push(JSON.stringify({ task_id: taskId, solution }));
        }
        const outPath = outputPath !== null && outputPath !== void 0 ? outputPath : path.join(this.baseDir, 'evalplus_samples.jsonl');
        fs.writeFileSync(outPath, evalEntries.join('\n') + '\n', 'utf-8');
        return outPath;
    }
    /**
     * Read all stored ApiCallRecords from disk, handling partial/corrupt lines.
     */
    readAllRecords() {
        const lines = this.readAllLines('llm_calls.ndjson');
        const records = [];
        for (const line of lines) {
            try {
                records.push(JSON.parse(line));
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().debug('SamplesStore', 'Skipped corrupt line', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
        return records;
    }
    /** Get the base directory path. */
    getBaseDir() {
        return this.baseDir;
    }
    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------
    ensureDir() {
        fs.mkdirSync(path.join(this.baseDir, 'runs'), { recursive: true });
    }
    /** Enqueue a write task to serialise concurrent access. */
    enqueueWrite(task) {
        this.writeQueue.push(task);
        if (!this.flushing) {
            this.flushing = true;
            this.drainQueue();
        }
    }
    async drainQueue() {
        try {
            let idx = 0;
            while (idx < this.writeQueue.length) {
                const task = this.writeQueue[idx++];
                if (task)
                    await task();
            }
            this.writeQueue.length = 0;
        }
        finally {
            this.flushing = false;
            // If new items were enqueued while draining, start another drain
            if (this.writeQueue.length > 0) {
                this.flushing = true;
                this.drainQueue();
            }
        }
    }
    /** Append a JSON line to a given file with rotation. */
    async appendLine(fileName, data) {
        const filePath = path.join(this.baseDir, fileName);
        // GAP-21: Rotate file if it exceeds max size
        try {
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                if (stat.size >= this.MAX_FILE_BYTES) {
                    this.rotateFile(fileName);
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('SamplesStore', 'Failed to inspect sample file before append', {
                error: e === null || e === void 0 ? void 0 : e.message,
                fileName,
            });
        }
        const line = JSON.stringify(data) + '\n';
        fs.appendFileSync(filePath, line, 'utf-8');
    }
    // GAP-21: Rotate NDJSON files — shift .1, .2, .3, delete oldest
    rotateFile(fileName) {
        const dir = this.baseDir;
        const base = path.join(dir, fileName);
        // Delete oldest rotation
        const oldest = `${base}.${this.MAX_ROTATED_FILES}`;
        if (fs.existsSync(oldest)) {
            try {
                fs.unlinkSync(oldest);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('SamplesStore', 'Failed to delete oldest rotated sample file', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    oldest,
                });
            }
        }
        // Shift existing rotations: .2 → .3, .1 → .2
        for (let i = this.MAX_ROTATED_FILES - 1; i >= 1; i--) {
            const from = `${base}.${i}`;
            const to = `${base}.${i + 1}`;
            if (fs.existsSync(from)) {
                try {
                    fs.renameSync(from, to);
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('SamplesStore', 'Failed to rotate sample file', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                        from,
                        to,
                    });
                }
            }
        }
        // Current → .1
        if (fs.existsSync(base)) {
            try {
                fs.renameSync(base, `${base}.1`);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('SamplesStore', 'Failed to rotate current sample file', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    base,
                });
            }
        }
    }
    /** Read all non-empty lines from a file in the samples directory. */
    readAllLines(fileName) {
        const p = path.join(this.baseDir, fileName);
        if (!fs.existsSync(p))
            return [];
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (!content)
            return [];
        return content.split('\n').filter((l) => l.length > 0);
    }
}
exports.SamplesStore = SamplesStore;
