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
exports.PersistentTraceStore = void 0;
exports.sanitizeRunId = sanitizeRunId;
/**
 * TraceStore — Persistent storage for execution trace events.
 *
 * Appends each event as a JSON line to .commander_traces/{runId}.ndjson.
 * Sync writes for crash safety (same pattern as StateCheckpointer).
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
/**
 * Sanitize a runId for safe use as a file path component.
 * Strips path traversal sequences and limits length.
 */
function sanitizeRunId(runId) {
    return runId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}
class PersistentTraceStore {
    constructor(baseDir, tenantId) {
        this.buffers = new Map();
        this.bufferTimestamps = new Map();
        this.staleFlushTimer = null;
        this.tenantId = tenantId;
        const base = baseDir !== null && baseDir !== void 0 ? baseDir : path.join(process.cwd(), '.commander_traces');
        this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
        fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(this.baseDir, 0o700);
        }
        catch {
            /* best-effort */
        }
    }
    append(event) {
        var _a;
        const key = sanitizeRunId(event.runId);
        const buffer = this.buffers.get(key);
        if (buffer) {
            buffer.push(JSON.stringify(event));
        }
        else {
            this.buffers.set(key, [JSON.stringify(event)]);
            this.bufferTimestamps.set(key, Date.now());
        }
        if (buffer && buffer.length >= 10) {
            this.flush(key);
        }
        // Flush stale buffers periodically (not on every append to avoid O(n) scan)
        if (!this.staleFlushTimer) {
            this.staleFlushTimer = setTimeout(() => {
                this.staleFlushTimer = null;
                this.flushStaleBuffers();
            }, 60000);
            if ((_a = this.staleFlushTimer) === null || _a === void 0 ? void 0 : _a.unref)
                this.staleFlushTimer.unref();
        }
    }
    /**
     * Append a critical event with fsync — guarantees the bytes are on disk
     * before returning. Use sparingly: e.g. circuit-breaker transitions,
     * compensation exhaustion, intent-log writes. Higher latency than append().
     */
    appendCritical(event) {
        const key = sanitizeRunId(event.runId);
        const filePath = path.join(this.baseDir, `${key}.ndjson`);
        const line = JSON.stringify(event) + '\n';
        try {
            const fd = fs.openSync(filePath, 'a', 0o600);
            try {
                fs.fchmodSync(fd, 0o600);
            }
            catch {
                /* best-effort */
            }
            try {
                fs.writeSync(fd, line);
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('TraceStore', 'Failed to append critical trace', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId: key,
            });
        }
    }
    flushStaleBuffers() {
        const now = Date.now();
        for (const [key, timestamp] of this.bufferTimestamps) {
            if (now - timestamp > PersistentTraceStore.BUFFER_TTL_MS) {
                this.flush(key);
            }
        }
    }
    flush(runId) {
        const key = sanitizeRunId(runId);
        const buffer = this.buffers.get(key);
        if (!buffer || buffer.length === 0)
            return;
        const filePath = path.join(this.baseDir, `${key}.ndjson`);
        try {
            if (!fs.existsSync(filePath)) {
                const tmpPath = `${filePath}.tmp`;
                fs.writeFileSync(tmpPath, buffer.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
                fs.renameSync(tmpPath, filePath);
            }
            else {
                fs.appendFileSync(filePath, buffer.join('\n') + '\n', 'utf-8');
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('TraceStore', 'Failed to flush trace buffer', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId: key,
            });
        }
        this.buffers.delete(key);
        this.bufferTimestamps.delete(key);
    }
    flushAll() {
        for (const key of this.buffers.keys()) {
            this.flush(key);
        }
    }
    // GAP-04: Graceful shutdown — flush all buffers and clear maps
    shutdown() {
        this.flushAll();
        this.buffers.clear();
        this.bufferTimestamps.clear();
    }
    readTrace(runId) {
        const key = sanitizeRunId(runId);
        const filePath = path.join(this.baseDir, `${key}.ndjson`);
        if (!fs.existsSync(filePath))
            return [];
        try {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw)
                return [];
            const events = [];
            for (const line of raw.split('\n')) {
                try {
                    events.push(JSON.parse(line));
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('TraceStore', 'Skipped corrupt trace line', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                        runId: key,
                    });
                }
            }
            return events;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('TraceStore', 'Failed to read trace file', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId: key,
            });
            return [];
        }
    }
}
exports.PersistentTraceStore = PersistentTraceStore;
PersistentTraceStore.BUFFER_TTL_MS = 5 * 60000; // 5 minutes
