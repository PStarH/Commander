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
exports.IntentLog = void 0;
exports.getIntentLog = getIntentLog;
exports.resetIntentLog = resetIntentLog;
/**
 * IntentLog — Persistent record of agent decision rationale.
 *
 * The IntentLog captures the "why" behind each run: which deliberation plan
 * was selected, which topology alternatives were scored, which model was
 * chosen and why, and which cascade escalations were applied. This is the
 * missing layer between the in-memory DeliberationPlan (which is computed
 * and then discarded) and the audit trail.
 *
 * Storage: append-only NDJSON per run, plus a per-tenant directory layout
 * mirroring TraceStore/SamplesStore. Use `readIntent(runId)` to load the
 * intent for post-hoc debugging.
 *
 * Schema version 1 — add fields without bumping by accepting undefined.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
class IntentLog {
    constructor(baseDir, tenantId) {
        this.writeQueue = [];
        this.flushing = false;
        this.tenantId = tenantId;
        const base = baseDir !== null && baseDir !== void 0 ? baseDir : path.join(process.cwd(), '.commander_intent');
        this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
        fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(this.baseDir, 0o700);
        }
        catch {
            /* best-effort */
        }
    }
    /**
     * Append an IntentRecord to disk. Serialised through a write queue to
     * avoid interleaving partial lines on concurrent calls.
     */
    async write(record) {
        const line = JSON.stringify(record) + '\n';
        this.enqueueWrite(async () => {
            const filePath = path.join(this.baseDir, `${sanitizeRunId(record.runId)}.ndjson`);
            fs.appendFileSync(filePath, line, 'utf-8');
            try {
                fs.chmodSync(filePath, 0o600);
            }
            catch {
                /* best-effort */
            }
        });
    }
    /** Read the most recent intent record for a run, or null if none exists. */
    readIntent(runId) {
        const filePath = path.join(this.baseDir, `${sanitizeRunId(runId)}.ndjson`);
        if (!fs.existsSync(filePath))
            return null;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw)
                return null;
            const lines = raw.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    return JSON.parse(lines[i]);
                }
                catch {
                    // skip corrupt line
                }
            }
            return null;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('IntentLog', 'Failed to read intent', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId,
            });
            return null;
        }
    }
    /** List all run ids with captured intent. */
    listRuns() {
        try {
            const entries = fs.readdirSync(this.baseDir);
            return entries.filter((f) => f.endsWith('.ndjson')).map((f) => f.replace(/\.ndjson$/, ''));
        }
        catch {
            return [];
        }
    }
    /** Drain pending writes. Call before shutdown. */
    async flush() {
        if (this.flushing)
            return;
        this.flushing = true;
        try {
            while (this.writeQueue.length > 0) {
                const task = this.writeQueue.shift();
                if (task)
                    await task();
            }
        }
        finally {
            this.flushing = false;
        }
    }
    getBaseDir() {
        return this.baseDir;
    }
    enqueueWrite(task) {
        this.writeQueue.push(task);
        if (!this.flushing) {
            void this.flush();
        }
    }
}
exports.IntentLog = IntentLog;
function sanitizeRunId(runId) {
    // Block path traversal — the runId is used as a filename component.
    return runId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const intentLogSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new IntentLog());
function getIntentLog(tenantId) {
    if (tenantId)
        return intentLogSingleton.getForTenant(tenantId);
    return intentLogSingleton.get();
}
function resetIntentLog() {
    intentLogSingleton.reset();
}
