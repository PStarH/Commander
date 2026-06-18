"use strict";
/**
 * StateCheckpointer — Crash-safe execution state persistence for AgentRuntime.
 *
 * Writes a JSON snapshot of mutable execution state after every LLM call,
 * tool execution cycle, and verification. Atomic writes (write to tmp, rename)
 * prevent corruption. Enables crash recovery and long-running workflow resilience.
 */
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
exports.StateCheckpointer = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logging_1 = require("../logging");
const metricsCollector_1 = require("./metricsCollector");
class StateCheckpointer {
    constructor(baseDir, tenantId, options) {
        this.pruneCounter = 0;
        this.tenantId = tenantId;
        this.leaseManager = options === null || options === void 0 ? void 0 : options.leaseManager;
        const base = baseDir !== null && baseDir !== void 0 ? baseDir : path.join(process.cwd(), '.commander_state');
        this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
        fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(this.baseDir, 0o700);
        }
        catch {
            /* best-effort */
        }
        fs.mkdirSync(path.join(this.baseDir, 'completed'), { recursive: true, mode: 0o700 });
        try {
            fs.chmodSync(path.join(this.baseDir, 'completed'), 0o700);
        }
        catch {
            /* best-effort */
        }
    }
    setLeaseManager(leaseManager) {
        this.leaseManager = leaseManager;
    }
    /**
     * Validate that `state` carries a live lease on `runId`. Bumps `state.version`
     * monotonically before write. Returns false (and skips the write) if fenced.
     * When no LeaseManager is bound, validation is a no-op and the write proceeds.
     */
    authorize(state) {
        var _a;
        if (!this.leaseManager)
            return true;
        if (!state.leaseToken || typeof state.fencingEpoch !== 'number') {
            (0, logging_1.getGlobalLogger)().debug('StateCheckpointer', 'Checkpoint missing lease credentials', {
                runId: state.runId,
                hasToken: !!state.leaseToken,
                hasEpoch: typeof state.fencingEpoch === 'number',
            });
            return false;
        }
        const live = this.leaseManager.validate(state.runId, state.leaseToken, state.fencingEpoch, {
            tenantId: this.tenantId,
        });
        if (!live) {
            (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Fenced: checkpoint write rejected', {
                runId: state.runId,
                token: state.leaseToken,
                epoch: state.fencingEpoch,
            });
            return false;
        }
        const prior = this._readFile(path.join(this.baseDir, `${state.runId}.checkpoint`));
        state.version = ((_a = prior === null || prior === void 0 ? void 0 : prior.version) !== null && _a !== void 0 ? _a : 0) + 1;
        return true;
    }
    checkpoint(state) {
        var _a;
        if (!this.authorize(state))
            return;
        const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);
        const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
            try {
                fs.chmodSync(tmpPath, 0o600);
            }
            catch {
                /* best-effort */
            }
            fs.renameSync(tmpPath, chkPath);
            try {
                fs.chmodSync(chkPath, 0o600);
            }
            catch {
                /* best-effort */
            }
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordCheckpointFlush((_a = state.phase) !== null && _a !== void 0 ? _a : 'unknown');
            }
            catch {
                /* best-effort */
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to write checkpoint', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId: state.runId,
            });
        }
    }
    terminalCheckpoint(state) {
        if (!this.authorize(state))
            return;
        const chkPath = path.join(this.baseDir, `${state.runId}.checkpoint`);
        const donePath = path.join(this.baseDir, 'completed', `${state.runId}.json`);
        const tmpPath = path.join(this.baseDir, `${state.runId}.tmp`);
        const writeTmp = path.join(this.baseDir, `${state.runId}.terminal.tmp`);
        try {
            fs.writeFileSync(writeTmp, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
            try {
                fs.chmodSync(writeTmp, 0o600);
            }
            catch {
                /* best-effort */
            }
            fs.renameSync(writeTmp, donePath);
            try {
                fs.chmodSync(donePath, 0o600);
            }
            catch {
                /* best-effort */
            }
            try {
                (0, metricsCollector_1.getMetricsCollector)().recordCheckpointFlush('terminal');
            }
            catch {
                /* best-effort */
            }
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to write terminal checkpoint', {
                error: e === null || e === void 0 ? void 0 : e.message,
                runId: state.runId,
            });
        }
        if (fs.existsSync(chkPath)) {
            try {
                fs.unlinkSync(chkPath);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to remove checkpoint file', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    runId: state.runId,
                });
            }
        }
        if (fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to remove temp file', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    runId: state.runId,
                });
            }
        }
        // Auto-prune completed checkpoints periodically (not every completion)
        this.pruneCounter++;
        if (this.pruneCounter >= 10) {
            this.pruneCounter = 0;
            this.prune(100);
        }
    }
    resume(runId) {
        const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
        if (fs.existsSync(chkPath)) {
            try {
                const raw = fs.readFileSync(chkPath, 'utf-8');
                return JSON.parse(raw);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to resume from checkpoint', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    runId,
                });
                try {
                    fs.unlinkSync(chkPath);
                }
                catch (unlinkError) {
                    (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to remove corrupt checkpoint', {
                        error: unlinkError === null || unlinkError === void 0 ? void 0 : unlinkError.message,
                        runId,
                    });
                }
                return null;
            }
        }
        const donePath = path.join(this.baseDir, 'completed', `${runId}.json`);
        if (fs.existsSync(donePath)) {
            try {
                const raw = fs.readFileSync(donePath, 'utf-8');
                return JSON.parse(raw);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to read completed checkpoint', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    runId,
                });
                return null;
            }
        }
        return null;
    }
    listCheckpoints() {
        const results = [];
        const addFromDir = (dir) => {
            try {
                const entries = fs.readdirSync(dir);
                for (const f of entries) {
                    // Skip non-checkpoint files and directories
                    if (f.endsWith('.tmp'))
                        continue;
                    if (!f.endsWith('.checkpoint') && !f.endsWith('.json'))
                        continue;
                    const state = this._readFile(path.join(dir, f));
                    if (state && typeof state.phase === 'string' && typeof state.timestamp === 'string') {
                        const runId = f.replace(/\.(checkpoint|json)$/, '');
                        results.push({ runId, phase: state.phase, timestamp: state.timestamp });
                    }
                }
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to list checkpoints', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                    dir,
                });
            }
        };
        addFromDir(this.baseDir);
        addFromDir(path.join(this.baseDir, 'completed'));
        return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }
    deleteCheckpoint(runId) {
        for (const p of [
            path.join(this.baseDir, `${runId}.checkpoint`),
            path.join(this.baseDir, `${runId}.tmp`),
            path.join(this.baseDir, 'completed', `${runId}.json`),
        ]) {
            if (fs.existsSync(p)) {
                try {
                    fs.unlinkSync(p);
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to delete checkpoint artifact', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                        path: p,
                        runId,
                    });
                }
            }
        }
    }
    prune(keepCount) {
        const all = this.listCheckpoints();
        if (all.length <= keepCount)
            return;
        for (const entry of all.slice(keepCount)) {
            this.deleteCheckpoint(entry.runId);
        }
    }
    /** Release any resources held by this checkpointer. */
    dispose() { }
    /**
     * Load the latest checkpoint for a run. Returns null if no checkpoint exists.
     * If a LeaseManager is bound, validates the lease before returning.
     */
    loadCheckpoint(runId) {
        const chkPath = path.join(this.baseDir, `${runId}.checkpoint`);
        const state = this._readFile(chkPath);
        if (!state)
            return null;
        if (this.leaseManager && state.leaseToken && typeof state.fencingEpoch === 'number') {
            const live = this.leaseManager.validate(runId, state.leaseToken, state.fencingEpoch, {
                tenantId: this.tenantId,
            });
            if (!live) {
                (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Fenced: checkpoint read rejected', {
                    runId,
                    token: state.leaseToken,
                    epoch: state.fencingEpoch,
                });
                return null;
            }
        }
        return state;
    }
    _readFile(filePath) {
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(raw);
        }
        catch (e) {
            (0, logging_1.getGlobalLogger)().warn('StateCheckpointer', 'Failed to read checkpoint file', {
                error: e === null || e === void 0 ? void 0 : e.message,
                filePath,
            });
            return null;
        }
    }
}
exports.StateCheckpointer = StateCheckpointer;
