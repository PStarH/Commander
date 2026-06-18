"use strict";
/**
 * Token Budget Allocator
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 根据任务复杂度智能分配 token 预算
 * - 阶段化预算分配
 * - 实时预算监控
 * - 超预算自动截断
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenBudgetAllocator = void 0;
exports.getGlobalBudgetAllocator = getGlobalBudgetAllocator;
exports.createBudgetAllocator = createBudgetAllocator;
exports.resetBudgetAllocator = resetBudgetAllocator;
// ========================================
// Budget Allocator
// ========================================
class TokenBudgetAllocator {
    constructor(config) {
        var _a, _b, _c, _d, _e, _f;
        this.usedBudget = 0;
        this.agentBudgets = new Map();
        this.agentUsage = new Map();
        this.phaseAllocations = new Map();
        this.history = [];
        this.config = {
            baseBudget: (_a = config === null || config === void 0 ? void 0 : config.baseBudget) !== null && _a !== void 0 ? _a : 100000,
            maxBudget: (_b = config === null || config === void 0 ? void 0 : config.maxBudget) !== null && _b !== void 0 ? _b : 500000,
            efficiencyTarget: (_c = config === null || config === void 0 ? void 0 : config.efficiencyTarget) !== null && _c !== void 0 ? _c : 0.85,
            reserveRatio: (_d = config === null || config === void 0 ? void 0 : config.reserveRatio) !== null && _d !== void 0 ? _d : 0.1,
            warnThreshold: (_e = config === null || config === void 0 ? void 0 : config.warnThreshold) !== null && _e !== void 0 ? _e : 0.8,
            cutoffThreshold: (_f = config === null || config === void 0 ? void 0 : config.cutoffThreshold) !== null && _f !== void 0 ? _f : 0.95,
        };
        this.totalBudget = this.config.baseBudget;
    }
    /**
     * 初始化预算
     */
    initialize(totalBudget) {
        this.totalBudget = Math.min(totalBudget, this.config.maxBudget);
        this.usedBudget = 0;
        this.agentBudgets.clear();
        this.phaseAllocations.clear();
        this.agentUsage.clear();
    }
    /**
     * 根据编排模式和任务复杂度分配预算
     */
    allocate(mode, complexity, agentCount) {
        // 根据复杂度调整基础预算
        const complexityMultiplier = 1 + (complexity / 100) * 2; // 1x - 3x
        let baseBudget = this.totalBudget * complexityMultiplier;
        // 根据模式调整分配比例
        const ratios = this.getAllocationRatios(mode);
        // 计算各部分预算 (subtract reserve first to avoid over-allocation)
        const allocatableBudget = baseBudget * (1 - this.config.reserveRatio);
        const leadAgent = Math.floor(allocatableBudget * ratios.lead);
        const specialistAgents = Math.floor(allocatableBudget * ratios.specialists);
        const evaluation = Math.floor(allocatableBudget * ratios.evaluation);
        const overhead = Math.floor(allocatableBudget * ratios.overhead);
        const reserved = Math.floor(baseBudget * this.config.reserveRatio);
        const budget = {
            total: baseBudget,
            leadAgent,
            specialistAgents,
            evaluation,
            overhead,
            reserved,
        };
        // 分配给各 agent
        this.distributeToAgents(budget, agentCount);
        // 记录阶段分配
        this.initializePhaseAllocations(budget);
        return budget;
    }
    /**
     * 获取各部分分配比例
     */
    getAllocationRatios(mode) {
        switch (mode) {
            case 'SEQUENTIAL':
                return { lead: 0.7, specialists: 0.1, evaluation: 0.15, overhead: 0.05 };
            case 'PARALLEL':
                return { lead: 0.25, specialists: 0.55, evaluation: 0.15, overhead: 0.05 };
            case 'HANDOFF':
                return { lead: 0.35, specialists: 0.45, evaluation: 0.15, overhead: 0.05 };
            case 'MAGENTIC':
                return { lead: 0.3, specialists: 0.4, evaluation: 0.15, overhead: 0.15 };
            case 'CONSENSUS':
                return { lead: 0.25, specialists: 0.3, evaluation: 0.4, overhead: 0.05 };
            default:
                return { lead: 0.4, specialists: 0.4, evaluation: 0.15, overhead: 0.05 };
        }
    }
    /**
     * 分配预算给各 agent
     */
    distributeToAgents(budget, agentCount) {
        this.agentBudgets.clear();
        if (agentCount === 0)
            return;
        // Lead agent
        this.agentBudgets.set('lead', budget.leadAgent);
        // Specialist agents
        const perSpecialist = Math.floor(budget.specialistAgents / Math.max(1, agentCount - 1));
        for (let i = 0; i < agentCount - 1; i++) {
            this.agentBudgets.set(`specialist-${i}`, perSpecialist);
        }
    }
    /**
     * 初始化阶段分配
     */
    initializePhaseAllocations(budget) {
        const phases = [
            'planning',
            'execution',
            'evaluation',
            'reporting',
        ];
        const phaseRatios = {
            planning: 0.1,
            execution: 0.6,
            evaluation: 0.2,
            reporting: 0.1,
        };
        for (const phase of phases) {
            this.phaseAllocations.set(phase, {
                phase,
                allocated: Math.floor(budget.total * phaseRatios[phase]),
                used: 0,
                remaining: Math.floor(budget.total * phaseRatios[phase]),
                efficiency: 1.0,
            });
        }
    }
    /**
     * 记录 token 使用
     */
    recordUsage(agentId, tokens, phase) {
        this.usedBudget += tokens;
        // 更新 agent 使用 (tracked separately from allocation)
        const currentUsage = this.agentUsage.get(agentId) || 0;
        this.agentUsage.set(agentId, currentUsage + tokens);
        // 更新阶段使用
        if (phase) {
            const phaseAlloc = this.phaseAllocations.get(phase);
            if (phaseAlloc) {
                phaseAlloc.used += tokens;
                phaseAlloc.remaining = Math.max(0, phaseAlloc.allocated - phaseAlloc.used);
                phaseAlloc.efficiency = phaseAlloc.used / phaseAlloc.allocated;
            }
        }
        // 记录历史
        this.recordSnapshot();
    }
    /**
     * 获取剩余预算
     */
    getRemaining() {
        return Math.max(0, this.totalBudget - this.usedBudget);
    }
    /**
     * 获取使用率
     */
    getUsageRate() {
        return this.totalBudget > 0 ? this.usedBudget / this.totalBudget : 0;
    }
    /**
     * 检查是否超过阈值
     */
    isWarningThreshold() {
        return this.getUsageRate() >= this.config.warnThreshold;
    }
    isCutoffThreshold() {
        return this.getUsageRate() >= this.config.cutoffThreshold;
    }
    /**
     * 获取 agent 剩余预算
     */
    getAgentRemaining(agentId) {
        const allocated = this.agentBudgets.get(agentId) || 0;
        const used = this.agentUsage.get(agentId) || 0;
        return Math.max(0, allocated - used);
    }
    /**
     * 获取预算警告
     */
    getWarnings() {
        const warnings = [];
        const usageRate = this.getUsageRate();
        if (usageRate >= this.config.cutoffThreshold) {
            warnings.push('CRITICAL: Budget almost exhausted!');
        }
        else if (usageRate >= this.config.warnThreshold) {
            warnings.push('WARNING: Budget usage high');
        }
        // 检查效率
        for (const [, phase] of this.phaseAllocations) {
            if (phase.efficiency > 1) {
                warnings.push(`Phase ${phase.phase} exceeded allocated budget`);
            }
        }
        return warnings;
    }
    /**
     * 获取快照
     */
    getSnapshot() {
        return {
            timestamp: new Date().toISOString(),
            totalBudget: this.totalBudget,
            totalUsed: this.usedBudget,
            totalRemaining: this.getRemaining(),
            byPhase: Array.from(this.phaseAllocations.values()),
            byAgent: new Map(this.agentBudgets),
        };
    }
    /**
     * 记录历史快照
     */
    recordSnapshot() {
        const snapshot = this.getSnapshot();
        this.history.push(snapshot);
        // 保持最近 100 条记录
        if (this.history.length > 100) {
            this.history.shift();
        }
    }
    /**
     * 获取效率分析
     */
    getEfficiencyAnalysis() {
        const phases = Array.from(this.phaseAllocations.values());
        const phaseEfficiency = {};
        for (const phase of phases) {
            phaseEfficiency[phase.phase] = phase.efficiency;
        }
        const overall = phases.length > 0 ? phases.reduce((sum, p) => sum + p.efficiency, 0) / phases.length : 0;
        // 计算趋势
        let trend = 'stable';
        if (this.history.length >= 10) {
            const recent = this.history.slice(-5);
            const older = this.history.slice(-10, -5);
            const recentAvg = recent.reduce((sum, s) => sum + s.totalUsed, 0) / recent.length;
            const olderAvg = older.reduce((sum, s) => sum + s.totalUsed, 0) / older.length;
            if (recentAvg < olderAvg * 0.9)
                trend = 'improving';
            else if (recentAvg > olderAvg * 1.1)
                trend = 'declining';
        }
        // 生成建议
        const recommendations = [];
        if (overall > 0.9) {
            recommendations.push('Consider increasing budget for better results');
        }
        else if (overall < 0.5) {
            recommendations.push('Budget underutilized, consider reducing allocation');
        }
        if (trend === 'declining') {
            recommendations.push('Token efficiency decreasing, review agent prompts');
        }
        return { overall, byPhase: phaseEfficiency, trend, recommendations };
    }
    /**
     * 重置分配器
     */
    reset() {
        this.usedBudget = 0;
        this.agentBudgets.clear();
        this.phaseAllocations.clear();
        this.agentUsage.clear();
        this.history = [];
    }
    /**
     * 获取配置
     */
    getConfig() {
        return { ...this.config };
    }
}
exports.TokenBudgetAllocator = TokenBudgetAllocator;
// ========================================
// Factory
// ========================================
const tenantAwareSingleton_1 = require("./runtime/tenantAwareSingleton");
const budgetAllocatorSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new TokenBudgetAllocator());
function getGlobalBudgetAllocator() {
    return budgetAllocatorSingleton.get();
}
function createBudgetAllocator(config) {
    return new TokenBudgetAllocator(config);
}
function resetBudgetAllocator() {
    budgetAllocatorSingleton.reset();
}
