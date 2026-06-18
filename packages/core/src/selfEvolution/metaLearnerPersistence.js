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
exports.persist = persist;
exports.load = load;
const fs = __importStar(require("fs"));
const nodePath = __importStar(require("path"));
const logging_1 = require("../logging");
const betaDistribution_1 = require("./betaDistribution");
function persist(state, persistPath) {
    if (!persistPath)
        return;
    try {
        const dir = nodePath.dirname(persistPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        // Serialize Thompson priors (Beta distributions as alpha/beta pairs)
        const serializedPriors = {};
        for (const [taskType, distributions] of state.thompsonPriors) {
            serializedPriors[taskType] = distributions.map((d) => ({ alpha: d.alpha, beta: d.beta }));
        }
        // Serialize cross-model priors
        const serializedCrossModel = {};
        for (const [modelId, modelMap] of state.perModelPriors) {
            serializedCrossModel[modelId] = {};
            for (const [strategy, dist] of modelMap) {
                serializedCrossModel[modelId][strategy] = { alpha: dist.alpha, beta: dist.beta };
            }
        }
        const data = {
            experiences: state.experiences,
            reflections: state.reflections.slice(-200),
            strategyPerformance: Array.from(state.strategyPerformance.entries()),
            thompsonPriors: serializedPriors,
            predictions: state.predictions,
            verdicts: state.verdicts,
            regressionEvents: state.regressionEvents,
            successRateHistory: Array.from(state.successRateHistory.entries()),
            crossModelPriors: serializedCrossModel,
            config: state.config,
        };
        const tmpPath = persistPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmpPath, persistPath);
    }
    catch (e) {
        (0, logging_1.getGlobalLogger)().warn('MetaLearner', 'Persistence failed (best-effort)', {
            error: e === null || e === void 0 ? void 0 : e.message,
        });
    }
}
function load(state, persistPath) {
    if (!persistPath)
        return;
    try {
        if (!fs.existsSync(persistPath))
            return;
        const raw = fs.readFileSync(persistPath, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.experiences))
            state.experiences = data.experiences;
        if (Array.isArray(data.reflections))
            state.reflections = data.reflections;
        if (Array.isArray(data.strategyPerformance)) {
            for (const [key, val] of data.strategyPerformance) {
                state.strategyPerformance.set(key, val);
            }
        }
        if (data.thompsonPriors && typeof data.thompsonPriors === 'object') {
            for (const [taskType, dists] of Object.entries(data.thompsonPriors)) {
                const priors = dists.map((d) => new betaDistribution_1.BetaDistribution(d.alpha, d.beta));
                state.thompsonPriors.set(taskType, priors);
            }
        }
        // Restore cross-model priors
        if (data.crossModelPriors && typeof data.crossModelPriors === 'object') {
            for (const [modelId, strategies] of Object.entries(data.crossModelPriors)) {
                const modelMap = new Map();
                for (const [strategy, d] of Object.entries(strategies)) {
                    modelMap.set(strategy, new betaDistribution_1.BetaDistribution(d.alpha, d.beta));
                }
                state.perModelPriors.set(modelId, modelMap);
            }
        }
        if (Array.isArray(data.predictions))
            state.predictions = data.predictions;
        if (Array.isArray(data.verdicts))
            state.verdicts = data.verdicts;
        if (Array.isArray(data.regressionEvents))
            state.regressionEvents = data.regressionEvents;
        if (Array.isArray(data.successRateHistory)) {
            for (const [key, vals] of data.successRateHistory) {
                state.successRateHistory.set(key, vals);
            }
        }
        if (data.config && typeof data.config === 'object') {
            state.config = { ...state.config, ...data.config };
        }
    }
    catch (e) {
        (0, logging_1.getGlobalLogger)().warn('MetaLearner', 'Load failed (best-effort)', {
            error: e === null || e === void 0 ? void 0 : e.message,
        });
    }
}
