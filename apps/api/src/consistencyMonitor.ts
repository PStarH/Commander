/**
 * Consistency Monitor for Multi-Agent Systems
 *
 * 基于调研: Galileo AI "10 Multi-Agent Coordination Strategies" (2025)
 * 核心问题: Agent 产出矛盾结果 → 解决方案: 持续监控语义一致性
 *
 * 功能:
 * - Real-time consistency checks (实时一致性检测)
 * - Semantic similarity scoring (语义相似度评分)
 * - Byzantine fault-tolerant consensus (拜占庭容错共识)
 * - Agreement score calculation (一致度分数计算)
 *
 * 参考: Research notes 2026-04-10 08:46
 */

// ==================== 类型定义 ====================

/**
 * Agent 输出类型
 */
export type AgentOutputType = 
  | 'decision'      // 决策
  | 'analysis'      // 分析
  | 'recommendation' // 建议
  | 'fact';         // 事实陈述

/**
 * 一致性级别
 */
export type ConsistencyLevel = 
  | 'high'          // 高一致性 (>0.8)
  | 'medium'        // 中等一致性 (0.5-0.8)
  | 'low'           // 低一致性 (0.2-0.5)
  | 'conflicting';  // 冲突 (<0.2)

/**
 * Agent 输出表示
 */
export interface AgentOutput {
  agentId: string;
  taskId?: string;
  missionId?: string;
  type: AgentOutputType;
  content: string;
  timestamp: number;
  metadata?: {
    confidence?: number;
    reasoning?: string;
    sources?: string[];
  };
}

/**
 * 一致性检查配置
 */
export interface ConsistencyMonitorConfig {
  /** 相似度阈值（高于此值视为一致） */
  similarityThreshold: number;
  /** 冲突阈值（低于此值视为冲突） */
  conflictThreshold: number;
  /** 检查窗口大小（最近 N 条输出） */
  windowSize: number;
  /** 是否启用拜占庭容错 */
  enableBFT: boolean;
  /** BFT 最小节点数 */
  bftMinNodes?: number;
  /** 一致性回调 */
  onConsistencyChange?: (level: ConsistencyLevel, details: ConsistencyReport) => void;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ConsistencyMonitorConfig = {
  similarityThreshold: 0.8,
  conflictThreshold: 0.2,
  windowSize: 10,
  enableBFT: true,
  bftMinNodes: 4, // BFT requires N >= 3f+1
};

/**
 * 一致性报告
 */
export interface ConsistencyReport {
  /** 检查的时间戳 */
  timestamp: number;
  /** 涉及的 agent 数量 */
  agentCount: number;
  /** 一致性级别 */
  consistencyLevel: ConsistencyLevel;
  /** 一致度分数 (0-1) */
  agreementScore: number;
  /** 语义相似度矩阵 */
  similarityMatrix: number[][];
  /** 检测到的冲突 */
  conflicts: ConsistencyConflict[];
  /** 共识结果（如果有） */
  consensus?: {
    agreedOutput: string;
    supportingAgents: string[];
    opposingAgents: string[];
    confidence: number;
  };
  /** BFT 状态 */
  bftStatus?: {
    totalNodes: number;
    faultyNodes: number;
    toleratedFaults: number;
    hasConsensus: boolean;
  };
}

/**
 * 一致性冲突
 */
export interface ConsistencyConflict {
  agentIds: string[];
  conflictType: 'semantic' | 'logical' | 'factual';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  outputs: AgentOutput[];
  suggestedResolution?: string;
}

/**
 * 一致性快照（用于历史追踪）
 */
export interface ConsistencySnapshot {
  timestamp: number;
  missionId?: string;
  report: ConsistencyReport;
}

// ==================== 核心类 ====================

/**
 * 一致性监控器
 *
 * 实时监控多个 Agent 输出的语义一致性
 */
export class ConsistencyMonitor {
  private config: ConsistencyMonitorConfig;
  private outputHistory: Map<string, AgentOutput[]> = new Map();
  private snapshots: ConsistencySnapshot[] = [];
  private lastReport?: ConsistencyReport;

  constructor(config: Partial<ConsistencyMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==================== 核心操作 ====================

  /**
   * 记录 Agent 输出
   */
  recordOutput(output: AgentOutput): void {
    const agentOutputs = this.outputHistory.get(output.agentId) || [];
    agentOutputs.push(output);
    
    // 保持窗口大小
    if (agentOutputs.length > this.config.windowSize) {
      agentOutputs.shift();
    }
    
    this.outputHistory.set(output.agentId, agentOutputs);
  }

  /**
   * 检查一致性
   */
  checkConsistency(missionId?: string): ConsistencyReport {
    const timestamp = Date.now();
    const allOutputs = this.getRecentOutputs();
    const agentIds = Array.from(this.outputHistory.keys());
    
    // 1. 构建相似度矩阵
    const similarityMatrix = this.buildSimilarityMatrix(allOutputs);
    
    // 2. 计算一致度分数
    const agreementScore = this.calculateAgreementScore(similarityMatrix);
    
    // 3. 确定一致性级别
    const consistencyLevel = this.determineConsistencyLevel(agreementScore);
    
    // 4. 检测冲突
    const conflicts = this.detectConflicts(allOutputs, similarityMatrix);
    
    // 5. 尝试达成共识
    const consensus = this.attemptConsensus(allOutputs, agreementScore);
    
    // 6. BFT 检查（如果启用）
    const bftStatus = this.config.enableBFT 
      ? this.checkBFTStatus(agentIds.length, conflicts)
      : undefined;
    
    // 构建报告
    const report: ConsistencyReport = {
      timestamp,
      agentCount: agentIds.length,
      consistencyLevel,
      agreementScore,
      similarityMatrix,
      conflicts,
      consensus,
      bftStatus,
    };
    
    // 触发回调
    if (this.config.onConsistencyChange && 
        (!this.lastReport || this.lastReport.consistencyLevel !== consistencyLevel)) {
      this.config.onConsistencyChange(consistencyLevel, report);
    }
    
    // 保存快照
    this.snapshots.push({
      timestamp,
      missionId,
      report,
    });
    
    this.lastReport = report;
    return report;
  }

  /**
   * 获取最近的输出
   */
  private getRecentOutputs(): AgentOutput[] {
    const recent: AgentOutput[] = [];
    for (const outputs of this.outputHistory.values()) {
      if (outputs.length > 0) {
        recent.push(outputs[outputs.length - 1]);
      }
    }
    return recent;
  }

  // ==================== 相似度计算 ====================

  /**
   * 构建相似度矩阵
   */
  private buildSimilarityMatrix(outputs: AgentOutput[]): number[][] {
    const n = outputs.length;
    const matrix: number[][] = Array(n).fill(null).map(() => Array(n).fill(0));
    
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        if (i === j) {
          matrix[i][j] = 1.0;
        } else {
          const similarity = this.calculateSemanticSimilarity(
            outputs[i].content,
            outputs[j].content
          );
          matrix[i][j] = similarity;
          matrix[j][i] = similarity;
        }
      }
    }
    
    return matrix;
  }

  /**
   * 计算语义相似度（简化版）
   * 
   * 实际生产环境应使用:
   * - OpenAI embeddings (text-embedding-3-small)
   * - HuggingFace sentence-transformers
   * - BM25 + semantic reranking
   */
  private calculateSemanticSimilarity(text1: string, text2: string): number {
    // 简化实现: 基于 Jaccard 相似度 + 词频
    const words1 = new Set(text1.toLowerCase().split(/\s+/));
    const words2 = new Set(text2.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    const jaccard = intersection.size / union.size;
    
    // 添加长度相似度因子
    const lengthRatio = Math.min(text1.length, text2.length) / 
                        Math.max(text1.length, text2.length);
    
    // 综合相似度
    return 0.7 * jaccard + 0.3 * lengthRatio;
  }

  /**
   * 计算一致度分数
   */
  private calculateAgreementScore(similarityMatrix: number[][]): number {
    const n = similarityMatrix.length;
    if (n <= 1) return 1.0;
    
    // 计算平均相似度（排除对角线）
    let totalSimilarity = 0;
    let count = 0;
    
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        totalSimilarity += similarityMatrix[i][j];
        count++;
      }
    }
    
    return count > 0 ? totalSimilarity / count : 1.0;
  }

  /**
   * 确定一致性级别
   */
  private determineConsistencyLevel(score: number): ConsistencyLevel {
    if (score >= this.config.similarityThreshold) {
      return 'high';
    } else if (score >= 0.5) {
      return 'medium';
    } else if (score >= this.config.conflictThreshold) {
      return 'low';
    } else {
      return 'conflicting';
    }
  }

  // ==================== 冲突检测 ====================

  /**
   * 检测冲突
   */
  private detectConflicts(
    outputs: AgentOutput[],
    similarityMatrix: number[][]
  ): ConsistencyConflict[] {
    const conflicts: ConsistencyConflict[] = [];
    const n = outputs.length;
    
    // 检测两两冲突
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const similarity = similarityMatrix[i][j];
        
        if (similarity < this.config.conflictThreshold) {
          conflicts.push({
            agentIds: [outputs[i].agentId, outputs[j].agentId],
            conflictType: 'semantic',
            severity: similarity < 0.1 ? 'critical' : 'high',
            description: `Agent ${outputs[i].agentId} and ${outputs[j].agentId} have conflicting outputs`,
            outputs: [outputs[i], outputs[j]],
            suggestedResolution: 'Escalate to human review or use consensus voting',
          });
        }
      }
    }
    
    return conflicts;
  }

  // ==================== 共识机制 ====================

  /**
   * 尝试达成共识
   */
  private attemptConsensus(
    outputs: AgentOutput[],
    agreementScore: number
  ): ConsistencyReport['consensus'] | undefined {
    if (outputs.length === 0) return undefined;
    
    // 如果一致度足够高，直接取多数
    if (agreementScore >= this.config.similarityThreshold) {
      // 找到最代表性的输出（与所有其他输出最相似的）
      const mostRepresentative = this.findMostRepresentativeOutput(outputs);
      
      return {
        agreedOutput: mostRepresentative.content,
        supportingAgents: outputs.map(o => o.agentId),
        opposingAgents: [],
        confidence: agreementScore,
      };
    }
    
    // 如果一致度中等，尝试投票
    if (agreementScore >= 0.5 && outputs.length >= 3) {
      return this.voteConsensus(outputs);
    }
    
    // 一致度太低，无法达成共识
    return undefined;
  }

  /**
   * 找到最代表性的输出
   */
  private findMostRepresentativeOutput(outputs: AgentOutput[]): AgentOutput {
    if (outputs.length === 1) return outputs[0];
    
    // 计算每个输出与其他输出的平均相似度
    let bestOutput = outputs[0];
    let bestAvgSimilarity = 0;
    
    for (let i = 0; i < outputs.length; i++) {
      let totalSim = 0;
      for (let j = 0; j < outputs.length; j++) {
        if (i !== j) {
          totalSim += this.calculateSemanticSimilarity(
            outputs[i].content,
            outputs[j].content
          );
        }
      }
      const avgSim = totalSim / (outputs.length - 1);
      
      if (avgSim > bestAvgSimilarity) {
        bestAvgSimilarity = avgSim;
        bestOutput = outputs[i];
      }
    }
    
    return bestOutput;
  }

  /**
   * 投票共识
   */
  private voteConsensus(outputs: AgentOutput[]): ConsistencyReport['consensus'] {
    // 按 content 分组
    const groups = new Map<string, AgentOutput[]>();
    
    for (const output of outputs) {
      // 简化: 实际应使用聚类算法
      let matched = false;
      for (const [key, group] of groups) {
        if (this.calculateSemanticSimilarity(output.content, key) >= 0.7) {
          group.push(output);
          matched = true;
          break;
        }
      }
      
      if (!matched) {
        groups.set(output.content, [output]);
      }
    }
    
    // 找到最大的组
    let largestGroup = Array.from(groups.values())[0];
    for (const group of groups.values()) {
      if (group.length > largestGroup.length) {
        largestGroup = group;
      }
    }
    
    const supportingAgents = largestGroup.map(o => o.agentId);
    const opposingAgents = outputs
      .filter(o => !supportingAgents.includes(o.agentId))
      .map(o => o.agentId);
    
    return {
      agreedOutput: largestGroup[0].content,
      supportingAgents,
      opposingAgents,
      confidence: supportingAgents.length / outputs.length,
    };
  }

  // ==================== BFT 检查 ====================

  /**
   * 检查拜占庭容错状态
   */
  private checkBFTStatus(
    totalNodes: number,
    conflicts: ConsistencyConflict[]
  ): ConsistencyReport['bftStatus'] {
    // 计算可能的故障节点数
    const faultyNodes = new Set<string>();
    for (const conflict of conflicts) {
      if (conflict.severity === 'critical' || conflict.severity === 'high') {
        conflict.agentIds.forEach(id => faultyNodes.add(id));
      }
    }
    
    const f = faultyNodes.size;
    const toleratedFaults = Math.floor((totalNodes - 1) / 3);
    
    return {
      totalNodes,
      faultyNodes: f,
      toleratedFaults,
      hasConsensus: f <= toleratedFaults,
    };
  }

  // ==================== 查询操作 ====================

  /**
   * 获取最新报告
   */
  getLastReport(): ConsistencyReport | undefined {
    return this.lastReport;
  }

  /**
   * 获取历史快照
   */
  getSnapshots(limit?: number): ConsistencySnapshot[] {
    if (limit) {
      return this.snapshots.slice(-limit);
    }
    return [...this.snapshots];
  }

  /**
   * 获取 Agent 输出历史
   */
  getAgentOutputHistory(agentId: string): AgentOutput[] {
    return this.outputHistory.get(agentId) || [];
  }

  /**
   * 清除历史
   */
  clearHistory(): void {
    this.outputHistory.clear();
    this.snapshots = [];
    this.lastReport = undefined;
  }
}

// ==================== 管理器 ====================

/**
 * 一致性监控管理器
 *
 * 管理多个 Mission 的一致性监控实例
 */
export class ConsistencyMonitorManager {
  private monitors: Map<string, ConsistencyMonitor> = new Map();
  private globalConfig: Partial<ConsistencyMonitorConfig> = {};

  /**
   * 设置全局配置
   */
  setGlobalConfig(config: Partial<ConsistencyMonitorConfig>): void {
    this.globalConfig = config;
  }

  /**
   * 获取或创建监控器
   */
  getMonitor(missionId: string): ConsistencyMonitor {
    let monitor = this.monitors.get(missionId);
    
    if (!monitor) {
      monitor = new ConsistencyMonitor(this.globalConfig);
      this.monitors.set(missionId, monitor);
    }
    
    return monitor;
  }

  /**
   * 记录输出到指定 Mission
   */
  recordOutput(missionId: string, output: AgentOutput): void {
    const monitor = this.getMonitor(missionId);
    monitor.recordOutput(output);
  }

  /**
   * 检查指定 Mission 的一致性
   */
  checkConsistency(missionId: string): ConsistencyReport {
    const monitor = this.getMonitor(missionId);
    return monitor.checkConsistency(missionId);
  }

  /**
   * 获取所有 Mission 的一致性状态
   */
  getAllConsistencyStatus(): Map<string, ConsistencyReport> {
    const status = new Map<string, ConsistencyReport>();
    
    for (const [missionId, monitor] of this.monitors) {
      const lastReport = monitor.getLastReport();
      if (lastReport) {
        status.set(missionId, lastReport);
      }
    }
    
    return status;
  }

  /**
   * 清除指定 Mission 的历史
   */
  clearMission(missionId: string): void {
    const monitor = this.monitors.get(missionId);
    if (monitor) {
      monitor.clearHistory();
    }
  }

  /**
   * 清除所有历史
   */
  clearAll(): void {
    for (const monitor of this.monitors.values()) {
      monitor.clearHistory();
    }
  }
}

// ==================== 单例导出 ====================

let globalManager: ConsistencyMonitorManager | null = null;

/**
 * 获取全局一致性监控管理器
 */
export function getConsistencyMonitorManager(): ConsistencyMonitorManager {
  if (!globalManager) {
    globalManager = new ConsistencyMonitorManager();
  }
  return globalManager;
}

/**
 * 重置全局管理器（用于测试）
 */
export function resetConsistencyMonitorManager(): void {
  if (globalManager) {
    globalManager.clearAll();
    globalManager = null;
  }
}
