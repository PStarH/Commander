"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PredictionLoop = void 0;
const messageBus_1 = require("../runtime/messageBus");
const metricsCollector_1 = require("../runtime/metricsCollector");
class PredictionLoop {
    constructor(enabled = true) {
        this.predictions = [];
        this.verdicts = [];
        /** Tracks last strategy selected per (modelId, taskType) for change detection */
        this.lastPredictedStrategy = new Map();
        this.enabled = enabled;
    }
    createPrediction(editId, description, targetStrategy, sourceStrategy, modelId, taskTypes, predictedFixes = [], predictedRegressions = []) {
        const prediction = {
            id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            editId,
            description,
            predictedFixes,
            predictedRegressions,
            targetStrategy,
            sourceStrategy,
            modelId,
            taskTypes,
            timestamp: new Date().toISOString(),
        };
        this.predictions.push(prediction);
        if (this.predictions.length > 500)
            this.predictions.shift();
        return prediction;
    }
    recordExperience(exp) {
        if (!this.enabled)
            return;
        this.verifyPrediction(exp);
    }
    getPredictions() {
        return [...this.predictions];
    }
    getVerdicts() {
        return [...this.verdicts];
    }
    getLastPredictedStrategy() {
        return this.lastPredictedStrategy;
    }
    setPredictions(predictions) {
        this.predictions = predictions;
    }
    setVerdicts(verdicts) {
        this.verdicts = verdicts;
    }
    setLastPredictedStrategy(map) {
        this.lastPredictedStrategy = map;
    }
    verifyPrediction(exp) {
        if (!this.enabled)
            return;
        const key = `${exp.modelUsed}::${exp.taskType}`;
        const previousStrategy = this.lastPredictedStrategy.get(key);
        if (!previousStrategy || previousStrategy === exp.strategyUsed)
            return;
        // Strategy changed — find relevant prediction
        const relevant = this.predictions.filter((p) => p.targetStrategy === exp.strategyUsed &&
            p.modelId === exp.modelUsed &&
            p.taskTypes.includes(exp.taskType));
        for (const pred of relevant) {
            const fixConfirmed = pred.predictedFixes.length === 0 ? exp.success : true;
            const regressObserved = !exp.success && pred.predictedRegressions.length > 0;
            const verdict = {
                predictionId: pred.id,
                fixesConfirmed: fixConfirmed ? ['confirmed'] : [],
                regressionsObserved: regressObserved ? ['observed'] : [],
                netImpact: exp.success ? 'positive' : 'negative',
                reverted: false,
                verifiedAt: new Date().toISOString(),
            };
            this.verdicts.push(verdict);
            if (this.verdicts.length > 500)
                this.verdicts.shift();
            // Record prediction verdict metric (skip neutral)
            try {
                if (verdict.netImpact !== 'neutral') {
                    // @ts-ignore — best-effort metric, may not be on collector yet
                    (0, metricsCollector_1.getMetricsCollector)().recordPredictionVerdict(verdict.netImpact);
                }
            }
            catch {
                /* best-effort */
            }
            const bus = (0, messageBus_1.getMessageBus)();
            bus.publish('memory.written', 'meta-learner', {
                type: 'prediction_verdict',
                predictionId: pred.id,
                netImpact: verdict.netImpact,
            });
        }
    }
}
exports.PredictionLoop = PredictionLoop;
