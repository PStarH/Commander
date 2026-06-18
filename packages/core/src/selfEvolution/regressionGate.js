"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegressionGate = void 0;
const messageBus_1 = require("../runtime/messageBus");
const metricsCollector_1 = require("../runtime/metricsCollector");
class RegressionGate {
    constructor(threshold = 0.15) {
        this.regressionEvents = [];
        /** Rolling success rate history per strategy: Map<strategyName, number[]> */
        this.successRateHistory = new Map();
        this.threshold = threshold;
    }
    recordExperience(exp) {
        const histKey = `${exp.strategyUsed}::${exp.modelUsed}`;
        if (!this.successRateHistory.has(histKey)) {
            if (this.successRateHistory.size >= RegressionGate.MAX_SUCCESS_RATE_ENTRIES) {
                const oldest = this.successRateHistory.keys().next().value;
                if (oldest)
                    this.successRateHistory.delete(oldest);
            }
            this.successRateHistory.set(histKey, []);
        }
        const history = this.successRateHistory.get(histKey);
        history.push(exp.success ? 1 : 0);
        // Keep last 20 outcomes for the rolling window
        if (history.length > 20)
            history.shift();
        // Need at least 5 data points and a prior comparison window
        if (history.length < 10)
            return;
        const recentWindow = Math.min(5, Math.floor(history.length / 2));
        const recent = history.slice(-recentWindow);
        const prior = history.slice(0, history.length - recentWindow);
        const recentRate = recent.reduce((s, v) => s + v, 0) / recent.length;
        const priorRate = prior.reduce((s, v) => s + v, 0) / prior.length;
        if (priorRate > 0 && recentRate < priorRate * (1 - this.threshold)) {
            const dropRatio = priorRate > 0 ? (priorRate - recentRate) / priorRate : 0;
            if (dropRatio >= this.threshold) {
                const event = {
                    strategyName: exp.strategyUsed,
                    modelId: exp.modelUsed,
                    taskType: exp.taskType,
                    previousSuccessRate: priorRate,
                    currentSuccessRate: recentRate,
                    dropRatio,
                    triggeredAt: new Date().toISOString(),
                    autoReverted: false,
                };
                this.regressionEvents.push(event);
                if (this.regressionEvents.length > 200)
                    this.regressionEvents.shift();
                // Update regression active count gauge
                try {
                    // @ts-ignore — best-effort metric, may not be on collector yet
                    (0, metricsCollector_1.getMetricsCollector)().recordRegressionActiveCount(this.regressionEvents.length);
                }
                catch {
                    /* best-effort */
                }
                const bus = (0, messageBus_1.getMessageBus)();
                bus.publish('system.alert', 'meta-learner', {
                    type: 'regression_detected',
                    strategy: exp.strategyUsed,
                    modelId: exp.modelUsed,
                    dropRatio,
                    priorRate,
                    recentRate,
                });
            }
        }
    }
    getRegressionEvents(limit = 20) {
        return this.regressionEvents.slice(-limit);
    }
    getRegressionEventsList() {
        return this.regressionEvents;
    }
    getSuccessRateHistory() {
        return this.successRateHistory;
    }
    setRegressionEvents(events) {
        this.regressionEvents = events;
    }
    setSuccessRateHistory(history) {
        this.successRateHistory = history;
    }
    setThreshold(threshold) {
        this.threshold = threshold;
    }
}
exports.RegressionGate = RegressionGate;
RegressionGate.MAX_SUCCESS_RATE_ENTRIES = 200;
