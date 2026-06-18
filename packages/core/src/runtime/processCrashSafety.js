"use strict";
/**
 * ProcessCrashSafety — Installs process-level crash handlers.
 *
 * Closes the "no process.on('uncaughtException')" gap from the reversibility
 * audit. Without this, a single uncaught error in any LLM callback, tool
 * promise rejection, or async tool execution kills the process, leaving:
 *   - Held leases (zombie processes)
 *   - Unwritten DLQ entries
 *   - In-flight compensation handlers orphaned
 *
 * On crash, this module:
 *   1. Logs to DLQ for each active run
 *   2. Releases leases via LeaseManager
 *   3. Aborts scheduler for each active run
 *   4. Exits with code 1
 *
 * Idempotent: calling install() multiple times is safe (replaces handler).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.installProcessCrashHandlers = installProcessCrashHandlers;
exports.isShuttingDown = isShuttingDown;
exports.resetCrashHandlersForTesting = resetCrashHandlersForTesting;
const logging_1 = require("../logging");
const scheduler_1 = require("../atr/scheduler");
let installed = false;
let shuttingDown = false;
function installProcessCrashHandlers(deps) {
    var _a;
    if (installed)
        return;
    installed = true;
    const log = (0, logging_1.getGlobalLogger)();
    const exitTimeoutMs = (_a = deps.exitTimeoutMs) !== null && _a !== void 0 ? _a : 3000;
    const gracefulShutdown = (source, err) => {
        var _a, _b, _c, _d;
        if (shuttingDown)
            return;
        shuttingDown = true;
        const errorMessage = (_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : String(err !== null && err !== void 0 ? err : 'unknown');
        log.error('ProcessCrashSafety', `Process crash: ${source}`, undefined, { errorMessage });
        let dlqWritten = 0;
        let leasesReleased = 0;
        let runsAborted = 0;
        for (const runId of deps.activeRunIds()) {
            const leaseToken = (_b = deps.leaseTokenFor) === null || _b === void 0 ? void 0 : _b.call(deps, runId);
            const fencingEpoch = (_c = deps.fencingEpochFor) === null || _c === void 0 ? void 0 : _c.call(deps, runId);
            const tenantId = (_d = deps.tenantIdFor) === null || _d === void 0 ? void 0 : _d.call(deps, runId);
            const entry = {
                id: `crash-${runId}-${Date.now()}`,
                category: 'execution',
                runId,
                agentId: 'process-crash-safety',
                timestamp: new Date().toISOString(),
                errorClass: 'permanent',
                errorMessage: `Process ${source}: ${errorMessage.slice(0, 500)}`,
                retryable: true,
                attemptNumber: 0,
                operationName: 'process.crash',
                compensated: false,
                recovered: false,
                tags: ['crash', source],
            };
            try {
                deps.dlq.record(entry);
                dlqWritten++;
            }
            catch (e) {
                log.error('ProcessCrashSafety', 'DLQ record failed during crash shutdown', undefined, {
                    runId,
                    errorMessage: e.message,
                });
            }
            if (leaseToken) {
                try {
                    deps.leaseManager.release(runId, leaseToken, { tenantId });
                    leasesReleased++;
                }
                catch (e) {
                    log.debug('ProcessCrashSafety', 'Lease release failed during crash', {
                        runId,
                        error: e.message,
                    });
                }
            }
            if (leaseToken && fencingEpoch !== undefined) {
                try {
                    const scheduler = (0, scheduler_1.getExecutionScheduler)();
                    scheduler.abortRun({
                        runId,
                        leaseToken,
                        fencingEpoch,
                        tenantId,
                        reason: `Process ${source}: ${errorMessage.slice(0, 200)}`,
                    });
                    runsAborted++;
                }
                catch (e) {
                    log.debug('ProcessCrashSafety', 'Scheduler abortRun failed during crash', {
                        runId,
                        error: e.message,
                    });
                }
            }
        }
        log.error('ProcessCrashSafety', 'Crash shutdown complete', undefined, {
            source,
            dlqWritten,
            leasesReleased,
            runsAborted,
            errorMessage,
        });
        try {
            deps.dlq.flush();
        }
        catch (e) {
            log.error('ProcessCrashSafety', 'DLQ flush failed during crash shutdown', undefined, {
                errorMessage: e.message,
            });
        }
        setTimeout(() => process.exit(1), exitTimeoutMs).unref();
    };
    process.on('uncaughtException', (err) => gracefulShutdown('uncaughtException', err));
    process.on('unhandledRejection', (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        gracefulShutdown('unhandledRejection', err);
    });
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
function isShuttingDown() {
    return shuttingDown;
}
function resetCrashHandlersForTesting() {
    installed = false;
    shuttingDown = false;
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
}
