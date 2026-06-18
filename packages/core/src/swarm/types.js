"use strict";
/**
 * Swarm Module — 递归分解 + 子 Manager 自裂变 + Fusion 冲突检测
 *
 * Phase 2 of the drive/swarm roadmap:
 * Manager spawns child managers for complex sub-goals,
 * Fusion engine detects cross-worker conflicts,
 * Fission decisions based on goal complexity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SWARM_CONFIG = void 0;
exports.DEFAULT_SWARM_CONFIG = {
    goalConfig: {},
    maxDepth: 3,
    maxWorkers: 10,
    fissionThreshold: 5,
    enableWorkerTools: false,
};
