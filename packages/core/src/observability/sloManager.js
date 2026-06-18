"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SLOManager = void 0;
exports.getSLOManager = getSLOManager;
exports.resetSLOManager = resetSLOManager;
class SLOManager {
    constructor() {
        this.slos = new Map();
        this.violations = [];
    }
    createSLO(slo) {
        const id = `slo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const newSlo = {
            ...slo,
            id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        this.slos.set(id, newSlo);
        return newSlo;
    }
    updateSLO(id, updates) {
        const slo = this.slos.get(id);
        if (!slo)
            return undefined;
        const updated = { ...slo, ...updates, id, updatedAt: new Date().toISOString() };
        this.slos.set(id, updated);
        return updated;
    }
    deleteSLO(id) {
        return this.slos.delete(id);
    }
    getSLO(id) {
        return this.slos.get(id);
    }
    listSLOs() {
        return Array.from(this.slos.values());
    }
    checkTrace(trace) {
        const violations = [];
        for (const slo of this.slos.values()) {
            if (!slo.enabled)
                continue;
            let actualValue;
            switch (slo.metric) {
                case 'latency_ms':
                    actualValue = trace.summary.totalDurationMs;
                    break;
                case 'tokens':
                    actualValue = trace.summary.totalTokens;
                    break;
                case 'error_rate':
                    actualValue = trace.summary.errors / Math.max(trace.summary.totalEvents, 1);
                    break;
                case 'success_rate':
                    actualValue = 1 - trace.summary.errors / Math.max(trace.summary.totalEvents, 1);
                    break;
                case 'cost_usd':
                    actualValue = 0;
                    break;
                default:
                    continue;
            }
            let violated = false;
            switch (slo.operator) {
                case 'lt':
                    violated = actualValue < slo.threshold;
                    break;
                case 'lte':
                    violated = actualValue <= slo.threshold;
                    break;
                case 'gt':
                    violated = actualValue > slo.threshold;
                    break;
                case 'gte':
                    violated = actualValue >= slo.threshold;
                    break;
                case 'eq':
                    violated = actualValue === slo.threshold;
                    break;
            }
            if (violated) {
                const severity = slo.metric === 'error_rate' ? 'critical' : 'warning';
                const violation = {
                    sloId: slo.id,
                    timestamp: new Date().toISOString(),
                    runId: trace.runId,
                    metric: slo.metric,
                    actualValue,
                    threshold: slo.threshold,
                    severity,
                };
                violations.push(violation);
                this.violations.push(violation);
            }
        }
        return violations;
    }
    getViolations(sloId) {
        if (sloId)
            return this.violations.filter((v) => v.sloId === sloId);
        return [...this.violations];
    }
    getStatus() {
        return Array.from(this.slos.values()).map((slo) => {
            var _a;
            const recentViolations = this.violations.filter((v) => v.sloId === slo.id).slice(-100);
            const violationCount = recentViolations.length;
            const lastViolation = recentViolations[recentViolations.length - 1];
            const currentValue = (_a = lastViolation === null || lastViolation === void 0 ? void 0 : lastViolation.actualValue) !== null && _a !== void 0 ? _a : 0;
            return {
                sloId: slo.id,
                name: slo.name,
                metric: slo.metric,
                threshold: slo.threshold,
                currentValue,
                isViolating: violationCount > 0 &&
                    lastViolation &&
                    new Date(lastViolation.timestamp).getTime() > Date.now() - 60000,
                violationCount,
                lastChecked: new Date().toISOString(),
            };
        });
    }
}
exports.SLOManager = SLOManager;
let globalManager = null;
function getSLOManager() {
    if (!globalManager)
        globalManager = new SLOManager();
    return globalManager;
}
function resetSLOManager() {
    globalManager = null;
}
