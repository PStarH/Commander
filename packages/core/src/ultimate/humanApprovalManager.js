"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HumanApprovalManager = void 0;
exports.getHumanApprovalManager = getHumanApprovalManager;
exports.resetHumanApprovalManager = resetHumanApprovalManager;
/**
 * HumanApprovalManager — P3: Structured human-in-the-loop approvals.
 *
 * When a sub-agent node requires human approval, the SubAgentExecutor
 * publishes a `human.approval_required` event on the message bus and
 * blocks waiting for either:
 *   1. A matching `human.approval_received` message (via respond()),
 *   2. A timeout, which triggers the configured onTimeout fallback.
 *
 * One manager per (tenant, runId) so concurrent runs don't collide.
 */
const messageBus_1 = require("../runtime/messageBus");
const logging_1 = require("../logging");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const APPROVAL_ID_PREFIX = 'appr_';
function generateApprovalId() {
    return `${APPROVAL_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
class HumanApprovalManager {
    constructor() {
        this.pending = new Map();
        this.responses = new Map();
        this.DEFAULT_DECISION_ON_TIMEOUT = 'reject';
    }
    request(request) {
        var _a, _b, _c;
        const approvalId = generateApprovalId();
        const fullRequest = {
            ...request,
            approvalId,
            requestedAt: new Date().toISOString(),
        };
        const timeoutMs = (_a = fullRequest.gate.timeoutMs) !== null && _a !== void 0 ? _a : DEFAULT_TIMEOUT_MS;
        const onTimeout = (_b = fullRequest.gate.onTimeout) !== null && _b !== void 0 ? _b : this.DEFAULT_DECISION_ON_TIMEOUT;
        const entry = {
            request: fullRequest,
            resolve: () => { },
            timer: null,
            completed: false,
        };
        const promise = new Promise((resolve) => {
            entry.resolve = resolve;
        });
        entry.timer = setTimeout(() => {
            if (entry.completed)
                return;
            entry.completed = true;
            const resolution = {
                approvalId,
                decision: onTimeout,
                approverId: 'system:timeout',
                note: `No human response within ${timeoutMs}ms; falling back to '${onTimeout}'`,
                resolvedAt: new Date().toISOString(),
                timedOut: true,
            };
            this.responses.set(approvalId, resolution);
            this.pending.delete(approvalId);
            (0, messageBus_1.getMessageBus)().publish('human.approval_timeout', 'human-approval-manager', {
                approvalId,
                runId: fullRequest.runId,
                nodeId: fullRequest.nodeId,
                requestedAt: fullRequest.requestedAt,
            });
            (0, logging_1.getGlobalLogger)().info('HumanApprovalManager', 'Approval timed out', {
                approvalId,
                runId: fullRequest.runId,
                nodeId: fullRequest.nodeId,
                decision: onTimeout,
            });
            entry.resolve(resolution);
        }, timeoutMs);
        this.pending.set(approvalId, entry);
        (0, messageBus_1.getMessageBus)().publish('human.approval_required', fullRequest.requesterId, {
            approvalId,
            runId: fullRequest.runId,
            nodeId: fullRequest.nodeId,
            nodeGoal: fullRequest.nodeGoal,
            gate: (_c = fullRequest.gate.riskThreshold) !== null && _c !== void 0 ? _c : 'unknown',
            riskLevel: fullRequest.riskLevel,
            timeoutMs,
            requesterId: fullRequest.requesterId,
        });
        void promise;
        return fullRequest;
    }
    /**
     * Wait for an approval request to resolve. Resolves with the
     * resolution (decision + metadata) or with the timeout decision.
     */
    awaitResolution(approvalId) {
        const cached = this.responses.get(approvalId);
        if (cached)
            return Promise.resolve(cached);
        const entry = this.pending.get(approvalId);
        if (!entry) {
            return Promise.resolve({
                approvalId,
                decision: this.DEFAULT_DECISION_ON_TIMEOUT,
                approverId: 'system:unknown-approval',
                note: 'No pending approval found; defaulting to reject',
                resolvedAt: new Date().toISOString(),
                timedOut: true,
            });
        }
        return new Promise((resolve) => {
            const origResolve = entry.resolve;
            entry.resolve = (res) => {
                origResolve(res);
                resolve(res);
            };
        });
    }
    /**
     * Record a human response. The first response wins; subsequent
     * responses for the same approvalId are ignored.
     */
    respond(approvalId, approverId, decision, note) {
        const entry = this.pending.get(approvalId);
        if (!entry || entry.completed)
            return null;
        entry.completed = true;
        if (entry.timer)
            clearTimeout(entry.timer);
        const resolution = {
            approvalId,
            decision,
            approverId,
            note,
            resolvedAt: new Date().toISOString(),
            timedOut: false,
        };
        this.responses.set(approvalId, resolution);
        this.pending.delete(approvalId);
        const topic = decision === 'reject' ? 'human.approval_rejected' : 'human.approval_received';
        (0, messageBus_1.getMessageBus)().publish(topic, approverId, {
            approvalId,
            runId: entry.request.runId,
            nodeId: entry.request.nodeId,
            ...(decision === 'reject'
                ? { reason: note !== null && note !== void 0 ? note : 'No reason provided' }
                : { approverId, decision, ...(note ? { note } : {}) }),
        });
        entry.resolve(resolution);
        return resolution;
    }
    /** Inspect a pending request without resolving it. */
    getPending(approvalId) {
        var _a, _b;
        return (_b = (_a = this.pending.get(approvalId)) === null || _a === void 0 ? void 0 : _a.request) !== null && _b !== void 0 ? _b : null;
    }
    /** List all currently pending approval IDs. */
    listPending(runId) {
        const all = Array.from(this.pending.keys());
        if (!runId)
            return all;
        return all.filter((id) => { var _a; return ((_a = this.pending.get(id)) === null || _a === void 0 ? void 0 : _a.request.runId) === runId; });
    }
    /** Cancel all pending approvals for a run. Used when an execution is aborted. */
    cancelAllForRun(runId, reason = 'Execution aborted') {
        let cancelled = 0;
        for (const [id, entry] of this.pending) {
            if (entry.request.runId !== runId || entry.completed)
                continue;
            entry.completed = true;
            if (entry.timer)
                clearTimeout(entry.timer);
            const resolution = {
                approvalId: id,
                decision: 'reject',
                approverId: 'system:cancel',
                note: reason,
                resolvedAt: new Date().toISOString(),
                timedOut: false,
            };
            this.responses.set(id, resolution);
            this.pending.delete(id);
            entry.resolve(resolution);
            cancelled++;
        }
        return cancelled;
    }
    /** Drop resolved entries older than the given age in ms. Default 1 hour. */
    pruneResolved(maxAgeMs = 3600000) {
        const threshold = Date.now() - maxAgeMs;
        let removed = 0;
        for (const [id, res] of this.responses) {
            if (new Date(res.resolvedAt).getTime() < threshold) {
                this.responses.delete(id);
                removed++;
            }
        }
        return removed;
    }
}
exports.HumanApprovalManager = HumanApprovalManager;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const approvalManagerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new HumanApprovalManager());
function getHumanApprovalManager() {
    return approvalManagerSingleton.get();
}
function resetHumanApprovalManager() {
    approvalManagerSingleton.reset();
}
