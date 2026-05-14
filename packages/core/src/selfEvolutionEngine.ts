/**
 * Self-Evolution Engine — Commander 独有能力
 * 
 * 其他框架只能执行任务，Commander 能自我进化。
 * 
 * 工作原理：
 * 1. 执行任务 → 收集反馈
 * 2. 反思引擎分析成功/失败模式
 * 3. 提取可复用的策略
 * 4. 更新代理的能力模型
 * 5. 下次类似任务自动应用改进策略
 */

import { ThreeLayerMemory } from './threeLayerMemory';
import { ReflectionEngine } from './reflectionEngine';

export interface EvolutionEvent {
  id: string;
  timestamp: Date;
  taskId: string;
  taskType: string;
  outcome: 'success' | 'failure' | 'partial';
  strategy: string;
  metrics: {
    duration: number;
    tokensUsed: number;
    qualityScore: number;
  };
  reflections: string[];
  extractedPatterns: Pattern[];
}

export interface Pattern {
  id: string;
  name: string;
  description: string;
  applicability: string[];
  confidence: number;
  usageCount: number;
  successRate: number;
  strategy: string;
}

export interface EvolutionStats {
  totalEvents: number;
  successRate: number;
  patternsLearned: number;
  averageImprovement: number;
  topPatterns: Pattern[];
}

export class SelfEvolutionEngine {
  private memory: ThreeLayerMemory;
  private reflection: ReflectionEngine;
  private patterns: Map<string, Pattern> = new Map();
  private evolutionHistory: EvolutionEvent[] = [];

  constructor(memory: ThreeLayerMemory, reflection: ReflectionEngine) {
    this.memory = memory;
    this.reflection = reflection;
  }

  /**
   * 记录一次任务执行，触发进化
   */
  async evolve(event: Omit<EvolutionEvent, 'id' | 'extractedPatterns'>): Promise<EvolutionEvent> {
    const id = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // 1. 生成反思（通过 ReflectionEngine 的 session 机制）
    const sessionId = this.reflection.startSession(event.taskId);
    this.reflection.addReflection(
      sessionId,
      event.taskType,
      `任务 ${event.taskId} 的执行策略: ${event.strategy}`,
      event.outcome === 'success' ? '成功' : '失败'
    );
    this.reflection.completeSession(sessionId, event.outcome === 'success' ? 'success' : 'failure');
    const recommendations = this.reflection.getRecommendations();
    const reflectionTexts: string[] = recommendations.length > 0 ? recommendations : [`任务 ${event.outcome}`];

    // 2. 提取模式
    const patterns = this.extractPatterns(event, reflectionTexts);
    
    // 3. 更新模式库
    for (const pattern of patterns) {
      this.updatePattern(pattern);
    }

    // 4. 存储到记忆
    this.memory.add(
      `任务 ${event.taskId} (${event.taskType}): ${event.outcome}。策略: ${event.strategy}`,
      'episodic',
      '',
      event.outcome === 'success' ? 0.8 : 0.6,
      [event.taskType, event.outcome]
    );

    // 5. 存储学到的模式
    for (const pattern of patterns) {
      this.memory.add(
        `模式: ${pattern.name} - ${pattern.description}。成功率: ${pattern.successRate}`,
        'longterm',
        '',
        pattern.confidence,
        ['pattern', event.taskType]
      );
    }

    const fullEvent: EvolutionEvent = {
      ...event,
      id,
      reflections: reflectionTexts,
      extractedPatterns: patterns,
    };

    this.evolutionHistory.push(fullEvent);
    return fullEvent;
  }

  /**
   * 从事件中提取可复用模式
   */
  private extractPatterns(event: Omit<EvolutionEvent, 'id' | 'extractedPatterns'>, reflections: string[]): Pattern[] {
    const patterns: Pattern[] = [];

    // 成功模式提取
    if (event.outcome === 'success') {
      patterns.push({
        id: `pattern-${Date.now()}`,
        name: `${event.taskType}-success-strategy`,
        description: `成功策略: ${event.strategy}`,
        applicability: [event.taskType],
        confidence: event.metrics.qualityScore,
        usageCount: 1,
        successRate: 1.0,
        strategy: event.strategy,
      });
    }

    // 失败模式提取（用于避免）
    if (event.outcome === 'failure') {
      patterns.push({
        id: `pattern-avoid-${Date.now()}`,
        name: `${event.taskType}-failure-avoid`,
        description: `避免策略: ${event.strategy}`,
        applicability: [event.taskType],
        confidence: 1 - event.metrics.qualityScore,
        usageCount: 1,
        successRate: 0,
        strategy: `AVOID: ${event.strategy}`,
      });
    }

    // 从反思中提取洞察
    for (const reflection of reflections) {
      if (reflection.includes('改进') || reflection.includes('优化')) {
        patterns.push({
          id: `pattern-insight-${Date.now()}`,
          name: `${event.taskType}-insight`,
          description: reflection,
          applicability: [event.taskType],
          confidence: 0.6,
          usageCount: 0,
          successRate: 0.5,
          strategy: reflection,
        });
      }
    }

    return patterns;
  }

  /**
   * 更新模式库（合并相似模式）
   */
  private updatePattern(newPattern: Pattern): void {
    const existingKey = `${newPattern.name}-${newPattern.applicability.join(',')}`;
    const existing = this.patterns.get(existingKey);

    if (existing) {
      // 合并：加权平均成功率
      const totalUsage = existing.usageCount + newPattern.usageCount;
      existing.successRate = (
        existing.successRate * existing.usageCount + 
        newPattern.successRate * newPattern.usageCount
      ) / totalUsage;
      existing.usageCount = totalUsage;
      existing.confidence = Math.min(0.95, existing.confidence + 0.05);
    } else {
      this.patterns.set(existingKey, newPattern);
    }
  }

  /**
   * 获取推荐策略（基于历史学习）
   */
  getRecommendedStrategy(taskType: string): Pattern | null {
    const applicable = Array.from(this.patterns.values())
      .filter(p => p.applicability.includes(taskType) && p.successRate > 0.5)
      .sort((a, b) => b.successRate * b.confidence - a.successRate * a.confidence);

    return applicable[0] || null;
  }

  /**
   * 获取进化统计
   */
  getStats(): EvolutionStats {
    const totalEvents = this.evolutionHistory.length;
    const successCount = this.evolutionHistory.filter(e => e.outcome === 'success').length;
    const successRate = totalEvents > 0 ? successCount / totalEvents : 0;
    const patternsLearned = this.patterns.size;

    // 计算平均改进（通过比较前后质量分数）
    let averageImprovement = 0;
    if (totalEvents >= 2) {
      const recent = this.evolutionHistory.slice(-5);
      const older = this.evolutionHistory.slice(0, 5);
      const recentAvg = recent.reduce((sum, e) => sum + e.metrics.qualityScore, 0) / recent.length;
      const olderAvg = older.reduce((sum, e) => sum + e.metrics.qualityScore, 0) / older.length;
      averageImprovement = recentAvg - olderAvg;
    }

    const topPatterns = Array.from(this.patterns.values())
      .sort((a, b) => b.successRate * b.confidence - a.successRate * a.confidence)
      .slice(0, 5);

    return {
      totalEvents,
      successRate,
      patternsLearned,
      averageImprovement,
      topPatterns,
    };
  }

  /**
   * 生成进化报告
   */
  generateReport(): string {
    const stats = this.getStats();
    
    let report = '# Commander 进化报告\n\n';
    report += `## 总体统计\n`;
    report += `- 总事件数: ${stats.totalEvents}\n`;
    report += `- 成功率: ${(stats.successRate * 100).toFixed(1)}%\n`;
    report += `- 学到的模式: ${stats.patternsLearned}\n`;
    report += `- 平均改进: ${(stats.averageImprovement * 100).toFixed(1)}%\n\n`;

    if (stats.topPatterns.length > 0) {
      report += `## 最佳策略\n`;
      for (const pattern of stats.topPatterns) {
        report += `- **${pattern.name}**: ${pattern.description} (成功率: ${(pattern.successRate * 100).toFixed(0)}%, 置信度: ${(pattern.confidence * 100).toFixed(0)}%)\n`;
      }
    }

    return report;
  }
}

/**
 * 创建全局进化引擎实例
 */
export function createEvolutionEngine(): SelfEvolutionEngine {
  const memory = new ThreeLayerMemory();
  const reflection = new ReflectionEngine();
  return new SelfEvolutionEngine(memory, reflection);
}
