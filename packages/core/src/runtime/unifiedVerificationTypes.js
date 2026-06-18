"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_UVP_CONFIG = void 0;
exports.DEFAULT_UVP_CONFIG = {
    enabled: true,
    confidenceSkipThreshold: 0.85,
    budgetFloorTokens: 2000,
    llmVerificationBudget: 300,
    enableLearning: true,
    judgeGate: {
        enabled: true,
        triggerConfidence: 0.85,
        passThreshold: 0.8,
        tokenBudget: 800,
    },
};
