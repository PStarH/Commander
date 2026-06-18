"use strict";
/**
 * CompensationBridge — connect legacy CompensationRegistry to RunLedger.
 *
 * The legacy CompensationRegistry is in-memory and per-AgentRuntime. The new
 * RunLedger is crash-safe and saga-correct (REVERSE execution order, 3
 * retries, lease-fenced). The bridge lets existing code keep using the
 * registry API while the ledger becomes the source of truth for actual
 * saga compensation.
 *
 * Design rule: do not collapse the legacy registry. New callers should use
 * RunLedger directly. Old callers route through this bridge.
 *
 * Mapping:
 *   register(toolName, handler)       → legacy map + ledger.handlers
 *   recordActionSaga(action, ctx)     → ledger.recordAction (persisted, fence-validated)
 *                                         + legacy.recordAction (back-compat)
 *   compensateViaLedger(...)          → ledger.abortAndCompensate (real saga)
 *   compensate / compensateAll       → legacy in-memory only
 *   getPendingCount / clear / etc.    → legacy passthrough
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompensationBridge = void 0;
exports.getCompensationBridge = getCompensationBridge;
exports.resetCompensationBridge = resetCompensationBridge;
const compensationRegistry_1 = require("../runtime/compensationRegistry");
const runLedger_1 = require("./runLedger");
class CompensationBridge {
    constructor(legacy) {
        this.legacy = legacy !== null && legacy !== void 0 ? legacy : new compensationRegistry_1.CompensationRegistry();
    }
    getLegacy() {
        return this.legacy;
    }
    register(toolName, handler) {
        this.legacy.register(toolName, handler);
        const bundle = (0, runLedger_1.getRunLedgerBundle)();
        bundle.ledger.registerCompensation(toolName, handler);
    }
    recordAction(action) {
        this.legacy.recordAction(action);
    }
    recordActionSaga(action, ctx) {
        var _a, _b, _c;
        const bundle = (0, runLedger_1.getRunLedgerBundle)();
        const persisted = bundle.ledger.recordAction({
            runId: ctx.runId,
            leaseToken: ctx.leaseToken,
            fencingEpoch: ctx.fencingEpoch,
            tenantId: ctx.tenantId,
            actionId: action.actionId,
            toolName: action.toolName,
            externalSystem: (_a = action.externalSystem) !== null && _a !== void 0 ? _a : 'unknown',
            args: action.args,
            idempotencyKey: (_b = action.idempotencyKey) !== null && _b !== void 0 ? _b : action.actionId,
            compensable: true,
            tags: action.tags,
            description: action.description,
        });
        if (persisted)
            this.legacy.recordAction(action);
        return (_c = persisted === null || persisted === void 0 ? void 0 : persisted.actionId) !== null && _c !== void 0 ? _c : null;
    }
    async compensate(actionId) {
        return this.legacy.compensate(actionId);
    }
    async compensateAll() {
        return this.legacy.compensateAll();
    }
    async compensateViaLedger(runId, leaseToken, fencingEpoch, errorMessage, options) {
        const bundle = (0, runLedger_1.getRunLedgerBundle)();
        return bundle.ledger.abortAndCompensate(runId, leaseToken, fencingEpoch, errorMessage, options);
    }
    getPendingCount() {
        return this.legacy.getPendingCount();
    }
    getCompensatedCount() {
        return this.legacy.getCompensatedCount();
    }
    clear() {
        this.legacy.clear();
    }
}
exports.CompensationBridge = CompensationBridge;
let bridgeInstance = null;
function getCompensationBridge() {
    if (!bridgeInstance)
        bridgeInstance = new CompensationBridge();
    return bridgeInstance;
}
function resetCompensationBridge() {
    bridgeInstance = null;
}
