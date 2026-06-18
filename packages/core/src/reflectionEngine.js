"use strict";
/**
 * Reflection Engine
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 让 agent 在执行后反思自己的行为
 * - 自我评估: 哪里做得好/不好
 * - 模式识别: 发现反复出现的问题
 * - 策略调整: 基于历史调整行为
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReflectionEngine = void 0;
exports.getGlobalReflectionEngine = getGlobalReflectionEngine;
exports.createReflectionEngine = createReflectionEngine;
exports.resetReflectionEngine = resetReflectionEngine;
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
// ========================================
// Reflection Engine
// ========================================
class ReflectionEngine {
    constructor() {
        this.sessions = new Map();
        this.patterns = new Map();
        this.reflectionHistory = [];
        // 配置
        this.MIN_QUALITY_THRESHOLD = 0.5;
        this.PATTERN_SIMILARITY_THRESHOLD = 0.8;
        this.MAX_PATTERNS = 50;
        // GAP-19: Bound session and history growth
        this.MAX_SESSIONS = 500;
        this.MAX_HISTORY = 2000;
    }
    /**
     * 开始反思会话
     */
    startSession(taskId) {
        // GAP-19: Evict oldest sessions when over limit
        if (this.sessions.size >= this.MAX_SESSIONS) {
            const sorted = Array.from(this.sessions.entries()).sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
            const toEvict = Math.max(1, Math.floor(this.MAX_SESSIONS * 0.1));
            for (let i = 0; i < toEvict && i < sorted.length; i++) {
                this.sessions.delete(sorted[i][0]);
            }
        }
        const session = {
            id: generateUUID(),
            taskId,
            reflections: [],
            overallQuality: 0,
            keyInsight: '',
            createdAt: new Date().toISOString(),
        };
        this.sessions.set(session.id, session);
        return session.id;
    }
    /**
     * 添加反思
     */
    addReflection(sessionId, context, question, answer) {
        const reflection = {
            id: generateUUID(),
            type: this.determineType(context),
            context,
            question,
            answer,
            quality: 0,
            actionable: false,
            insights: [],
            recommendations: [],
            createdAt: new Date().toISOString(),
        };
        // 如果有答案，进行分析
        if (answer) {
            const analysis = this.analyzeReflection(reflection);
            reflection.quality = analysis.quality;
            reflection.actionable = analysis.actionable;
            reflection.insights = analysis.insights;
            reflection.recommendations = analysis.recommendations;
        }
        const session = this.sessions.get(sessionId);
        if (session) {
            session.reflections.push(reflection);
            this.updateSessionQuality(session);
        }
        // GAP-19: Trim history when over limit
        if (this.reflectionHistory.length >= this.MAX_HISTORY) {
            this.reflectionHistory = this.reflectionHistory.slice(-Math.floor(this.MAX_HISTORY * 0.8));
        }
        this.reflectionHistory.push(reflection);
        this.detectPatterns(reflection);
        return reflection;
    }
    /**
     * 确定反思类型
     */
    determineType(context) {
        const lower = context.toLowerCase();
        if (lower.includes('error') || lower.includes('fail') || lower.includes('exception')) {
            return 'error_analysis';
        }
        if (lower.includes('plan') || lower.includes('before') || lower.includes('anticipat')) {
            return 'pre_planning';
        }
        if (lower.includes('pattern') || lower.includes('repeat') || lower.includes('again')) {
            return 'pattern_detection';
        }
        return 'post_execution';
    }
    /**
     * 分析反思内容
     */
    analyzeReflection(reflection) {
        const insights = [];
        const recommendations = [];
        let qualityScore = 0.5;
        const answer = reflection.answer || '';
        const lower = answer.toLowerCase();
        // 检测洞察
        if (lower.includes('should') || lower.includes('need to') || lower.includes('could')) {
            insights.push('Identified improvement opportunity');
            qualityScore += 0.1;
        }
        if (lower.includes('because') || lower.includes('reason')) {
            insights.push('Provided causal explanation');
            qualityScore += 0.1;
        }
        if (lower.includes('success') || lower.includes('worked well')) {
            insights.push('Recognized successful approach');
            qualityScore += 0.1;
        }
        if (lower.includes('learned') || lower.includes('discovered')) {
            insights.push('Extracted learning');
            qualityScore += 0.1;
        }
        // 生成建议
        if (lower.includes('better') || lower.includes('improve')) {
            recommendations.push('Consider alternative approach');
        }
        if (lower.includes('check') || lower.includes('verify')) {
            recommendations.push('Add validation step');
        }
        if (lower.includes('avoid') || lower.includes("shouldn't")) {
            recommendations.push('Create guard rail to prevent recurrence');
        }
        if (lower.includes('retry') || lower.includes('again')) {
            recommendations.push('Implement retry mechanism');
        }
        // 提取数字质量分数（如 "Quality score: 0.75"）
        const numericMatch = answer.match(/(\d+\.?\d*)/);
        if (numericMatch) {
            const extracted = parseFloat(numericMatch[1]);
            if (extracted > 0 && extracted <= 1) {
                qualityScore = Math.max(qualityScore, extracted);
            }
        }
        // 检查可执行性
        const actionable = recommendations.length > 0 &&
            recommendations.some((r) => r.length > 10 && (r.includes('Add') || r.includes('Implement') || r.includes('Create')));
        return {
            quality: Math.min(1, qualityScore),
            actionable,
            insights,
            recommendations,
        };
    }
    /**
     * 更新会话质量
     */
    updateSessionQuality(session) {
        if (session.reflections.length === 0)
            return;
        const avgQuality = session.reflections.reduce((sum, r) => sum + r.quality, 0) / session.reflections.length;
        session.overallQuality = avgQuality;
        // 更新关键洞察
        const highQualityReflections = session.reflections
            .filter((r) => r.quality >= this.MIN_QUALITY_THRESHOLD)
            .sort((a, b) => b.quality - a.quality);
        if (highQualityReflections.length > 0) {
            session.keyInsight =
                highQualityReflections[0].insights[0] ||
                    highQualityReflections[0].recommendations[0] ||
                    'Review completed';
        }
    }
    /**
     * 完成会话
     */
    completeSession(sessionId, outcome) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.completedAt = new Date().toISOString();
            // 更新所有反思的结果
            session.reflections.forEach((r) => {
                r.relatedOutcome = outcome;
            });
        }
    }
    /**
     * 检测模式
     */
    detectPatterns(reflection) {
        const content = `${reflection.question} ${reflection.answer || ''}`.toLowerCase();
        // 简单的模式检测 - 检查关键词组合
        const patterns = [
            { keywords: ['timeout', 'slow'], pattern: 'Performance timeout issue' },
            { keywords: ['error', 'fail'], pattern: 'Execution error pattern' },
            { keywords: ['memory', 'leak'], pattern: 'Memory management issue' },
            { keywords: ['repeat', 'again'], pattern: 'Repetitive failure pattern' },
            { keywords: ['missing', 'none'], pattern: 'Missing data issue' },
        ];
        for (const p of patterns) {
            const matchCount = p.keywords.filter((k) => content.includes(k)).length;
            // 单关键词匹配时也触发（降低检测门槛）
            if (matchCount >= 1) {
                const existing = this.patterns.get(p.pattern);
                if (existing) {
                    existing.frequency++;
                    existing.lastSeen = new Date().toISOString();
                    // 如果有解决方案，更新它
                    if (reflection.recommendations.length > 0) {
                        existing.resolution = reflection.recommendations[0];
                    }
                }
                else {
                    const newPattern = {
                        id: generateUUID(),
                        pattern: p.pattern,
                        frequency: 1,
                        severity: this.calculateSeverity(p.pattern, reflection),
                        firstSeen: new Date().toISOString(),
                        lastSeen: new Date().toISOString(),
                        resolution: reflection.recommendations[0],
                    };
                    this.patterns.set(p.pattern, newPattern);
                }
            }
        }
        // 限制模式数量
        if (this.patterns.size > this.MAX_PATTERNS) {
            this.prunePatterns();
        }
    }
    /**
     * 计算严重程度
     */
    calculateSeverity(pattern, reflection) {
        let severity = 0.5;
        if (reflection.type === 'error_analysis')
            severity += 0.2;
        if (reflection.relatedOutcome === 'failure')
            severity += 0.2;
        if (reflection.quality < 0.5)
            severity += 0.1;
        return Math.min(1, severity);
    }
    /**
     * 修剪低频模式
     */
    prunePatterns() {
        const sorted = Array.from(this.patterns.values()).sort((a, b) => a.frequency - b.frequency);
        const toRemove = sorted.slice(0, Math.floor(this.MAX_PATTERNS * 0.2));
        for (const p of toRemove) {
            this.patterns.delete(p.pattern);
        }
    }
    /**
     * 获取反思建议
     */
    getRecommendations(reflectionId) {
        if (reflectionId) {
            const reflection = this.reflectionHistory.find((r) => r.id === reflectionId);
            return (reflection === null || reflection === void 0 ? void 0 : reflection.recommendations) || [];
        }
        // 返回所有高优先级建议
        const highQualityReflections = this.reflectionHistory
            .filter((r) => r.quality >= this.MIN_QUALITY_THRESHOLD && r.actionable)
            .sort((a, b) => b.quality - a.quality);
        const recommendations = new Set();
        for (const r of highQualityReflections.slice(0, 10)) {
            r.recommendations.forEach((rec) => recommendations.add(rec));
        }
        return Array.from(recommendations);
    }
    /**
     * 获取会话
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    /**
     * 获取统计信息
     */
    getStats() {
        const sessions = Array.from(this.sessions.values());
        const completedSessions = sessions.filter((s) => s.completedAt);
        const avgQuality = completedSessions.length > 0
            ? completedSessions.reduce((sum, s) => sum + s.overallQuality, 0) / completedSessions.length
            : 0;
        const topPatterns = Array.from(this.patterns.values())
            .sort((a, b) => b.frequency * b.severity - a.frequency * a.severity)
            .slice(0, 5);
        // 计算趋势
        let trend = 'stable';
        if (completedSessions.length >= 10) {
            const recent = completedSessions.slice(-5);
            const older = completedSessions.slice(-10, -5);
            const recentAvg = recent.reduce((sum, s) => sum + s.overallQuality, 0) / recent.length;
            const olderAvg = older.reduce((sum, s) => sum + s.overallQuality, 0) / older.length;
            if (recentAvg > olderAvg + 0.1)
                trend = 'improving';
            else if (recentAvg < olderAvg - 0.1)
                trend = 'declining';
        }
        return {
            totalSessions: completedSessions.length,
            averageQuality: avgQuality,
            patternCount: this.patterns.size,
            topPatterns,
            improvementTrend: trend,
        };
    }
    /**
     * 获取相关模式
     */
    getRelatedPatterns(context) {
        const lower = context.toLowerCase();
        return Array.from(this.patterns.values())
            .filter((p) => {
            const patternWords = p.pattern.toLowerCase().split(' ');
            return patternWords.some((word) => lower.includes(word));
        })
            .sort((a, b) => {
            const scoreA = a.frequency * a.severity;
            const scoreB = b.frequency * b.severity;
            return scoreB - scoreA;
        });
    }
    /**
     * 生成反思报告
     */
    generateReport(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return 'Session not found';
        const report = [
            `# Reflection Report: ${session.taskId}`,
            ``,
            `**Created**: ${session.createdAt}`,
            `**Completed**: ${session.completedAt || 'In progress'}`,
            `**Quality**: ${(session.overallQuality * 100).toFixed(0)}%`,
            ``,
            `## Key Insight`,
            session.keyInsight,
            ``,
            `## Reflections`,
        ];
        for (const reflection of session.reflections) {
            report.push(``);
            report.push(`### [${reflection.type}] ${reflection.createdAt}`);
            report.push(`**Q**: ${reflection.question}`);
            if (reflection.answer) {
                report.push(`**A**: ${reflection.answer}`);
            }
            if (reflection.insights.length > 0) {
                report.push(`**Insights**: ${reflection.insights.join(', ')}`);
            }
            if (reflection.recommendations.length > 0) {
                report.push(`**Recommendations**: ${reflection.recommendations.join(', ')}`);
            }
        }
        return report.join('\n');
    }
}
exports.ReflectionEngine = ReflectionEngine;
// ========================================
// Factory
// ========================================
const tenantAwareSingleton_1 = require("./runtime/tenantAwareSingleton");
const reflectionEngineSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new ReflectionEngine());
function getGlobalReflectionEngine() {
    return reflectionEngineSingleton.get();
}
function createReflectionEngine() {
    return new ReflectionEngine();
}
function resetReflectionEngine() {
    reflectionEngineSingleton.reset();
}
