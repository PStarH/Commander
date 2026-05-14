/**
 * Consensus Check
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 * 
 * Core insight: 关键决策需要多模型共识
 * - 收集多个模型的独立判断
 * - 分析一致性程度
 * - 低共识时触发讨论或重新评估
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

export type ConsensusLevel = 'unanimous' | 'strong' | 'moderate' | 'low' | 'diverged';

export interface ModelVote {
  modelId: string;
  modelName: string;
  decision: string;
  confidence: number;      // 0-1
  reasoning: string;
  timestamp: string;
}

export interface ConsensusCheck {
  id: string;
  question: string;
  context: string;
  votes: ModelVote[];
  consensusLevel: ConsensusLevel;
  consensusScore: number;  // 0-1, 一致性分数
  agreedDecision?: string;
  disagreementSummary?: string;
  createdAt: string;
  completedAt?: string;
  requiresDiscussion: boolean;
  isLowConfidence?: boolean;
}

export interface ConsensusConfig {
  minVoters: number;
  agreementThreshold: number;      // 达到共识的阈值
  strongAgreementThreshold: number; // 强共识阈值
  lowConsensusThreshold: number;   // 低共识阈值
  timeoutMs: number;
  enableDiscussion: boolean;
}

export interface ConsensusResult {
  decision: string;
  consensusLevel: ConsensusLevel;
  consensusScore: number;
  confidence: 'high' | 'medium' | 'low';
  requiresAction: boolean;
  actionType?: 'proceed' | 'discuss' | 'rethink' | 'escalate';
}

// ========================================
// Default Configuration
// ========================================

const DEFAULT_CONFIG: ConsensusConfig = {
  minVoters: 3,
  agreementThreshold: 0.8,
  strongAgreementThreshold: 0.95,
  lowConsensusThreshold: 0.5,
  timeoutMs: 30000,
  enableDiscussion: true
};

// ========================================
// Consensus Check Implementation
// ========================================

export class ConsensusChecker {
  private checks: Map<string, ConsensusCheck> = new Map();
  private config: ConsensusConfig;

  constructor(config?: Partial<ConsensusConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 创建共识检查
   */
  createCheck(question: string, context: string = ''): string {
    const check: ConsensusCheck = {
      id: generateUUID(),
      question,
      context,
      votes: [],
      consensusLevel: 'low',
      consensusScore: 0,
      requiresDiscussion: false,
      createdAt: new Date().toISOString()
    };

    this.checks.set(check.id, check);
    return check.id;
  }

  /**
   * 添加投票
   */
  addVote(
    checkId: string,
    modelId: string,
    modelName: string,
    decision: string,
    confidence: number,
    reasoning: string
  ): boolean {
    const check = this.checks.get(checkId);
    if (!check) return false;

    const vote: ModelVote = {
      modelId,
      modelName,
      decision,
      confidence,
      reasoning,
      timestamp: new Date().toISOString()
    };

    check.votes.push(vote);
    this.updateConsensus(check);

    return true;
  }

  /**
   * 更新共识状态
   */
  private updateConsensus(check: ConsensusCheck): void {
    // 计算共识分数（即使投票数不足也计算，但标记为低置信度）
    const scores = this.calculateConsensusScores(check.votes);
    check.consensusScore = scores.overall;
    check.isLowConfidence = check.votes.length < this.config.minVoters;

    // 确定共识级别
    if (scores.overall >= this.config.strongAgreementThreshold) {
      check.consensusLevel = 'unanimous';
    } else if (scores.overall >= this.config.agreementThreshold) {
      check.consensusLevel = 'strong';
    } else if (scores.overall >= this.config.lowConsensusThreshold) {
      check.consensusLevel = 'moderate';
    } else if (scores.overall > 0) {
      check.consensusLevel = 'low';
    } else {
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
    } else {
      check.requiresDiscussion = false;
    }
  }

  /**
   * 计算共识分数
   */
  private calculateConsensusScores(votes: ModelVote[]): {
    overall: number;
    byModel: Map<string, number>;
  } {
    if (votes.length < 2) {
      return { overall: 0, byModel: new Map() };
    }

    // 简单的文本相似度计算
    const decisions = votes.map(v => v.decision.toLowerCase().trim());
    const agreements: number[] = [];

    // 两两比较
    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        agreements.push(this.calculateSimilarity(decisions[i], decisions[j]));
      }
    }

    // 加权平均 (考虑 confidence)
    let weightedSum = 0;
    let weightTotal = 0;
    for (const vote of votes) {
      weightedSum += vote.confidence;
      weightTotal += 1;
    }

    const avgSimilarity = agreements.reduce((a, b) => a + b, 0) / agreements.length;
    const avgConfidence = weightedSum / weightTotal;

    // 综合分数: 相似度 * 0.7 + 置信度 * 0.3
    const overall = avgSimilarity * 0.7 + avgConfidence * 0.3;

    const byModel = new Map<string, number>();
    for (const vote of votes) {
      byModel.set(vote.modelId, vote.confidence);
    }

    return { overall, byModel };
  }

  /**
   * 计算文本相似度
   */
  private calculateSimilarity(text1: string, text2: string): number {
    if (text1 === text2) return 1;
    if (text1.length === 0 || text2.length === 0) return 0;

    // 简单的词集合相似度 (Jaccard)
    const words1 = new Set(text1.split(/\s+/));
    const words2 = new Set(text2.split(/\s+/));

    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);

    return intersection.size / union.size;
  }

  /**
   * 选择共同决策
   */
  private selectAgreedDecision(votes: ModelVote[], scores: { overall: number; byModel: Map<string, number> }): string {
    // 按置信度排序
    const sorted = [...votes].sort((a, b) => b.confidence - a.confidence);
    
    // 找最高置信度的决策
    return sorted[0].decision;
  }

  /**
   * 总结分歧
   */
  private summarizeDisagreements(votes: ModelVote[]): string {
    const disagreements: string[] = [];
    
    for (const vote of votes) {
      disagreements.push(`[${vote.modelName}] ${vote.decision}: ${vote.reasoning}`);
    }

    return disagreements.join('\n---\n');
  }

  /**
   * 完成检查
   */
  completeCheck(checkId: string): ConsensusCheck | undefined {
    const check = this.checks.get(checkId);
    if (check) {
      check.completedAt = new Date().toISOString();
    }
    return check;
  }

  /**
   * 获取检查结果
   */
  getCheck(checkId: string): ConsensusCheck | undefined {
    return this.checks.get(checkId);
  }

  /**
   * 获取共识结果 (用于决策)
   */
  getResult(checkId: string): ConsensusResult | undefined {
    const check = this.checks.get(checkId);
    if (!check) return undefined;

    const result: ConsensusResult = {
      decision: check.agreedDecision || check.votes[0].decision,
      consensusLevel: check.consensusLevel,
      consensusScore: check.consensusScore,
      confidence: this.scoreToConfidence(check.consensusScore),
      requiresAction: true,
      actionType: this.determineAction(check)
    };

    return result;
  }

  /**
   * 分数转置信度
   */
  private scoreToConfidence(score: number): 'high' | 'medium' | 'low' {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  }

  /**
   * 确定需要采取的行动
   */
  private determineAction(check: ConsensusCheck): ConsensusResult['actionType'] {
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
  async waitForVotes(checkId: string): Promise<ConsensusCheck | null> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < this.config.timeoutMs) {
      const check = this.checks.get(checkId);
      if (check && check.votes.length >= this.config.minVoters) {
        return check;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return null; // 超时
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalChecks: number;
    completedChecks: number;
    averageConsensusScore: number;
    byLevel: Record<ConsensusLevel, number>;
  } {
    const checks = Array.from(this.checks.values());
    const completed = checks.filter(c => c.completedAt);

    const avgScore = completed.length > 0
      ? completed.reduce((sum, c) => sum + c.consensusScore, 0) / completed.length
      : 0;

    const byLevel: Record<ConsensusLevel, number> = {
      unanimous: 0,
      strong: 0,
      moderate: 0,
      low: 0,
      diverged: 0
    };

    for (const check of completed) {
      byLevel[check.consensusLevel]++;
    }

    return {
      totalChecks: checks.length,
      completedChecks: completed.length,
      averageConsensusScore: avgScore,
      byLevel
    };
  }

  /**
   * 清除旧检查
   */
  clearOldChecks(olderThanMs: number = 3600000): number {
    const threshold = Date.now() - olderThanMs;
    let removed = 0;

    for (const [id, check] of this.checks.entries()) {
      const created = new Date(check.createdAt).getTime();
      if (created < threshold && check.completedAt) {
        this.checks.delete(id);
        removed++;
      }
    }

    return removed;
  }

  /**
   * 生成报告
   */
  generateReport(checkId: string): string {
    const check = this.checks.get(checkId);
    if (!check) return 'Check not found';

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
      `**Decision**: ${result?.decision || 'Pending'}`,
      `**Confidence**: ${result?.confidence || 'N/A'}`,
      `**Action**: ${result?.actionType || 'N/A'}`,
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

// ========================================
// Factory
// ========================================

let globalChecker: ConsensusChecker | null = null;

export function getGlobalConsensusChecker(): ConsensusChecker {
  if (!globalChecker) {
    globalChecker = new ConsensusChecker();
  }
  return globalChecker;
}

export function createConsensusChecker(config?: Partial<ConsensusConfig>): ConsensusChecker {
  return new ConsensusChecker(config);
}