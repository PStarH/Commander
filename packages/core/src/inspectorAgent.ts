/**
 * Inspector Agent
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 * 
 * Core insight: 独立的监督 agent 检查整个系统
 * - 监控各组件健康状态
 * - 检测异常和性能问题
 * - 提供改进建议
 */

function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ========================================
// Types
// ========================================

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type IssueCategory = 
  | 'performance'    // 性能问题
  | 'reliability'    // 可靠性问题
  | 'security'       // 安全问题
  | 'memory'         // 内存问题
  | 'coordination'   // 协作问题
  | 'configuration'; // 配置问题

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
  score: number;          // 0-1
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

// ========================================
// Inspector Agent
// ========================================

export class InspectorAgent {
  private issues: Map<string, Issue> = new Map();
  private componentStates: Map<string, ComponentHealth> = new Map();
  private inspectionHistory: InspectionReport[] = [];

  // 阈值配置
  private readonly HEALTHY_THRESHOLD = 0.8;
  private readonly DEGRADED_THRESHOLD = 0.5;
  private readonly MAX_HISTORY = 100;

  /**
   * 更新组件状态
   */
  updateComponent(
    name: string,
    status: 'healthy' | 'degraded' | 'unhealthy',
    score: number,
    metrics: Record<string, number> = {}
  ): void {
    const component: ComponentHealth = {
      name,
      status,
      score,
      lastChecked: new Date().toISOString(),
      issues: this.getOpenIssues().filter(i => i.affectedComponent === name),
      metrics
    };

    this.componentStates.set(name, component);
  }

  /**
   * 检测问题
   */
  detectIssue(
    category: IssueCategory,
    severity: IssueSeverity,
    title: string,
    description: string,
    affectedComponent?: string,
    suggestions: string[] = []
  ): Issue {
    const issue: Issue = {
      id: generateUUID(),
      category,
      severity,
      title,
      description,
      affectedComponent,
      detectedAt: new Date().toISOString(),
      status: 'open',
      suggestions
    };

    this.issues.set(issue.id, issue);
    return issue;
  }

  /**
   * 自动检测问题
   */
  autoDetect(componentName: string, metrics: Record<string, number>): Issue[] {
    const detected: Issue[] = [];

    // 检测性能问题
    if (metrics.responseTime && metrics.responseTime > 1000) {
      detected.push(this.detectIssue(
        'performance',
        metrics.responseTime > 5000 ? 'high' : 'medium',
        'High response time detected',
        `Response time: ${metrics.responseTime}ms (threshold: 1000ms)`,
        componentName,
        ['Consider optimizing query', 'Add caching', 'Scale horizontally']
      ));
    }

    // 检测错误率
    if (metrics.errorRate && metrics.errorRate > 0.05) {
      detected.push(this.detectIssue(
        'reliability',
        metrics.errorRate > 0.2 ? 'critical' : 'high',
        'High error rate detected',
        `Error rate: ${(metrics.errorRate * 100).toFixed(2)}% (threshold: 5%)`,
        componentName,
        ['Review error logs', 'Implement retry logic', 'Check dependencies']
      ));
    }

    // 检测内存问题
    if (metrics.memoryUsage && metrics.memoryUsage > 0.9) {
      detected.push(this.detectIssue(
        'memory',
        metrics.memoryUsage > 0.95 ? 'critical' : 'high',
        'High memory usage',
        `Memory usage: ${(metrics.memoryUsage * 100).toFixed(1)}% (threshold: 90%)`,
        componentName,
        ['Clear caches', 'Increase memory', 'Profile memory usage']
      ));
    }

    // 检测队列积压
    if (metrics.queueDepth && metrics.queueDepth > 100) {
      detected.push(this.detectIssue(
        'performance',
        metrics.queueDepth > 500 ? 'high' : 'medium',
        'Queue depth excessive',
        `Queue depth: ${metrics.queueDepth} (threshold: 100)`,
        componentName,
        ['Scale workers', 'Reduce submission rate', 'Optimize processing']
      ));
    }

    // 检测低成功率
    if (metrics.successRate && metrics.successRate < 0.8) {
      detected.push(this.detectIssue(
        'reliability',
        metrics.successRate < 0.5 ? 'critical' : 'high',
        'Low success rate',
        `Success rate: ${(metrics.successRate * 100).toFixed(1)}% (threshold: 80%)`,
        componentName,
        ['Analyze failure patterns', 'Add validation', 'Review error handling']
      ));
    }

    return detected;
  }

  /**
   * 获取开启的问题
   */
  getOpenIssues(): Issue[] {
    return Array.from(this.issues.values())
      .filter(i => i.status === 'open')
      .sort((a, b) => this.severityWeight(b.severity) - this.severityWeight(a.severity));
  }

  /**
   * 问题严重程度权重
   */
  private severityWeight(severity: IssueSeverity): number {
    switch (severity) {
      case 'critical': return 5;
      case 'high': return 4;
      case 'medium': return 3;
      case 'low': return 2;
      case 'info': return 1;
    }
  }

  /**
   * 解决Issue
   */
  resolveIssue(issueId: string): boolean {
    const issue = this.issues.get(issueId);
    if (!issue) return false;

    issue.status = 'resolved';
    issue.resolvedAt = new Date().toISOString();
    return true;
  }

  /**
   * 忽略Issue
   */
  ignoreIssue(issueId: string): boolean {
    const issue = this.issues.get(issueId);
    if (!issue) return false;

    issue.status = 'ignored';
    return true;
  }

  /**
   * 执行检查
   */
  inspect(): InspectionReport {
    const components = Array.from(this.componentStates.values());
    const openIssues = this.getOpenIssues();
    const resolvedIssues = Array.from(this.issues.values())
      .filter(i => i.status === 'resolved')
      .slice(-10);

    // 计算整体健康度
    let overallHealth = 1.0;
    if (components.length > 0) {
      overallHealth = components.reduce((sum, c) => sum + c.score, 0) / components.length;
    }

    // 扣减未解决问题的影响
    for (const issue of openIssues) {
      const weight = this.severityWeight(issue.severity);
      overallHealth -= weight * 0.05;
    }
    overallHealth = Math.max(0, overallHealth);

    // 确定整体状态
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (overallHealth >= this.HEALTHY_THRESHOLD) {
      overallStatus = 'healthy';
    } else if (overallHealth >= this.DEGRADED_THRESHOLD) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'unhealthy';
    }

    // 生成建议
    const recommendations = this.generateRecommendations(openIssues, components);

    // 生成摘要
    const summary = this.generateSummary(overallStatus, openIssues);

    const report: InspectionReport = {
      id: generateUUID(),
      timestamp: new Date().toISOString(),
      overallHealth,
      overallStatus,
      components,
      openIssues,
      resolvedIssues,
      recommendations,
      summary
    };

    this.inspectionHistory.push(report);

    // 限制历史长度
    if (this.inspectionHistory.length > this.MAX_HISTORY) {
      this.inspectionHistory.shift();
    }

    return report;
  }

  /**
   * 生成建议
   */
  private generateRecommendations(openIssues: Issue[], components: ComponentHealth[]): string[] {
    const recommendations: string[] = [];

    // 按类别分组问题
    const byCategory = new Map<IssueCategory, Issue[]>();
    for (const issue of openIssues) {
      const existing = byCategory.get(issue.category) || [];
      existing.push(issue);
      byCategory.set(issue.category, existing);
    }

    // 每个类别生成建议
    for (const [category, issues] of byCategory) {
      if (issues.length > 0) {
        recommendations.push(`${this.categoryLabel(category)}: ${issues.length} open issue(s)`);
        
        // 添加第一问题的建议
        const topIssue = issues.sort((a, b) => 
          this.severityWeight(b.severity) - this.severityWeight(a.severity)
        )[0];
        
        if (topIssue.suggestions.length > 0) {
          recommendations.push(`  → ${topIssue.suggestions[0]}`);
        }
      }
    }

    // 检查组件健康
    for (const component of components) {
      if (component.status === 'unhealthy') {
        recommendations.push(`Critical issue in ${component.name}: consider restart or scale`);
      }
    }

    return recommendations;
  }

  /**
   * 类别标签
   */
  private categoryLabel(category: IssueCategory): string {
    switch (category) {
      case 'performance': return 'Performance';
      case 'reliability': return 'Reliability';
      case 'security': return 'Security';
      case 'memory': return 'Memory';
      case 'coordination': return 'Coordination';
      case 'configuration': return 'Configuration';
    }
  }

  /**
   * 生成摘要
   */
  private generateSummary(status: string, openIssues: Issue[]): string {
    const critical = openIssues.filter(i => i.severity === 'critical').length;
    const high = openIssues.filter(i => i.severity === 'high').length;
    const total = openIssues.length;

    if (status === 'healthy' && total === 0) {
      return 'All systems operational';
    }
    if (critical > 0) {
      return `${critical} critical issue(s) require immediate attention`;
    }
    if (high > 0) {
      return `${high} high priority issue(s) need resolution`;
    }
    if (total > 0) {
      return `${total} open issue(s) being tracked`;
    }
    return 'Minor issues detected, system stable';
  }

  /**
   * 获取历史报告
   */
  getHistory(limit: number = 10): InspectionReport[] {
    return this.inspectionHistory.slice(-limit);
  }

  /**
   * 获取健康趋势
   */
  getHealthTrend(): {
    trend: 'improving' | 'declining' | 'stable';
    change: number;
    history: Array<{ timestamp: string; health: number }>;
  } {
    const history = this.inspectionHistory.slice(-20);
    
    if (history.length < 2) {
      return { trend: 'stable', change: 0, history: [] };
    }

    const recent = history.slice(-5);
    const older = history.slice(-10, -5);

    const recentAvg = recent.reduce((sum, r) => sum + r.overallHealth, 0) / recent.length;
    const olderAvg = older.length > 0 
      ? older.reduce((sum, r) => sum + r.overallHealth, 0) / older.length
      : recentAvg;

    const change = recentAvg - olderAvg;
    
    let trend: 'improving' | 'declining' | 'stable';
    if (change > 0.05) trend = 'improving';
    else if (change < -0.05) trend = 'declining';
    else trend = 'stable';

    return {
      trend,
      change,
      history: history.map(r => ({ timestamp: r.timestamp, health: r.overallHealth }))
    };
  }

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
  } {
    const allIssues = Array.from(this.issues.values());
    const open = allIssues.filter(i => i.status === 'open');
    const resolved = allIssues.filter(i => i.status === 'resolved');

    const byCategory: Record<IssueCategory, number> = {
      performance: 0,
      reliability: 0,
      security: 0,
      memory: 0,
      coordination: 0,
      configuration: 0
    };

    const bySeverity: Record<IssueSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0
    };

    for (const issue of open) {
      byCategory[issue.category]++;
      bySeverity[issue.severity]++;
    }

    // 计算平均解决时间
    let avgResolutionTime: number | undefined;
    const resolvedWithTime = resolved.filter(i => i.resolvedAt);
    if (resolvedWithTime.length > 0) {
      let totalTime = 0;
      for (const issue of resolvedWithTime) {
        const detected = new Date(issue.detectedAt).getTime();
        const resolved = new Date(issue.resolvedAt!).getTime();
        totalTime += resolved - detected;
      }
      avgResolutionTime = totalTime / resolvedWithTime.length / 1000; // seconds
    }

    return {
      totalIssues: allIssues.length,
      openIssues: open.length,
      resolvedIssues: resolved.length,
      byCategory,
      bySeverity,
      avgResolutionTime
    };
  }

  /**
   * 清除旧Issue
   */
  clearResolved(olderThanMs: number = 86400000): number {
    const threshold = Date.now() - olderThanMs;
    let removed = 0;

    for (const [id, issue] of this.issues.entries()) {
      if (issue.status === 'resolved' && issue.resolvedAt) {
        const resolved = new Date(issue.resolvedAt).getTime();
        if (resolved < threshold) {
          this.issues.delete(id);
          removed++;
        }
      }
      if (issue.status === 'ignored' && issue.detectedAt) {
        const detected = new Date(issue.detectedAt).getTime();
        if (detected < threshold) {
          this.issues.delete(id);
          removed++;
        }
      }
    }

    return removed;
  }
}

// ========================================
// Factory
// ========================================

let globalInspector: InspectorAgent | null = null;

export function getGlobalInspector(): InspectorAgent {
  if (!globalInspector) {
    globalInspector = new InspectorAgent();
  }
  return globalInspector;
}

export function createInspector(): InspectorAgent {
  return new InspectorAgent();
}