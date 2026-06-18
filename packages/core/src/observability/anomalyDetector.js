"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenUsageAnomalyDetector = void 0;
exports.getAnomalyDetector = getAnomalyDetector;
exports.resetAnomalyDetector = resetAnomalyDetector;
class TokenUsageAnomalyDetector {
    constructor() {
        this.history = new Map();
        this.alerts = [];
        this.windowSize = 50;
        this.zScoreThreshold = 2.5;
        this.criticalZScore = 4.0;
    }
    recordUsage(agentId, tokenUsage) {
        var _a;
        const history = (_a = this.history.get(agentId)) !== null && _a !== void 0 ? _a : { mean: 0, stdDev: 0, samples: 0 };
        const n = history.samples;
        const newMean = (history.mean * n + tokenUsage) / (n + 1);
        const variance = n > 0
            ? (history.stdDev ** 2 * n + (tokenUsage - history.mean) * (tokenUsage - newMean)) / (n + 1)
            : 0;
        history.mean = newMean;
        history.stdDev = Math.sqrt(Math.max(variance, 0));
        history.samples = Math.min(n + 1, this.windowSize);
        this.history.set(agentId, history);
    }
    checkForAnomaly(agentId, runId, stepNumber, tokenUsage) {
        const history = this.history.get(agentId);
        if (!history || history.samples < 10)
            return null;
        if (history.stdDev === 0) {
            if (tokenUsage !== history.mean) {
                const alert = {
                    timestamp: new Date().toISOString(),
                    runId,
                    agentId,
                    stepNumber,
                    tokenUsage,
                    baseline: history.mean,
                    zScore: Infinity,
                    severity: 'critical',
                };
                this.alerts.push(alert);
                return alert;
            }
            return null;
        }
        const zScore = (tokenUsage - history.mean) / history.stdDev;
        if (Math.abs(zScore) < this.zScoreThreshold)
            return null;
        const severity = Math.abs(zScore) >= this.criticalZScore
            ? 'critical'
            : Math.abs(zScore) >= this.zScoreThreshold
                ? 'warning'
                : 'info';
        const alert = {
            timestamp: new Date().toISOString(),
            runId,
            agentId,
            stepNumber,
            tokenUsage,
            baseline: history.mean,
            zScore,
            severity,
        };
        this.alerts.push(alert);
        if (this.alerts.length > 1000)
            this.alerts.shift();
        return alert;
    }
    getAlerts(agentId) {
        if (!agentId)
            return [...this.alerts];
        return this.alerts.filter((a) => a.agentId === agentId);
    }
    getHistory(agentId) {
        return this.history.get(agentId);
    }
    getBaseline(agentId) {
        var _a, _b;
        return (_b = (_a = this.history.get(agentId)) === null || _a === void 0 ? void 0 : _a.mean) !== null && _b !== void 0 ? _b : 0;
    }
}
exports.TokenUsageAnomalyDetector = TokenUsageAnomalyDetector;
let globalDetector = null;
function getAnomalyDetector() {
    if (!globalDetector)
        globalDetector = new TokenUsageAnomalyDetector();
    return globalDetector;
}
function resetAnomalyDetector() {
    globalDetector = null;
}
