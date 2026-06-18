"use strict";
/**
 * Consensus Check
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 关键决策需要多模型共识
 * - 收集多个模型的独立判断
 * - 分析一致性程度
 * - 低共识时触发讨论或重新评估
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConsensusChecker = void 0;
exports.getGlobalConsensusChecker = getGlobalConsensusChecker;
exports.createConsensusChecker = createConsensusChecker;
exports.resetConsensusChecker = resetConsensusChecker;
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
// ========================================
// Default Configuration
// ========================================
const DEFAULT_CONFIG = {
    minVoters: 3,
    agreementThreshold: 0.8,
    strongAgreementThreshold: 0.95,
    lowConsensusThreshold: 0.5,
    timeoutMs: 30000,
    enableDiscussion: true,
};
// ========================================
// Consensus Check Implementation
// ========================================
class ConsensusChecker {
    constructor(config) {
        this.checks = new Map();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * 创建共识检查
     */
    createCheck(question, context = '') {
        // Auto-prune stale checks to prevent unbounded growth in long sessions
        if (this.checks.size > 50)
            this.clearOldChecks();
        const check = {
            id: generateUUID(),
            question,
            context,
            votes: [],
            consensusLevel: 'low',
            consensusScore: 0,
            requiresDiscussion: false,
            createdAt: new Date().toISOString(),
        };
        this.checks.set(check.id, check);
        return check.id;
    }
    /**
     * 添加投票
     */
    addVote(checkId, modelId, modelName, decision, confidence, reasoning) {
        const check = this.checks.get(checkId);
        if (!check)
            return false;
        // Dedup: replace existing vote from same model
        const existingIdx = check.votes.findIndex((v) => v.modelId === modelId);
        if (existingIdx >= 0) {
            check.votes[existingIdx] = {
                modelId,
                modelName,
                decision,
                confidence,
                reasoning,
                timestamp: new Date().toISOString(),
            };
            this.updateConsensus(check);
            return true;
        }
        const vote = {
            modelId,
            modelName,
            decision,
            confidence,
            reasoning,
            timestamp: new Date().toISOString(),
        };
        check.votes.push(vote);
        this.updateConsensus(check);
        return true;
    }
    /**
     * 更新共识状态
     */
    updateConsensus(check) {
        // 计算共识分数（即使投票数不足也计算，但标记为低置信度）
        const scores = this.calculateConsensusScores(check.votes);
        check.consensusScore = scores.overall;
        check.isLowConfidence = check.votes.length < this.config.minVoters;
        // 确定共识级别
        if (scores.overall >= this.config.strongAgreementThreshold) {
            check.consensusLevel = 'unanimous';
        }
        else if (scores.overall >= this.config.agreementThreshold) {
            check.consensusLevel = 'strong';
        }
        else if (scores.overall >= this.config.lowConsensusThreshold) {
            check.consensusLevel = 'moderate';
        }
        else if (scores.overall > 0) {
            check.consensusLevel = 'low';
        }
        else {
            check.consensusLevel = 'diverged';
        }
        // 生成共识决策
        if (scores.overall >= this.config.lowConsensusThreshold) {
            check.agreedDecision = this.selectAgreedDecision(check.votes, scores);
        }
        // 生成分歧摘要
        if (scores.overall < this.config.agreementThreshold) {
            check.disagreementSummary = this.summarizeDisagreements(check.votes);
            check.requiresDiscussion = this.config.enableDiscussion;
        }
        else {
            check.requiresDiscussion = false;
        }
    }
    /**
     * 计算共识分数
     */
    calculateConsensusScores(votes) {
        if (votes.length < 2) {
            return { overall: 0, byModel: new Map() };
        }
        // 简单的文本相似度计算
        const decisions = votes.map((v) => v.decision.toLowerCase().trim());
        const agreements = [];
        // 两两比较
        for (let i = 0; i < decisions.length; i++) {
            for (let j = i + 1; j < decisions.length; j++) {
                agreements.push(this.calculateSimilarity(decisions[i], decisions[j]));
            }
        }
        // 加权平均 (confidence 作为权重)
        const avgSimilarity = agreements.length > 0 ? agreements.reduce((a, b) => a + b, 0) / agreements.length : 1.0;
        let weightedSum = 0;
        let weightTotal = 0;
        for (const vote of votes) {
            weightedSum += vote.confidence * vote.confidence;
            weightTotal += vote.confidence;
        }
        const avgConfidence = weightTotal > 0 ? weightedSum / weightTotal : 0;
        // 综合分数: 相似度 * 0.7 + 置信度 * 0.3
        const overall = avgSimilarity * 0.7 + avgConfidence * 0.3;
        const byModel = new Map();
        for (const vote of votes) {
            byModel.set(vote.modelId, vote.confidence);
        }
        return { overall, byModel };
    }
    /**
     * 计算文本相似度
     */
    calculateSimilarity(text1, text2) {
        if (text1 === text2)
            return 1;
        if (text1.length === 0 || text2.length === 0)
            return 0;
        // 简单的词集合相似度 (Jaccard)
        const words1 = new Set(text1.split(/\s+/));
        const words2 = new Set(text2.split(/\s+/));
        const intersection = new Set([...words1].filter((x) => words2.has(x)));
        const union = new Set([...words1, ...words2]);
        return intersection.size / union.size;
    }
    /**
     * 选择共同决策
     */
    selectAgreedDecision(votes, scores) {
        var _a, _b;
        // 多数投票：按决策分组，票数相同则比较总置信度
        const decisionCounts = new Map();
        for (const vote of votes) {
            const entry = decisionCounts.get(vote.decision) || { count: 0, totalConfidence: 0 };
            entry.count++;
            entry.totalConfidence += vote.confidence;
            decisionCounts.set(vote.decision, entry);
        }
        let best = { decision: (_b = (_a = votes[0]) === null || _a === void 0 ? void 0 : _a.decision) !== null && _b !== void 0 ? _b : 'no consensus', count: 0, totalConfidence: 0 };
        for (const [decision, entry] of decisionCounts) {
            if (entry.count > best.count ||
                (entry.count === best.count && entry.totalConfidence > best.totalConfidence)) {
                best = { decision, count: entry.count, totalConfidence: entry.totalConfidence };
            }
        }
        return best.decision;
    }
    /**
     * 总结分歧
     */
    summarizeDisagreements(votes) {
        const disagreements = [];
        for (const vote of votes) {
            disagreements.push(`[${vote.modelName}] ${vote.decision}: ${vote.reasoning}`);
        }
        return disagreements.join('\n---\n');
    }
    /**
     * 完成检查
     */
    completeCheck(checkId) {
        const check = this.checks.get(checkId);
        if (check) {
            check.completedAt = new Date().toISOString();
        }
        return check;
    }
    /**
     * 获取检查结果
     */
    getCheck(checkId) {
        return this.checks.get(checkId);
    }
    /**
     * 获取共识结果 (用于决策)
     */
    getResult(checkId) {
        const check = this.checks.get(checkId);
        if (!check)
            return undefined;
        const result = {
            decision: check.agreedDecision || (check.votes.length > 0 ? check.votes[0].decision : 'no consensus'),
            consensusLevel: check.consensusLevel,
            consensusScore: check.consensusScore,
            confidence: this.scoreToConfidence(check.consensusScore),
            requiresAction: true,
            actionType: this.determineAction(check),
        };
        return result;
    }
    /**
     * 分数转置信度
     */
    scoreToConfidence(score) {
        if (score >= 0.8)
            return 'high';
        if (score >= 0.5)
            return 'medium';
        return 'low';
    }
    /**
     * 确定需要采取的行动
     */
    determineAction(check) {
        if (check.consensusLevel === 'unanimous' || check.consensusLevel === 'strong') {
            return 'proceed';
        }
        if (check.consensusLevel === 'moderate') {
            return 'discuss';
        }
        if (check.consensusLevel === 'low') {
            return 'rethink';
        }
        return 'escalate';
    }
    /**
     * 等待足够投票
     */
    async waitForVotes(checkId) {
        const startTime = Date.now();
        while (Date.now() - startTime < this.config.timeoutMs) {
            const check = this.checks.get(checkId);
            if (check && check.votes.length >= this.config.minVoters) {
                return check;
            }
            await new Promise((resolve) => {
                const t = setTimeout(resolve, 100);
                t.unref();
            });
        }
        return null; // 超时
    }
    /**
     * 获取统计信息
     */
    getStats() {
        const checks = Array.from(this.checks.values());
        const completed = checks.filter((c) => c.completedAt);
        const avgScore = completed.length > 0
            ? completed.reduce((sum, c) => sum + c.consensusScore, 0) / completed.length
            : 0;
        const byLevel = {
            unanimous: 0,
            strong: 0,
            moderate: 0,
            low: 0,
            diverged: 0,
        };
        for (const check of completed) {
            byLevel[check.consensusLevel]++;
        }
        return {
            totalChecks: checks.length,
            completedChecks: completed.length,
            averageConsensusScore: avgScore,
            byLevel,
        };
    }
    /**
     * 清除旧检查
     */
    clearOldChecks(olderThanMs = 3600000) {
        const threshold = Date.now() - olderThanMs;
        let removed = 0;
        for (const [id, check] of this.checks.entries()) {
            const created = new Date(check.createdAt).getTime();
            if (created < threshold) {
                this.checks.delete(id);
                removed++;
            }
        }
        return removed;
    }
    /**
     * 生成报告
     */
    generateReport(checkId) {
        const check = this.checks.get(checkId);
        if (!check)
            return 'Check not found';
        const result = this.getResult(checkId);
        const lines = [
            `# Consensus Check Report`,
            ``,
            `**Question**: ${check.question}`,
            `**Context**: ${check.context || 'N/A'}`,
            `**Created**: ${check.createdAt}`,
            `**Completed**: ${check.completedAt || 'In progress'}`,
            ``,
            `## Consensus Result`,
            `**Level**: ${check.consensusLevel}`,
            `**Score**: ${(check.consensusScore * 100).toFixed(1)}%`,
            `**Decision**: ${(result === null || result === void 0 ? void 0 : result.decision) || 'Pending'}`,
            `**Confidence**: ${(result === null || result === void 0 ? void 0 : result.confidence) || 'N/A'}`,
            `**Action**: ${(result === null || result === void 0 ? void 0 : result.actionType) || 'N/A'}`,
            ``,
            `## Votes`,
        ];
        for (const vote of check.votes) {
            lines.push(``);
            lines.push(`### ${vote.modelName}`);
            lines.push(`**Decision**: ${vote.decision}`);
            lines.push(`**Confidence**: ${(vote.confidence * 100).toFixed(0)}%`);
            lines.push(`**Reasoning**: ${vote.reasoning}`);
        }
        if (check.disagreementSummary) {
            lines.push(``);
            lines.push(`## Disagreements`);
            lines.push(check.disagreementSummary);
        }
        return lines.join('\n');
    }
}
exports.ConsensusChecker = ConsensusChecker;
// ========================================
// Factory
// ========================================
const tenantAwareSingleton_1 = require("./runtime/tenantAwareSingleton");
const consensusCheckerSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ConsensusChecker());
function getGlobalConsensusChecker() {
    return consensusCheckerSingleton.get();
}
function createConsensusChecker(config) {
    return new ConsensusChecker(config);
}
function resetConsensusChecker() {
    consensusCheckerSingleton.reset();
}
