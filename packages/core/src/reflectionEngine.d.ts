/**
 * Reflection Engine
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 让 agent 在执行后反思自己的行为
 * - 自我评估: 哪里做得好/不好
 * - 模式识别: 发现反复出现的问题
 * - 策略调整: 基于历史调整行为
 */
export type ReflectionType = 'post_execution' | 'pre_planning' | 'error_analysis' | 'pattern_detection';
export interface Reflection {
    id: string;
    type: ReflectionType;
    context: string;
    question: string;
    answer?: string;
    quality: number;
    actionable: boolean;
    insights: string[];
    recommendations: string[];
    createdAt: string;
    relatedOutcome?: 'success' | 'partial' | 'failure';
}
export interface ReflectionSession {
    id: string;
    taskId: string;
    reflections: Reflection[];
    overallQuality: number;
    keyInsight: string;
    createdAt: string;
    completedAt?: string;
}
export interface ReflectionPattern {
    id: string;
    pattern: string;
    frequency: number;
    severity: number;
    firstSeen: string;
    lastSeen: string;
    resolution?: string;
}
export interface ReflectionStats {
    totalSessions: number;
    averageQuality: number;
    patternCount: number;
    topPatterns: ReflectionPattern[];
    improvementTrend: 'improving' | 'declining' | 'stable';
}
export declare class ReflectionEngine {
    private sessions;
    private patterns;
    private reflectionHistory;
    private readonly MIN_QUALITY_THRESHOLD;
    private readonly PATTERN_SIMILARITY_THRESHOLD;
    private readonly MAX_PATTERNS;
    private readonly MAX_SESSIONS;
    private readonly MAX_HISTORY;
    /**
     * 开始反思会话
     */
    startSession(taskId: string): string;
    /**
     * 添加反思
     */
    addReflection(sessionId: string, context: string, question: string, answer?: string): Reflection;
    /**
     * 确定反思类型
     */
    private determineType;
    /**
     * 分析反思内容
     */
    private analyzeReflection;
    /**
     * 更新会话质量
     */
    private updateSessionQuality;
    /**
     * 完成会话
     */
    completeSession(sessionId: string, outcome?: 'success' | 'partial' | 'failure'): void;
    /**
     * 检测模式
     */
    private detectPatterns;
    /**
     * 计算严重程度
     */
    private calculateSeverity;
    /**
     * 修剪低频模式
     */
    private prunePatterns;
    /**
     * 获取反思建议
     */
    getRecommendations(reflectionId?: string): string[];
    /**
     * 获取会话
     */
    getSession(sessionId: string): ReflectionSession | undefined;
    /**
     * 获取统计信息
     */
    getStats(): ReflectionStats;
    /**
     * 获取相关模式
     */
    getRelatedPatterns(context: string): ReflectionPattern[];
    /**
     * 生成反思报告
     */
    generateReport(sessionId: string): string;
}
export declare function getGlobalReflectionEngine(): ReflectionEngine;
export declare function createReflectionEngine(): ReflectionEngine;
export declare function resetReflectionEngine(): void;
//# sourceMappingURL=reflectionEngine.d.ts.map