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
exports.VerificationReportStore = void 0;
exports.getVerificationReportStore = getVerificationReportStore;
exports.resetVerificationReportStore = resetVerificationReportStore;
/**
 * VerificationReportStore — Persists full verification reports for replay.
 *
 * The UnifiedVerificationPipeline produces rich VerificationReport objects
 * (signals, snippets, suggestions, stages, confidence). Until now, only
 * a reduced boolean was recorded. This store captures the full report so
 * a failed verification can be replayed offline to understand which stage
 * and which signal triggered the failure.
 *
 * Storage: append-only NDJSON per run under .commander_verifications/.
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
class VerificationReportStore {
    constructor(baseDir, tenantId) {
        this.writeQueue = [];
        this.flushing = false;
        this.tenantId = tenantId;
        const base = baseDir !== null && baseDir !== void 0 ? baseDir : path.join(process.cwd(), '.commander_verifications');
        this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
        fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(this.baseDir, 0o700);
        }
        catch {
            /* best-effort */
        }
    }
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
    readReports(runId) {
        const filePath = path.join(this.baseDir, `${sanitizeRunId(runId)}.ndjson`);
        if (!fs.existsSync(filePath))
            return [];
        try {
            const raw = fs.readFileSync(filePath, 'utf-8').trim();
            if (!raw)
                return [];
            const out = [];
            for (const line of raw.split('\n')) {
                try {
                    out.push(JSON.parse(line));
                }
                catch {
                    // skip corrupt line
                }
            }
            return out;
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('VerificationReportStore', 'Failed to read verification reports', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId,
            });
            return [];
        }
    }
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
exports.VerificationReportStore = VerificationReportStore;
function sanitizeRunId(runId) {
    return runId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
}
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const verificationStoreSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new VerificationReportStore());
function getVerificationReportStore(tenantId) {
    if (tenantId)
        return verificationStoreSingleton.getForTenant(tenantId);
    return verificationStoreSingleton.get();
}
function resetVerificationReportStore() {
    verificationStoreSingleton.reset();
}
