"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_META_LEARNER_CONFIG = exports.STRATEGY_NAMES = void 0;
exports.STRATEGY_NAMES = ['SEQUENTIAL', 'PARALLEL', 'HANDOFF', 'MAGENTIC', 'CONSENSUS'];
exports.DEFAULT_META_LEARNER_CONFIG = {
    analysisMode: 'light',
    enablePredictionLoop: true,
    enableRegressionGate: true,
    enableCrossModelMemory: true,
    regressionThreshold: 0.15,
};
