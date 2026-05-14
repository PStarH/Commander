/**
 * Token Budget Allocator
 * 基于 ULTIMATE-FRAMEWORK.md 设计
 * 
 * Core insight: 根据任务复杂度智能分配 token 预算
 * - 阶段化预算分配
 * - 实时预算监控
 * - 超预算自动截断
 */

import { OrchestrationMode } from './adaptiveOrchestrator';

// ========================================
// Types
// ========================================

export interface TokenBudget {
  total: number;
  leadAgent: number;
  specialistAgents: number;
  evaluation: number;
  overhead: number;
  reserved: number;  // 保留的 buffer
}

export interface BudgetAllocation {
  phase: 'planning' | 'execution' | 'evaluation' | 'reporting';
  allocated: number;
  used: number;
  remaining: number;
  efficiency: number;  // 0-1
}

export interface BudgetSnapshot {
  timestamp: string;
  totalBudget: number;
  totalUsed: number;
  totalRemaining: number;
  byPhase: BudgetAllocation[];
  byAgent: Map<string, number>;
}

export interface BudgetConfig {
  baseBudget: number;
  maxBudget: number;
  efficiencyTarget: number;  // 目标效率
  reserveRatio: number;      // 保留比例
  warnThreshold: number;     // 警告阈值 (0-1)
  cutoffThreshold: number;   // 截断阈值 (0-1)
}

// ========================================
// Budget Allocator
// ========================================

export class TokenBudgetAllocator {
  private config: BudgetConfig;
  private totalBudget: number;
  private usedBudget: number = 0;
  private agentBudgets: Map<string, number> = new Map();
  private phaseAllocations: Map<string, BudgetAllocation> = new Map();
  private history: BudgetSnapshot[] = [];

  constructor(config?: Partial<BudgetConfig>) {
    this.config = {
      baseBudget: config?.baseBudget ?? 100000,
      maxBudget: config?.maxBudget ?? 500000,
      efficiencyTarget: config?.efficiencyTarget ?? 0.85,
      reserveRatio: config?.reserveRatio ?? 0.1,
      warnThreshold: config?.warnThreshold ?? 0.8,
      cutoffThreshold: config?.cutoffThreshold ?? 0.95
    };
    this.totalBudget = this.config.baseBudget;
  }

  /**
   * 初始化预算
   */
  initialize(totalBudget: number): void {
    this.totalBudget = Math.min(totalBudget, this.config.maxBudget);
    this.usedBudget = 0;
    this.agentBudgets.clear();
    this.phaseAllocations.clear();
  }

  /**
   * 根据编排模式和任务复杂度分配预算
   */
  allocate(mode: OrchestrationMode, complexity: number, agentCount: number): TokenBudget {
    // 根据复杂度调整基础预算
    const complexityMultiplier = 1 + (complexity / 100) * 2;  // 1x - 3x
    let baseBudget = this.totalBudget * complexityMultiplier;

    // 根据模式调整分配比例
    const ratios = this.getAllocationRatios(mode);

    // 计算各部分预算
    const leadAgent = Math.floor(baseBudget * ratios.lead);
    const specialistAgents = Math.floor(baseBudget * ratios.specialists);
    const evaluation = Math.floor(baseBudget * ratios.evaluation);
    const overhead = Math.floor(baseBudget * ratios.overhead);
    const reserved = Math.floor(baseBudget * this.config.reserveRatio);

    const budget: TokenBudget = {
      total: baseBudget,
      leadAgent,
      specialistAgents,
      evaluation,
      overhead,
      reserved
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
  private getAllocationRatios(mode: OrchestrationMode): {
    lead: number;
    specialists: number;
    evaluation: number;
    overhead: number;
  } {
    switch (mode) {
      case 'SEQUENTIAL':
        return { lead: 0.7, specialists: 0.1, evaluation: 0.15, overhead: 0.05 };
      
      case 'PARALLEL':
        return { lead: 0.25, specialists: 0.55, evaluation: 0.15, overhead: 0.05 };
      
      case 'HANDOFF':
        return { lead: 0.35, specialists: 0.45, evaluation: 0.15, overhead: 0.05 };
      
      case 'MAGENTIC':
        return { lead: 0.3, specialists: 0.40, evaluation: 0.15, overhead: 0.15 };
      
      case 'CONSENSUS':
        return { lead: 0.25, specialists: 0.30, evaluation: 0.40, overhead: 0.05 };
      
      default:
        return { lead: 0.4, specialists: 0.4, evaluation: 0.15, overhead: 0.05 };
    }
  }

  /**
   * 分配预算给各 agent
   */
  private distributeToAgents(budget: TokenBudget, agentCount: number): void {
    this.agentBudgets.clear();

    if (agentCount === 0) return;

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
  private initializePhaseAllocations(budget: TokenBudget): void {
    const phases: Array<'planning' | 'execution' | 'evaluation' | 'reporting'> = 
      ['planning', 'execution', 'evaluation', 'reporting'];

    const phaseRatios = {
      planning: 0.1,
      execution: 0.6,
      evaluation: 0.2,
      reporting: 0.1
    };

    for (const phase of phases) {
      this.phaseAllocations.set(phase, {
        phase,
        allocated: Math.floor(budget.total * phaseRatios[phase]),
        used: 0,
        remaining: Math.floor(budget.total * phaseRatios[phase]),
        efficiency: 1.0
      });
    }
  }

  /**
   * 记录 token 使用
   */
  recordUsage(agentId: string, tokens: number, phase?: string): void {
    this.usedBudget += tokens;

    // 更新 agent 使用
    const current = this.agentBudgets.get(agentId) || 0;
    this.agentBudgets.set(agentId, current + tokens);

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
  getRemaining(): number {
    return Math.max(0, this.totalBudget - this.usedBudget);
  }

  /**
   * 获取使用率
   */
  getUsageRate(): number {
    return this.totalBudget > 0 ? this.usedBudget / this.totalBudget : 0;
  }

  /**
   * 检查是否超过阈值
   */
  isWarningThreshold(): boolean {
    return this.getUsageRate() >= this.config.warnThreshold;
  }

  isCutoffThreshold(): boolean {
    return this.getUsageRate() >= this.config.cutoffThreshold;
  }

  /**
   * 获取 agent 剩余预算
   */
  getAgentRemaining(agentId: string): number {
    const allocated = this.agentBudgets.get(agentId) || 0;
    // 简单估算：假设已使用 allocated * usageRate
    const estimatedUsed = allocated * this.getUsageRate();
    return Math.max(0, allocated - estimatedUsed);
  }

  /**
   * 获取预算警告
   */
  getWarnings(): string[] {
    const warnings: string[] = [];
    const usageRate = this.getUsageRate();

    if (usageRate >= this.config.cutoffThreshold) {
      warnings.push('CRITICAL: Budget almost exhausted!');
    } else if (usageRate >= this.config.warnThreshold) {
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
  getSnapshot(): BudgetSnapshot {
    return {
      timestamp: new Date().toISOString(),
      totalBudget: this.totalBudget,
      totalUsed: this.usedBudget,
      totalRemaining: this.getRemaining(),
      byPhase: Array.from(this.phaseAllocations.values()),
      byAgent: new Map(this.agentBudgets)
    };
  }

  /**
   * 记录历史快照
   */
  private recordSnapshot(): void {
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
  getEfficiencyAnalysis(): {
    overall: number;
    byPhase: Record<string, number>;
    trend: 'improving' | 'declining' | 'stable';
    recommendations: string[];
  } {
    const phases = Array.from(this.phaseAllocations.values());
    const phaseEfficiency: Record<string, number> = {};

    for (const phase of phases) {
      phaseEfficiency[phase.phase] = phase.efficiency;
    }

    const overall = phases.reduce((sum, p) => sum + p.efficiency, 0) / phases.length;

    // 计算趋势
    let trend: 'improving' | 'declining' | 'stable' = 'stable';
    if (this.history.length >= 10) {
      const recent = this.history.slice(-5);
      const older = this.history.slice(-10, -5);
      const recentAvg = recent.reduce((sum, s) => sum + s.totalUsed, 0) / recent.length;
      const olderAvg = older.reduce((sum, s) => sum + s.totalUsed, 0) / older.length;

      if (recentAvg < olderAvg * 0.9) trend = 'improving';
      else if (recentAvg > olderAvg * 1.1) trend = 'declining';
    }

    // 生成建议
    const recommendations: string[] = [];
    if (overall > 0.9) {
      recommendations.push('Consider increasing budget for better results');
    } else if (overall < 0.5) {
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
  reset(): void {
    this.usedBudget = 0;
    this.agentBudgets.clear();
    this.phaseAllocations.clear();
    this.history = [];
  }

  /**
   * 获取配置
   */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }
}

// ========================================
// Factory
// ========================================

let globalAllocator: TokenBudgetAllocator | null = null;

export function getGlobalBudgetAllocator(): TokenBudgetAllocator {
  if (!globalAllocator) {
    globalAllocator = new TokenBudgetAllocator();
  }
  return globalAllocator;
}

export function createBudgetAllocator(config?: Partial<BudgetConfig>): TokenBudgetAllocator {
  return new TokenBudgetAllocator(config);
}