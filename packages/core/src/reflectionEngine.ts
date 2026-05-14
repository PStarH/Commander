/**
 * Reflection Engine
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 * 
 * Core insight: 让 agent 在执行后反思自己的行为
 * - 自我评估: 哪里做得好/不好
 * - 模式识别: 发现反复出现的问题
 * - 策略调整: 基于历史调整行为
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

export type ReflectionType = 
  | 'post_execution'   // 执行后反思
  | 'pre_planning'     // 计划前反思
  | 'error_analysis'   // 错误分析
  | 'pattern_detection'; // 模式检测

export interface Reflection {
  id: string;
  type: ReflectionType;
  context: string;           // 反思上下文
  question: string;          // 提出的问题
  answer?: string;           // 反思答案
  quality: number;           // 0-1, 反思质量
  actionable: boolean;       // 是否可执行
  insights: string[];        // 关键洞察
  recommendations: string[]; // 建议
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
  pattern: string;           // 问题模式描述
  frequency: number;         // 出现频率
  severity: number;          // 严重程度
  firstSeen: string;
  lastSeen: string;
  resolution?: string;       // 解决方案
}

export interface ReflectionStats {
  totalSessions: number;
  averageQuality: number;
  patternCount: number;
  topPatterns: ReflectionPattern[];
  improvementTrend: 'improving' | 'declining' | 'stable';
}

// ========================================
// Reflection Engine
// ========================================

export class ReflectionEngine {
  private sessions: Map<string, ReflectionSession> = new Map();
  private patterns: Map<string, ReflectionPattern> = new Map();
  private reflectionHistory: Reflection[] = [];

  // 配置
  private readonly MIN_QUALITY_THRESHOLD = 0.5;
  private readonly PATTERN_SIMILARITY_THRESHOLD = 0.8;
  private readonly MAX_PATTERNS = 50;

  /**
   * 开始反思会话
   */
  startSession(taskId: string): string {
    const session: ReflectionSession = {
      id: generateUUID(),
      taskId,
      reflections: [],
      overallQuality: 0,
      keyInsight: '',
      createdAt: new Date().toISOString()
    };
    this.sessions.set(session.id, session);
    return session.id;
  }

  /**
   * 添加反思
   */
  addReflection(
    sessionId: string,
    context: string,
    question: string,
    answer?: string
  ): Reflection {
    const reflection: Reflection = {
      id: generateUUID(),
      type: this.determineType(context),
      context,
      question,
      answer,
      quality: 0,
      actionable: false,
      insights: [],
      recommendations: [],
      createdAt: new Date().toISOString()
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

    this.reflectionHistory.push(reflection);
    this.detectPatterns(reflection);

    return reflection;
  }

  /**
   * 确定反思类型
   */
  private determineType(context: string): ReflectionType {
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
  private analyzeReflection(reflection: Reflection): {
    quality: number;
    actionable: boolean;
    insights: string[];
    recommendations: string[];
  } {
    const insights: string[] = [];
    const recommendations: string[] = [];
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
    if (lower.includes('avoid') || lower.includes('shouldn\'t')) {
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
    const actionable = recommendations.length > 0 && recommendations.some(r => 
      r.length > 10 && (r.includes('Add') || r.includes('Implement') || r.includes('Create'))
    );

    return {
      quality: Math.min(1, qualityScore),
      actionable,
      insights,
      recommendations
    };
  }

  /**
   * 更新会话质量
   */
  private updateSessionQuality(session: ReflectionSession): void {
    if (session.reflections.length === 0) return;

    const avgQuality = session.reflections.reduce((sum, r) => sum + r.quality, 0) / 
      session.reflections.length;
    session.overallQuality = avgQuality;

    // 更新关键洞察
    const highQualityReflections = session.reflections
      .filter(r => r.quality >= this.MIN_QUALITY_THRESHOLD)
      .sort((a, b) => b.quality - a.quality);

    if (highQualityReflections.length > 0) {
      session.keyInsight = highQualityReflections[0].insights[0] || 
        highQualityReflections[0].recommendations[0] || 
        'Review completed';
    }
  }

  /**
   * 完成会话
   */
  completeSession(sessionId: string, outcome?: 'success' | 'partial' | 'failure'): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.completedAt = new Date().toISOString();
      
      // 更新所有反思的结果
      session.reflections.forEach(r => {
        r.relatedOutcome = outcome;
      });
    }
  }

  /**
   * 检测模式
   */
  private detectPatterns(reflection: Reflection): void {
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
      const matchCount = p.keywords.filter(k => content.includes(k)).length;
      
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
        } else {
          const newPattern: ReflectionPattern = {
            id: generateUUID(),
            pattern: p.pattern,
            frequency: 1,
            severity: this.calculateSeverity(p.pattern, reflection),
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            resolution: reflection.recommendations[0]
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
  private calculateSeverity(pattern: string, reflection: Reflection): number {
    let severity = 0.5;

    if (reflection.type === 'error_analysis') severity += 0.2;
    if (reflection.relatedOutcome === 'failure') severity += 0.2;
    if (reflection.quality < 0.5) severity += 0.1;

    return Math.min(1, severity);
  }

  /**
   * 修剪低频模式
   */
  private prunePatterns(): void {
    const sorted = Array.from(this.patterns.values())
      .sort((a, b) => a.frequency - b.frequency);

    const toRemove = sorted.slice(0, Math.floor(this.MAX_PATTERNS * 0.2));
    for (const p of toRemove) {
      this.patterns.delete(p.pattern);
    }
  }

  /**
   * 获取反思建议
   */
  getRecommendations(reflectionId?: string): string[] {
    if (reflectionId) {
      const reflection = this.reflectionHistory.find(r => r.id === reflectionId);
      return reflection?.recommendations || [];
    }

    // 返回所有高优先级建议
    const highQualityReflections = this.reflectionHistory
      .filter(r => r.quality >= this.MIN_QUALITY_THRESHOLD && r.actionable)
      .sort((a, b) => b.quality - a.quality);

    const recommendations = new Set<string>();
    for (const r of highQualityReflections.slice(0, 10)) {
      r.recommendations.forEach(rec => recommendations.add(rec));
    }

    return Array.from(recommendations);
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): ReflectionSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * 获取统计信息
   */
  getStats(): ReflectionStats {
    const sessions = Array.from(this.sessions.values());
    const completedSessions = sessions.filter(s => s.completedAt);
    
    const avgQuality = completedSessions.length > 0
      ? completedSessions.reduce((sum, s) => sum + s.overallQuality, 0) / completedSessions.length
      : 0;

    const topPatterns = Array.from(this.patterns.values())
      .sort((a, b) => b.frequency * b.severity - a.frequency * a.severity)
      .slice(0, 5);

    // 计算趋势
    let trend: 'improving' | 'declining' | 'stable' = 'stable';
    if (completedSessions.length >= 10) {
      const recent = completedSessions.slice(-5);
      const older = completedSessions.slice(-10, -5);
      const recentAvg = recent.reduce((sum, s) => sum + s.overallQuality, 0) / recent.length;
      const olderAvg = older.reduce((sum, s) => sum + s.overallQuality, 0) / older.length;

      if (recentAvg > olderAvg + 0.1) trend = 'improving';
      else if (recentAvg < olderAvg - 0.1) trend = 'declining';
    }

    return {
      totalSessions: completedSessions.length,
      averageQuality: avgQuality,
      patternCount: this.patterns.size,
      topPatterns,
      improvementTrend: trend
    };
  }

  /**
   * 获取相关模式
   */
  getRelatedPatterns(context: string): ReflectionPattern[] {
    const lower = context.toLowerCase();
    
    return Array.from(this.patterns.values())
      .filter(p => {
        const patternWords = p.pattern.toLowerCase().split(' ');
        return patternWords.some(word => lower.includes(word));
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
  generateReport(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return 'Session not found';

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

// ========================================
// Factory
// ========================================

let globalEngine: ReflectionEngine | null = null;

export function getGlobalReflectionEngine(): ReflectionEngine {
  if (!globalEngine) {
    globalEngine = new ReflectionEngine();
  }
  return globalEngine;
}

export function createReflectionEngine(): ReflectionEngine {
  return new ReflectionEngine();
}