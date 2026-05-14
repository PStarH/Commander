/**
 * Agent Self-Assessment - 元认知层核心组件
 *
 * 基于 research-notes.md 最新调研 "Agent Metacognition and Self-Awareness Mechanisms"
 *
 * 核心功能:
 * 1. 动态能力评估 - Agent 执行前评估置信度
 * 2. 多维度评分 - 分解能力为 sub-skills (coding/reasoning/research 等)
 * 3. 置信度校准 - 基于历史成功率调整
 * 4. 能力边界可视化 - 用于 Battle Report
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

/** 能力子维度 */
export type SkillDimension =
  | 'coding'
  | 'reasoning'
  | 'research'
  | 'writing'
  | 'analysis'
  | 'debugging'
  | 'planning'
  | 'review';

/** 任务风险级别 */
export type TaskRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** 任务复杂度 */
export type TaskComplexity = 'TRIVIAL' | 'SIMPLE' | 'MODERATE' | 'COMPLEX' | 'EXPERT';

/** 评估结果 */
export interface SelfAssessment {
  id: string;
  agentId: string;
  taskDescription: string;
  overallConfidence: number; // 0-1
  complexity: TaskComplexity;
  riskLevel: TaskRiskLevel;
  dimensions: SkillAssessment[];
  shouldEscalate: boolean;
  escalateReason?: string;
  recommendedMode: 'fast' | 'verify' | 'extended';
  createdAt: string;
}

/** 单个能力维度评估 */
export interface SkillAssessment {
  dimension: SkillDimension;
  confidence: number; // 0-1
  evidence: string[];
  historicalSuccessRate: number;
}

/** 能力卡片 - 用于 Battle Report 可视化 */
export interface AgentCapabilityCard {
  agentId: string;
  agentName: string;
  updatedAt: string;
  overallConfidence: number;
  dimensions: SkillDimensionSnapshot[];
  recentEscalations: number;
  calibrationQuality: 'well_calibrated' | 'overconfident' | 'underconfident';
  canHandle: TaskComplexity[];
  cannotHandle: TaskComplexity[];
}

/** 能力维度快照 */
export interface SkillDimensionSnapshot {
  dimension: SkillDimension;
  confidence: number;
  successRate: number;
  taskCount: number;
}

/** 评估历史记录 */
export interface AssessmentRecord {
  id: string;
  agentId: string;
  taskDescription: string;
  predictedConfidence: number;
  actualOutcome: 'success' | 'partial' | 'failure';
  calibratedConfidence: number;
  wasCorrect: boolean; // 预测是否准确
  createdAt: string;
}

// ========================================
// Skill Dimension Metadata
// ========================================

const SKILL_DIMENSIONS: SkillDimension[] = [
  'coding',
  'reasoning',
  'research',
  'writing',
  'analysis',
  'debugging',
  'planning',
  'review',
];

const SKILL_WEIGHTS: Record<SkillDimension, number> = {
  coding: 0.15,
  reasoning: 0.15,
  research: 0.12,
  writing: 0.10,
  analysis: 0.13,
  debugging: 0.12,
  planning: 0.13,
  review: 0.10,
};

const CONFIDENCE_THRESHOLDS = {
  high: 0.80, // 直接执行
  medium: 0.55, // 执行 + 验证步骤
  low: 0.35, // 请求确认或额外信息
  veryLow: 0.15, // 拒绝 + 解释原因，或升级
};

const COMPLEXITY_THRESHOLDS = {
  TRIVIAL: 0.10,
  SIMPLE: 0.30,
  MODERATE: 0.55,
  COMPLEX: 0.75,
  EXPERT: 0.90,
};

// ========================================
// Agent Self-Assessment Engine
// ========================================

export class AgentSelfAssessmentEngine {
  private assessmentHistory: AssessmentRecord[] = [];
  private skillHistories: Map<string, Map<SkillDimension, number[]>> = new Map();
  private readonly MAX_HISTORY = 500;

  constructor(private agentId: string, private agentName: string) {}

  /**
   * 执行自我评估
   * Agent 在执行任务前调用此方法，获得置信度和建议
   */
  assess(taskDescription: string, requiredSkills: SkillDimension[]): SelfAssessment {
    const id = generateUUID();

    // 1. 分析任务复杂度
    const complexity = this.estimateComplexity(taskDescription, requiredSkills);

    // 2. 评估各维度置信度
    const dimensions = this.assessDimensions(requiredSkills);

    // 3. 计算整体置信度 (加权平均)
    const overallConfidence = this.calculateOverallConfidence(dimensions);

    // 4. 评估任务风险
    const riskLevel = this.assessRisk(taskDescription, complexity);

    // 5. 决定是否需要升级
    const { shouldEscalate, escalateReason } = this.shouldEscalate(
      overallConfidence,
      complexity,
      riskLevel
    );

    // 6. 推荐执行模式
    const recommendedMode = this.recommendMode(
      overallConfidence,
      complexity,
      shouldEscalate
    );

    return {
      id,
      agentId: this.agentId,
      taskDescription,
      overallConfidence,
      complexity,
      riskLevel,
      dimensions,
      shouldEscalate,
      escalateReason,
      recommendedMode,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * 记录评估结果 - 用于校准
   * 任务完成后调用，传入实际结果
   */
  recordOutcome(
    assessmentId: string,
    predictedConfidence: number,
    actualOutcome: 'success' | 'partial' | 'failure'
  ): void {
    const outcomeMap = { success: 1.0, partial: 0.5, failure: 0.0 };
    const actualScore = outcomeMap[actualOutcome];
    const wasCorrect = Math.abs(predictedConfidence - actualScore) < 0.2;

    const record: AssessmentRecord = {
      id: assessmentId,
      agentId: this.agentId,
      taskDescription: '',
      predictedConfidence,
      actualOutcome,
      calibratedConfidence: actualScore,
      wasCorrect,
      createdAt: new Date().toISOString(),
    };

    this.assessmentHistory.push(record);

    // 维护历史记录上限
    if (this.assessmentHistory.length > this.MAX_HISTORY) {
      this.assessmentHistory = this.assessmentHistory.slice(-this.MAX_HISTORY);
    }

    // 更新技能历史
    this.updateSkillHistories(actualScore);
  }

  /**
   * 生成能力卡片 - 用于 Battle Report
   */
  getCapabilityCard(): AgentCapabilityCard {
    const recentEscalations = this.assessmentHistory
      .slice(-20)
      .filter((r) => r.predictedConfidence < CONFIDENCE_THRESHOLDS.low).length;

    const calibrationQuality = this.getCalibrationQuality();

    const dimensions = SKILL_DIMENSIONS.map((dim) => {
      const history = this.skillHistories.get(this.agentId)?.get(dim) ?? [];
      const avgSuccess = history.length > 0
        ? history.reduce((a, b) => a + b, 0) / history.length
        : 0.5;
      const confidence = Math.min(0.95, Math.max(0.1, avgSuccess));
      return {
        dimension: dim,
        confidence,
        successRate: avgSuccess,
        taskCount: history.length,
      };
    });

    const overallConfidence = dimensions.reduce(
      (sum, d) => sum + d.confidence * SKILL_WEIGHTS[d.dimension],
      0
    );

    const canHandle: TaskComplexity[] = [];
    const cannotHandle: TaskComplexity[] = [];

    for (const [name, threshold] of Object.entries(COMPLEXITY_THRESHOLDS)) {
      const complexity = name as TaskComplexity;
      if (overallConfidence >= threshold) {
        if (!canHandle.includes(complexity)) canHandle.push(complexity);
      } else {
        if (!cannotHandle.includes(complexity)) cannotHandle.push(complexity);
      }
    }

    return {
      agentId: this.agentId,
      agentName: this.agentName,
      updatedAt: new Date().toISOString(),
      overallConfidence,
      dimensions,
      recentEscalations,
      calibrationQuality,
      canHandle,
      cannotHandle,
    };
  }

  // ---- Private Methods ----

  private estimateComplexity(
    taskDescription: string,
    requiredSkills: SkillDimension[]
  ): TaskComplexity {
    // 简单的启发式复杂度评估
    const text = taskDescription.toLowerCase();
    let score = 0;

    // 基于关键词的复杂度评分
    if (text.includes('debug') || text.includes('fix') || text.includes('error')) {
      score += 0.1;
    }
    if (text.includes('design') || text.includes('architect') || text.includes('plan')) {
      score += 0.2;
    }
    if (text.includes('research') || text.includes('investigate') || text.includes('analyze')) {
      score += 0.15;
    }
    if (text.includes('optimize') || text.includes('refactor') || text.includes('improve')) {
      score += 0.2;
    }
    if (text.includes('security') || text.includes('audit') || text.includes('compliance')) {
      score += 0.25;
    }
    if (text.includes('multi') || text.includes('cross') || text.includes('integrat')) {
      score += 0.15;
    }
    if (text.includes('expert') || text.includes('specialist') || text.includes('advanced')) {
      score += 0.2;
    }

    // 基于技能数量
    score += requiredSkills.length * 0.05;

    // 基于描述长度
    const wordCount = taskDescription.split(/\s+/).length;
    if (wordCount > 100) score += 0.1;
    if (wordCount > 300) score += 0.15;

    // 映射到复杂度级别
    score = Math.min(1.0, score);

    if (score < COMPLEXITY_THRESHOLDS.TRIVIAL) return 'TRIVIAL';
    if (score < COMPLEXITY_THRESHOLDS.SIMPLE) return 'SIMPLE';
    if (score < COMPLEXITY_THRESHOLDS.MODERATE) return 'MODERATE';
    if (score < COMPLEXITY_THRESHOLDS.COMPLEX) return 'COMPLEX';
    return 'EXPERT';
  }

  private assessDimensions(requiredSkills: SkillDimension[]): SkillAssessment[] {
    return requiredSkills.map((dimension) => {
      const history = this.skillHistories.get(this.agentId)?.get(dimension) ?? [];
      const historicalSuccessRate = history.length > 0
        ? history.reduce((a, b) => a + b, 0) / history.length
        : 0.5;

      // 基于历史的置信度，加上一些基础值
      const confidence = Math.min(
        0.95,
        Math.max(0.15, historicalSuccessRate + (Math.random() * 0.1 - 0.05))
      );

      const evidence: string[] = [];
      if (history.length > 0) {
        evidence.push(`${history.length} past tasks with ${(historicalSuccessRate * 100).toFixed(0)}% success`);
      } else {
        evidence.push('No historical data available');
      }

      return {
        dimension,
        confidence,
        evidence,
        historicalSuccessRate,
      };
    });
  }

  private calculateOverallConfidence(dimensions: SkillAssessment[]): number {
    if (dimensions.length === 0) return 0.5;

    return dimensions.reduce(
      (sum, d) => sum + d.confidence * SKILL_WEIGHTS[d.dimension],
      0
    );
  }

  private assessRisk(taskDescription: string, complexity: TaskComplexity): TaskRiskLevel {
    const text = taskDescription.toLowerCase();

    // 高风险关键词
    const highRiskPatterns = [
      'delete', 'remove', 'drop', 'destroy',
      'security', 'auth', 'permission', 'access control',
      'payment', 'transaction', 'money', 'cost',
      'production', 'deploy', 'release',
      'database', 'schema', 'migration',
      'api key', 'secret', 'credential', 'password',
    ];

    const criticalRiskPatterns = [
      'rm -rf', 'drop table', 'delete collection',
      'sudo', 'root', 'admin',
      'financial', 'transaction', 'payment processing',
    ];

    let riskScore = 0;

    for (const pattern of highRiskPatterns) {
      if (text.includes(pattern)) riskScore += 1;
    }
    for (const pattern of criticalRiskPatterns) {
      if (text.includes(pattern)) riskScore += 2;
    }

    // 复杂度贡献
    const complexityScore = {
      TRIVIAL: 0,
      SIMPLE: 0,
      MODERATE: 1,
      COMPLEX: 2,
      EXPERT: 3,
    }[complexity];

    riskScore += complexityScore;

    if (riskScore >= 4) return 'CRITICAL';
    if (riskScore >= 2) return 'HIGH';
    if (riskScore >= 1) return 'MEDIUM';
    return 'LOW';
  }

  private shouldEscalate(
    confidence: number,
    complexity: TaskComplexity,
    riskLevel: TaskRiskLevel
  ): { shouldEscalate: boolean; escalateReason?: string } {
    // 置信度太低
    if (confidence < CONFIDENCE_THRESHOLDS.veryLow) {
      return {
        shouldEscalate: true,
        escalateReason: `Confidence ${(confidence * 100).toFixed(0)}% is below minimum threshold`,
      };
    }

    // 超出能力范围
    const capabilityThreshold = COMPLEXITY_THRESHOLDS[complexity];
    if (confidence < capabilityThreshold * 0.7) {
      return {
        shouldEscalate: true,
        escalateReason: `Confidence ${(confidence * 100).toFixed(0)}% too low for ${complexity} complexity task`,
      };
    }

    // 高风险 + 中低置信度
    if (riskLevel === 'CRITICAL' && confidence < CONFIDENCE_THRESHOLDS.high) {
      return {
        shouldEscalate: true,
        escalateReason: `CRITICAL risk task requires high confidence`,
      };
    }

    // EXPERT 复杂度
    if (complexity === 'EXPERT' && confidence < 0.75) {
      return {
        shouldEscalate: true,
        escalateReason: `EXPERT task requires ≥75% confidence`,
      };
    }

    return { shouldEscalate: false };
  }

  private recommendMode(
    confidence: number,
    complexity: TaskComplexity,
    shouldEscalate: boolean
  ): 'fast' | 'verify' | 'extended' {
    if (shouldEscalate) return 'verify';

    if (confidence >= CONFIDENCE_THRESHOLDS.high) {
      if (complexity === 'TRIVIAL' || complexity === 'SIMPLE') {
        return 'fast';
      }
      return 'verify';
    }

    if (confidence >= CONFIDENCE_THRESHOLDS.medium) {
      return 'verify';
    }

    return 'extended';
  }

  private getCalibrationQuality(): 'well_calibrated' | 'overconfident' | 'underconfident' {
    const recent = this.assessmentHistory.slice(-20);
    if (recent.length < 5) return 'well_calibrated';

    const avgPredicted = recent.reduce((sum, r) => sum + r.predictedConfidence, 0) / recent.length;
    const avgActual = recent.reduce((sum, r) => sum + r.calibratedConfidence, 0) / recent.length;

    const bias = avgPredicted - avgActual;

    if (bias > 0.15) return 'overconfident';
    if (bias < -0.15) return 'underconfident';
    return 'well_calibrated';
  }

  private updateSkillHistories(actualScore: number): void {
    // 简化版：每个技能更新
    // 实际应用中应该按任务类型追踪
    if (!this.skillHistories.has(this.agentId)) {
      this.skillHistories.set(this.agentId, new Map());
    }

    const agentSkills = this.skillHistories.get(this.agentId)!;
    for (const dim of SKILL_DIMENSIONS) {
      if (!agentSkills.has(dim)) {
        agentSkills.set(dim, []);
      }
      const history = agentSkills.get(dim)!;
      history.push(actualScore);
      // 保持最近 50 条
      if (history.length > 50) {
        history.shift();
      }
    }
  }
}

// ========================================
// Factory
// ========================================

export function createAgentSelfAssessmentEngine(
  agentId: string,
  agentName: string
): AgentSelfAssessmentEngine {
  return new AgentSelfAssessmentEngine(agentId, agentName);
}