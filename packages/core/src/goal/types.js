"use strict";
/**
 * Goal Module — 多 Agent 目标驱动执行
 *
 * Phase 1 of the drive/swarm roadmap:
 * manager agent decomposes → worker agents execute → critic agent reviews → loop
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_GOAL_CONFIG = void 0;
exports.DEFAULT_GOAL_CONFIG = {
    maxRounds: 10,
    budgetTokens: 500000,
    mode: 'balanced',
    model: 'gpt-4o-mini',
};
