"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TELOS_CONFIG = void 0;
exports.DEFAULT_TELOS_CONFIG = {
    defaultBudget: {
        hardCapTokens: 200000, // Raised from 64K — most tasks need more headroom
        softCapTokens: 150000, // Warn at 75% of hard cap
        costCapUsd: 5.0, // Raised from $2 — allow more complex tasks
    },
    maxRetries: 2,
    retryDelayMs: 2000,
    enableStreaming: true,
    enableCostTracking: true,
    enableBudgetEnforcement: true,
    monthlyCostLimitUsd: 50.0,
};
