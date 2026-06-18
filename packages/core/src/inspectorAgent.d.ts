/**
 * Inspector Agent
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 *
 * Core insight: 独立的监督 agent 检查整个系统
 * - 监控各组件健康状态
 * - 检测异常和性能问题
 * - 提供改进建议
 *
 * @deprecated Use the unified verification pipeline (UnifiedVerificationPipeline)
 * and metrics collector (MetricsCollector) instead. This module will be removed
 * in a future major version.
 */
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type IssueCategory = 'performance' | 'reliability' | 'security' | 'memory' | 'coordination' | 'configuration';
export interface Issue {
    id: string;
    category: IssueCategory;
    severity: IssueSeverity;
    title: string;
    description: string;
    affectedComponent?: string;
    detectedAt: string;
    resolvedAt?: string;
    status: 'open' | 'acknowledged' | 'resolved' | 'ignored';
    suggestions: string[];
    metrics?: Record<string, number>;
}
export interface ComponentHealth {
    name: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    score: number;
    lastChecked: string;
    issues: Issue[];
    metrics: Record<string, number>;
}
export interface InspectionReport {
    id: string;
    timestamp: string;
    overallHealth: number;
    overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    components: ComponentHealth[];
    openIssues: Issue[];
    resolvedIssues: Issue[];
    recommendations: string[];
    summary: string;
}
export declare class InspectorAgent {
    private issues;
    private componentStates;
    private inspectionHistory;
    private readonly HEALTHY_THRESHOLD;
    private readonly DEGRADED_THRESHOLD;
    private readonly MAX_HISTORY;
    /**
     * 更新组件状态
     */
    updateComponent(name: string, status: 'healthy' | 'degraded' | 'unhealthy', score: number, metrics?: Record<string, number>): void;
    /**
     * 检测问题
     */
    detectIssue(category: IssueCategory, severity: IssueSeverity, title: string, description: string, affectedComponent?: string, suggestions?: string[]): Issue;
    /**
     * 自动检测问题
     */
    autoDetect(componentName: string, metrics: Record<string, number>): Issue[];
    /**
     * 获取开启的问题
     */
    getOpenIssues(): Issue[];
    /**
     * 问题严重程度权重
     */
    private severityWeight;
    /**
     * 解决Issue
     */
    resolveIssue(issueId: string): boolean;
    /**
     * 忽略Issue
     */
    ignoreIssue(issueId: string): boolean;
    /**
     * 执行检查
     */
    inspect(): InspectionReport;
    /**
     * 生成建议
     */
    private generateRecommendations;
    /**
     * 类别标签
     */
    private categoryLabel;
    /**
     * 生成摘要
     */
    private generateSummary;
    /**
     * 获取历史报告
     */
    getHistory(limit?: number): InspectionReport[];
    /**
     * 获取健康趋势
     */
    getHealthTrend(): {
        trend: 'improving' | 'declining' | 'stable';
        change: number;
        history: Array<{
            timestamp: string;
            health: number;
        }>;
    };
    /**
     * 获取统计
     */
    getStats(): {
        totalIssues: number;
        openIssues: number;
        resolvedIssues: number;
        byCategory: Record<IssueCategory, number>;
        bySeverity: Record<IssueSeverity, number>;
        avgResolutionTime?: number;
    };
    /**
     * 清除旧Issue
     */
    clearResolved(olderThanMs?: number): number;
}
export declare function getGlobalInspector(): InspectorAgent;
export declare function createInspector(): InspectorAgent;
export declare function resetInspectorAgent(): void;
//# sourceMappingURL=inspectorAgent.d.ts.map