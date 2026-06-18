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
exports.DeadLetterQueue = exports.failureModeTag = void 0;
/**
 * DeadLetterQueue — Persistent storage for failed executions and tool calls.
 *
 * Each failure is recorded as a JSON line in .commander_dlq/{category}.ndjson.
 * Uses append-only writes for performance. Supports per-category isolation (llm, tool, execution).
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const failureModeTag = (mode) => `mode:${mode}`;
exports.failureModeTag = failureModeTag;
class DeadLetterQueue {
    constructor(baseDir) {
        this.buffers = new Map();
        // Track line counts per file to avoid re-reading just for counting
        this.lineCounts = new Map();
        this.baseDir = baseDir !== null && baseDir !== void 0 ? baseDir : path.join(process.cwd(), '.commander_dlq');
        fs.mkdirSync(this.baseDir, { recursive: true });
    }
    record(entry) {
        var _a;
        const key = entry.category;
        const buffer = (_a = this.buffers.get(key)) !== null && _a !== void 0 ? _a : [];
        buffer.push(JSON.stringify(entry));
        this.buffers.set(key, buffer);
        if (buffer.length >= 10) {
            this.flush(key);
        }
    }
    /**
     * Convenience: enqueue from partial spec. Fills sensible defaults for
     * the DeadLetterEntry required fields. Used by observability hooks
     * (circuit breaker, compensation, sub-agent) that don't have a full
     * run context.
     */
    enqueue(spec) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const tags = [...((_a = spec.tags) !== null && _a !== void 0 ? _a : [])];
        if (spec.failureMode)
            tags.push((0, exports.failureModeTag)(spec.failureMode));
        if (spec.failureModeNumber !== undefined)
            tags.push(`mode:${spec.failureModeNumber}`);
        const entry = {
            id: `${spec.category}-${spec.operationName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            category: spec.category,
            runId: (_b = spec.runId) !== null && _b !== void 0 ? _b : 'unknown',
            agentId: (_c = spec.agentId) !== null && _c !== void 0 ? _c : 'unknown',
            missionId: spec.missionId,
            timestamp: new Date().toISOString(),
            errorClass: (_d = spec.errorClass) !== null && _d !== void 0 ? _d : 'permanent',
            errorMessage: spec.errorMessage,
            retryable: (_e = spec.retryable) !== null && _e !== void 0 ? _e : false,
            attemptNumber: (_f = spec.attemptNumber) !== null && _f !== void 0 ? _f : 1,
            operationName: spec.operationName,
            inputSnapshot: spec.payload ? JSON.stringify(spec.payload) : undefined,
            compensated: (_g = spec.compensated) !== null && _g !== void 0 ? _g : false,
            recovered: (_h = spec.recovered) !== null && _h !== void 0 ? _h : false,
            tags,
        };
        this.record(entry);
    }
    flush(category) {
        var _a, _b;
        const cats = category ? [category] : Array.from(this.buffers.keys());
        for (const cat of cats) {
            // Atomic swap: take the buffer out first so concurrent record() calls
            // go into a fresh buffer instead of getting lost when we clear below.
            const buffer = this.buffers.get(cat);
            if (!buffer || buffer.length === 0)
                continue;
            this.buffers.set(cat, []);
            const filePath = path.join(this.baseDir, `${cat}.ndjson`);
            try {
                // Append-only: just append new entries to the file (no read-modify-write)
                const content = buffer.join('\n') + '\n';
                fs.appendFileSync(filePath, content, 'utf-8');
                // Update tracked line count
                const prevCount = (_a = this.lineCounts.get(cat)) !== null && _a !== void 0 ? _a : 0;
                this.lineCounts.set(cat, prevCount + buffer.length);
                // If over cap, rewrite file with only the last MAX_ENTRIES_PER_FILE lines
                if (((_b = this.lineCounts.get(cat)) !== null && _b !== void 0 ? _b : 0) > DeadLetterQueue.MAX_ENTRIES_PER_FILE) {
                    const raw = fs.readFileSync(filePath, 'utf-8').trim();
                    const lines = raw ? raw.split('\n') : [];
                    const trimmed = lines.slice(-DeadLetterQueue.MAX_ENTRIES_PER_FILE);
                    const tmpPath = path.join(this.baseDir, `${cat}.tmp`);
                    fs.writeFileSync(tmpPath, trimmed.join('\n') + '\n', 'utf-8');
                    fs.renameSync(tmpPath, filePath);
                    this.lineCounts.set(cat, trimmed.length);
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('DeadLetterQueue', 'Failed to flush dead-letter entries', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    category: cat,
                });
            }
        }
    }
    readEntries(category, limit = 50) {
        const filePath = path.join(this.baseDir, `${category}.ndjson`);
        if (!fs.existsSync(filePath))
            return [];
        try {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw)
                return [];
            const entries = [];
            // Read lines from end (most recent first) without reversing the whole array
            const lines = raw.split('\n');
            for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
                try {
                    entries.push(JSON.parse(lines[i]));
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().debug('DeadLetterQueue', 'Skipping corrupt entry', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                        category,
                        line: i,
                    });
                }
            }
            return entries;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('DeadLetterQueue', 'Failed to read dead-letter entries', {
                error: e === null || e === void 0 ? void 0 : e.message,
                category,
            });
            return [];
        }
    }
    /**
     * Get retryable entries: transient failures that haven't been recovered.
     * Useful for automated retry scheduling.
     */
    getRetryableEntries(category, limit = 10) {
        return this.readEntries(category, 100)
            .filter((e) => e.retryable && !e.recovered && !e.compensated)
            .slice(0, limit);
    }
    getStats() {
        const results = [];
        try {
            const files = fs.readdirSync(this.baseDir);
            for (const f of files) {
                if (f.endsWith('.ndjson')) {
                    const cat = f.replace('.ndjson', '');
                    // Use tracked count if available, otherwise count by reading
                    let count = this.lineCounts.get(cat);
                    if (count === undefined) {
                        const raw = fs.readFileSync(path.join(this.baseDir, f), 'utf-8').trim();
                        count = raw ? raw.split('\n').length : 0;
                        this.lineCounts.set(cat, count);
                    }
                    results.push({ category: cat, count });
                }
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('DeadLetterQueue', 'Failed to collect dead-letter stats', {
                error: e === null || e === void 0 ? void 0 : e.message,
            });
        }
        return results;
    }
}
exports.DeadLetterQueue = DeadLetterQueue;
DeadLetterQueue.MAX_ENTRIES_PER_FILE = 1000;
