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
exports.DEFAULT_META_LEARNER_CONFIG = exports.MetaLearner = void 0;
exports.getMetaLearner = getMetaLearner;
exports.resetMetaLearner = resetMetaLearner;
exports.clearMetaLearnerState = clearMetaLearnerState;
const nodePath = __importStar(require("path"));
const messageBus_1 = require("../runtime/messageBus");
const metricsCollector_1 = require("../runtime/metricsCollector");
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const reflection_1 = require("./reflection");
const strategyConstants_1 = require("./strategyConstants");
const strategySelector_1 = require("./strategySelector");
const crossModelMemory_1 = require("./crossModelMemory");
const predictionLoop_1 = require("./predictionLoop");
const regressionGate_1 = require("./regressionGate");
const strategyPerformanceTracker_1 = require("./strategyPerformanceTracker");
const suggestionEngine_1 = require("./suggestionEngine");
const metaLearnerPersistence_1 = require("./metaLearnerPersistence");
// ============================================================================
// MetaLearner — facade over focused sub-modules
// ============================================================================
class MetaLearner {
    constructor(maxExperiences = 500, minSamplesForSuggestion = 5, persistPath, config) {
        this.experiences = [];
        this.reflections = [];
        this.shadowComparisons = [];
        // Sub-module instances
        this.selector = new strategySelector_1.StrategySelector();
        this.crossModel = new crossModelMemory_1.CrossModelMemory();
        this.perfTracker = new strategyPerformanceTracker_1.StrategyPerformanceTracker();
        this.maxExperiences = maxExperiences;
        this.minSamplesForSuggestion = minSamplesForSuggestion;
        this.persistPath = persistPath !== null && persistPath !== void 0 ? persistPath : null;
        this.config = { ...strategyConstants_1.DEFAULT_META_LEARNER_CONFIG, ...config };
        this.predictionLoop = new predictionLoop_1.PredictionLoop(this.config.enablePredictionLoop);
        this.regressionGate = new regressionGate_1.RegressionGate(this.config.regressionThreshold);
        if (this.persistPath) {
            this.load();
        }
    }
    // ========================================================================
    // Experience Recording
    // ========================================================================
    recordExperience(exp) {
        this.experiences.push(exp);
        if (this.experiences.length > this.maxExperiences) {
            this.experiences.shift();
        }
        this.perfTracker.recordExperience(exp);
        this.selector.recordExperience(exp);
        // Cross-model: update per-model priors
        if (this.config.enableCrossModelMemory) {
            this.crossModel.recordExperience(exp);
        }
        // Prediction loop: verify outstanding predictions for this model+taskType
        if (this.config.enablePredictionLoop) {
            this.predictionLoop.recordExperience(exp);
        }
        // Regression gate: check for significant success rate drops
        if (this.config.enableRegressionGate) {
            this.regressionGate.recordExperience(exp);
        }
        // Generate verbal reflection
        const reflection = (0, reflection_1.generateReflection)(exp);
        this.reflections.push(reflection);
        if (this.reflections.length > 200) {
            this.reflections.shift();
        }
        const bus = (0, messageBus_1.getMessageBus)();
        bus.publish('memory.written', 'meta-learner', {
            type: 'execution_experience',
            runId: exp.runId,
            success: exp.success,
            strategy: exp.strategyUsed,
            reflection: reflection.slice(0, 200),
        });
        // Persist for cross-session learning
        this.persist();
        // Update experience count gauge
        try {
            // @ts-ignore — best-effort metric, may not be on collector yet
            (0, metricsCollector_1.getMetricsCollector)().recordMetaLearnerExperienceCount(this.experiences.length);
        }
        catch {
            /* best-effort */
        }
    }
    // ========================================================================
    // Strategy Selection
    // ========================================================================
    selectStrategy(taskType, modelId) {
        const chosen = this.selector.selectStrategy(taskType, this.perfTracker.getStrategyPerformance(), modelId);
        if (this.config.enablePredictionLoop && modelId) {
            const key = `${modelId}::${taskType}`;
            this.predictionLoop.getLastPredictedStrategy().set(key, chosen);
        }
        return chosen;
    }
    /**
     * Select the runner-up (second-best) strategy for shadow mode comparison.
     */
    selectShadowStrategy(taskType) {
        return this.selector.selectShadowStrategy(taskType, this.perfTracker.getStrategyPerformance());
    }
    /**
     * Record a shadow comparison result.
     */
    recordShadowComparison(params) {
        this.shadowComparisons.push({
            ...params,
            timestamp: new Date().toISOString(),
        });
        if (this.shadowComparisons.length > 200)
            this.shadowComparisons.shift();
        this.selector.recordShadowComparison({
            taskType: params.taskType,
            shadowStrategy: params.shadowStrategy,
            shadowSuccess: params.shadowSuccess,
        });
    }
    /**
     * Get recent shadow mode comparisons.
     */
    getShadowComparisons(limit = 10) {
        return this.shadowComparisons.slice(-limit);
    }
    // ========================================================================
    // Query Methods
    // ========================================================================
    getStrategyScores(taskType) {
        return this.selector.getStrategyScores(taskType, this.perfTracker.getStrategyPerformance());
    }
    /**
     * Calculate adjusted scores for all strategies on a task type.
     * Mirrors the scoring used by selectStrategy/selectShadowStrategy.
     */
    calculateAdjustedScores(taskType) {
        return this.selector
            .getStrategyScores(taskType, this.perfTracker.getStrategyPerformance())
            .map((s) => ({
            name: s.strategy,
            score: s.score,
            trials: s.trials,
            avgDurationMs: s.avgDurationMs,
            p95DurationMs: s.p95DurationMs,
        }));
    }
    getTrackedTaskTypes() {
        return this.selector.getTrackedTaskTypes();
    }
    getStrategyScoresForModel(modelId) {
        return this.crossModel.getStrategyScoresForModel(modelId, this.perfTracker.getStrategyPerformance());
    }
    getPerModelStats() {
        return this.crossModel.getPerModelStats();
    }
    createPrediction(editId, description, targetStrategy, sourceStrategy, modelId, taskTypes, predictedFixes = [], predictedRegressions = []) {
        return this.predictionLoop.createPrediction(editId, description, targetStrategy, sourceStrategy, modelId, taskTypes, predictedFixes, predictedRegressions);
    }
    getPredictions() {
        return this.predictionLoop.getPredictions();
    }
    getVerdicts() {
        return this.predictionLoop.getVerdicts();
    }
    getRegressionEvents(limit = 20) {
        return this.regressionGate.getRegressionEvents(limit);
    }
    getStrategyPerformance() {
        return this.perfTracker.getStrategyPerformance();
    }
    getExperiences(taskType) {
        if (taskType) {
            return this.experiences.filter((e) => e.taskType === taskType);
        }
        return [...this.experiences];
    }
    getReflections(limit = 10) {
        return this.reflections.slice(-limit);
    }
    getSuggestions() {
        const modelPerformance = this.analyzeModelPerformance();
        const strategyRanking = this.perfTracker.rankStrategies();
        // Build per-model priors map for the suggestion engine
        const perModelPriors = new Map();
        for (const [modelId, modelMap] of this.crossModel.getPerModelPriors()) {
            const priorsMap = new Map();
            for (const [strategy, prior] of modelMap) {
                priorsMap.set(strategy, { mean: prior.mean, totalTrials: prior.totalTrials });
            }
            perModelPriors.set(modelId, priorsMap);
        }
        const context = {
            modelPerformance,
            strategyRanking,
            perModelPriors,
            regressionEvents: this.regressionGate.getRegressionEventsList(),
            reflections: this.reflections,
            minSamplesForSuggestion: this.minSamplesForSuggestion,
            enableCrossModelMemory: this.config.enableCrossModelMemory,
        };
        return (0, suggestionEngine_1.generateSuggestions)(context);
    }
    setConfig(partial) {
        this.config = { ...this.config, ...partial };
        this.predictionLoop = new predictionLoop_1.PredictionLoop(this.config.enablePredictionLoop);
        this.regressionGate = new regressionGate_1.RegressionGate(this.config.regressionThreshold);
        this.persist();
    }
    getConfig() {
        return { ...this.config };
    }
    getStats() {
        const strategies = Array.from(this.perfTracker.getStrategyPerformance().values());
        const avgSuccessRate = strategies.length > 0
            ? strategies.reduce((s, sp) => s + sp.successRate, 0) / strategies.length
            : 0;
        return {
            totalExperiences: this.experiences.length,
            trackedStrategies: strategies.length,
            avgSuccessRate,
            topStrategies: strategies.sort((a, b) => b.successRate - a.successRate).slice(0, 5),
            totalReflections: this.reflections.length,
        };
    }
    // ========================================================================
    // Private helpers
    // ========================================================================
    analyzeModelPerformance() {
        var _a;
        const modelMap = new Map();
        for (const exp of this.experiences) {
            const entry = (_a = modelMap.get(exp.modelUsed)) !== null && _a !== void 0 ? _a : {
                totalRuns: 0,
                successCount: 0,
                totalTokens: 0,
            };
            entry.totalRuns++;
            if (exp.success)
                entry.successCount++;
            entry.totalTokens += exp.tokenCost;
            modelMap.set(exp.modelUsed, entry);
        }
        const result = new Map();
        for (const [modelId, data] of modelMap) {
            result.set(modelId, {
                totalRuns: data.totalRuns,
                successRate: data.successCount / data.totalRuns,
                avgTokens: data.totalTokens / data.totalRuns,
            });
        }
        return result;
    }
    // ========================================================================
    // Persistence
    // ========================================================================
    persist() {
        const state = {
            experiences: this.experiences,
            reflections: this.reflections.slice(-200),
            strategyPerformance: this.perfTracker.getStrategyPerformance(),
            thompsonPriors: this.selector.getThompsonPriors(),
            predictions: this.predictionLoop.getPredictions(),
            verdicts: this.predictionLoop.getVerdicts(),
            regressionEvents: this.regressionGate.getRegressionEventsList(),
            successRateHistory: this.regressionGate.getSuccessRateHistory(),
            perModelPriors: this.crossModel.getPerModelPriors(),
            config: this.config,
        };
        (0, metaLearnerPersistence_1.persist)(state, this.persistPath);
    }
    load() {
        const state = {
            experiences: this.experiences,
            reflections: this.reflections,
            strategyPerformance: new Map(),
            thompsonPriors: new Map(),
            predictions: [],
            verdicts: [],
            regressionEvents: [],
            successRateHistory: new Map(),
            perModelPriors: new Map(),
            config: this.config,
        };
        (0, metaLearnerPersistence_1.load)(state, this.persistPath);
        // Sync loaded state into sub-modules
        this.experiences = state.experiences;
        this.reflections = state.reflections;
        this.config = state.config;
        this.perfTracker.setStrategyPerformance(state.strategyPerformance);
        this.selector.setThompsonPriors(state.thompsonPriors);
        this.predictionLoop.setPredictions(state.predictions);
        this.predictionLoop.setVerdicts(state.verdicts);
        this.regressionGate.setRegressionEvents(state.regressionEvents);
        this.regressionGate.setSuccessRateHistory(state.successRateHistory);
        this.crossModel.setPerModelPriors(state.perModelPriors);
    }
}
exports.MetaLearner = MetaLearner;
// ============================================================================
// Singleton helpers
// ============================================================================
let _metaLearnerPath;
const metaLearnerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new MetaLearner(500, 5, _metaLearnerPath !== null && _metaLearnerPath !== void 0 ? _metaLearnerPath : nodePath.join(process.cwd(), '.commander_memory', 'meta-learner.json')));
function getMetaLearner(persistPath) {
    if (persistPath)
        _metaLearnerPath = persistPath;
    return metaLearnerSingleton.get();
}
function resetMetaLearner() {
    metaLearnerSingleton.reset();
}
function clearMetaLearnerState() {
    var _a, _b, _c, _d;
    const learner = metaLearnerSingleton.getGlobal();
    learner['experiences'] = [];
    learner['reflections'] = [];
    learner['shadowComparisons'] = [];
    learner['perfTracker'] = new strategyPerformanceTracker_1.StrategyPerformanceTracker();
    learner['selector'] = new strategySelector_1.StrategySelector();
    learner['crossModel'] = new crossModelMemory_1.CrossModelMemory();
    learner['predictionLoop'] = new predictionLoop_1.PredictionLoop((_b = (_a = learner['config']) === null || _a === void 0 ? void 0 : _a.enablePredictionLoop) !== null && _b !== void 0 ? _b : true);
    learner['regressionGate'] = new regressionGate_1.RegressionGate((_d = (_c = learner['config']) === null || _c === void 0 ? void 0 : _c.regressionThreshold) !== null && _d !== void 0 ? _d : 0.15);
}
var strategyConstants_2 = require("./strategyConstants");
Object.defineProperty(exports, "DEFAULT_META_LEARNER_CONFIG", { enumerable: true, get: function () { return strategyConstants_2.DEFAULT_META_LEARNER_CONFIG; } });
