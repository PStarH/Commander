/**
 * SelfAssessment.ts
 * Agent 执行前置信度评估 + 动态能力评估
 * 参考: Agent Metacognition and Self-Awareness Mechanisms (2026-04-17)
 */

import { ReasoningMode } from './reasoningConfig.js';

export interface SelfAssessmentResult {
  confidence: number;
  canHandle: boolean;
  recommendedMode: ReasoningMode;
  gaps: string[];
  refusalReason?: string;
  selfAssessmentTimestamp: number;
}

export interface AgentCapability {
  skill: string;
  confidence: number;
  successCount: number;
  failureCount: number;
  lastUsed?: number;
}

export interface AgentSelfModel {
  agentId: string;
  capabilities: Map<string, AgentCapability>;
  overallConfidence: number;
  refuseThreshold: number;
}

const DEFAULT_REFUSE_THRESHOLD = 0.2;

export class AgentSelfAssessment {
  private selfModel: AgentSelfModel;

  constructor(agentId: string, capabilities: string[] = []) {
    this.selfModel = {
      agentId,
      capabilities: new Map(),
      overallConfidence: 0.8,
      refuseThreshold: DEFAULT_REFUSE_THRESHOLD,
    };

    // 初始化默认能力
    capabilities.forEach(skill => {
      this.selfModel.capabilities.set(skill, {
        skill,
        confidence: 0.7,
        successCount: 0,
        failureCount: 0,
      });
    });
  }

  /**
   * 执行任务前的自我评估
   */
  assess(task: { type?: string; requiredSkills?: string[]; complexity?: number }): SelfAssessmentResult {
    const { requiredSkills = [], complexity = 1 } = task;

    // 1. 检查能力缺口
    const gaps: string[] = [];
    for (const skill of requiredSkills) {
      const cap = this.selfModel.capabilities.get(skill);
      if (!cap) {
        gaps.push(`Missing capability: ${skill}`);
      } else if (cap.confidence < 0.5) {
        gaps.push(`Low confidence in: ${skill} (${cap.confidence})`);
      }
    }

    // 2. 计算置信度
    let confidence = this.selfModel.overallConfidence;

    // 调整：能力缺口降低置信度
    if (gaps.length > 0) {
      confidence -= gaps.length * 0.15;
    }

    // 调整：高复杂度降低置信度
    if (complexity > 3) {
      confidence -= (complexity - 3) * 0.1;
    }

    // 调整：基于历史成功率
    let totalSuccess = 0;
    let totalAttempts = 0;
    for (const cap of this.selfModel.capabilities.values()) {
      totalSuccess += cap.successCount;
      totalAttempts += cap.successCount + cap.failureCount;
    }
    if (totalAttempts > 0) {
      const historicalSuccessRate = totalSuccess / totalAttempts;
      confidence = confidence * 0.6 + historicalSuccessRate * 0.4;
    }

    confidence = Math.max(0, Math.min(1, confidence));

    // 3. 决定是否可执行
    const canHandle = confidence >= this.selfModel.refuseThreshold && gaps.length === 0;

    // 4. 推荐推理模式
    let recommendedMode = ReasoningMode.FAST;
    if (confidence >= 0.85) {
      recommendedMode = ReasoningMode.FAST;
    } else if (confidence >= 0.6) {
      recommendedMode = ReasoningMode.VERIFY;
    } else if (confidence >= 0.4) {
      recommendedMode = ReasoningMode.EXTENDED;
    }

    // 5. 决定拒绝原因
    let refusalReason: string | undefined;
    if (!canHandle) {
      if (confidence < this.selfModel.refuseThreshold) {
        refusalReason = `Confidence ${confidence.toFixed(2)} below threshold ${this.selfModel.refuseThreshold}`;
      }
      if (gaps.length > 0) {
        refusalReason = `Missing capabilities: ${gaps.join(', ')}`;
      }
    }

    return {
      confidence,
      canHandle,
      recommendedMode,
      gaps,
      refusalReason,
      selfAssessmentTimestamp: Date.now(),
    };
  }

  /**
   * 更新能力记录（任务执行后调用）
   */
  recordOutcome(skill: string, success: boolean): void {
    let cap = this.selfModel.capabilities.get(skill);
    if (!cap) {
      cap = { skill, confidence: 0.7, successCount: 0, failureCount: 0 };
      this.selfModel.capabilities.set(skill, cap);
    }

    if (success) {
      cap.successCount++;
    } else {
      cap.failureCount++;
    }

    // 更新置信度 (exponential moving average)
    const total = cap.successCount + cap.failureCount;
    const historicalRate = cap.successCount / total;
    cap.confidence = cap.confidence * 0.7 + historicalRate * 0.3;

    this.updateOverallConfidence();
  }

  private updateOverallConfidence(): void {
    let totalConf = 0;
    let count = 0;
    for (const cap of this.selfModel.capabilities.values()) {
      totalConf += cap.confidence;
      count++;
    }
    if (count > 0) {
      this.selfModel.overallConfidence = totalConf / count;
    }
  }

  getSelfModel(): AgentSelfModel {
    return {
      ...this.selfModel,
      capabilities: new Map(this.selfModel.capabilities),
    };
  }
}

/** 全局自我评估管理器 */
export class SelfAssessmentManager {
  private assessors: Map<string, AgentSelfAssessment> = new Map();

  getOrCreate(agentId: string, capabilities?: string[]): AgentSelfAssessment {
    let assessor = this.assessors.get(agentId);
    if (!assessor) {
      assessor = new AgentSelfAssessment(agentId, capabilities);
      this.assessors.set(agentId, assessor);
    }
    return assessor;
  }

  assess(agentId: string, task: { type?: string; requiredSkills?: string[]; complexity?: number }): SelfAssessmentResult {
    const assessor = this.getOrCreate(agentId);
    return assessor.assess(task);
  }

  record(agentId: string, skill: string, success: boolean): void {
    const assessor = this.assessors.get(agentId);
    if (assessor) {
      assessor.recordOutcome(skill, success);
    }
  }
}

export const selfAssessmentManager = new SelfAssessmentManager();