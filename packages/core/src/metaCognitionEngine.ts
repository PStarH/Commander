/**
 * Meta-Cognition Engine — Commander 独有能力
 * 
 * 其他框架不知道自己能做什么、不能做什么。
 * Commander 知道。
 * 
 * 功能：
 * 1. 能力边界感知 — 知道自己擅长什么、不擅长什么
 * 2. 置信度校准 — 不会过度自信
 * 3. 知识边界检测 — 知道什么时候该说"我不知道"
 * 4. 自适应推理 — 根据置信度调整推理深度
 * 5. 学习曲线追踪 — 追踪自己在各领域的进步
 */

export interface CapabilityProfile {
  domain: string;
  skillLevel: number;        // 0-1
  confidence: number;        // 0-1
  taskCount: number;
  successCount: number;
  failureCount: number;
  averageQuality: number;
  lastUpdated: Date;
  trend: 'improving' | 'stable' | 'declining';
}

export interface MetaCognitionState {
  overallConfidence: number;
  capabilityMap: Map<string, CapabilityProfile>;
  knowledgeGaps: string[];
  strengths: string[];
  weaknesses: string[];
  recommendedActions: string[];
}

export interface ConfidenceCalibration {
  predictedConfidence: number;
  actualSuccessRate: number;
  calibrationError: number;
  isOverconfident: boolean;
  isUnderconfident: boolean;
}

export class MetaCognitionEngine {
  private capabilities: Map<string, CapabilityProfile> = new Map();
  private taskHistory: Array<{
    domain: string;
    success: boolean;
    quality: number;
    predictedConfidence: number;
    timestamp: Date;
  }> = [];

  /**
   * 记录任务执行结果，更新能力模型
   */
  recordTaskExecution(
    domain: string,
    success: boolean,
    quality: number,
    predictedConfidence: number
  ): void {
    // 更新历史
    this.taskHistory.push({
      domain,
      success,
      quality,
      predictedConfidence,
      timestamp: new Date(),
    });

    // 更新能力 profile
    let profile = this.capabilities.get(domain);
    if (!profile) {
      profile = {
        domain,
        skillLevel: 0.5,
        confidence: 0.5,
        taskCount: 0,
        successCount: 0,
        failureCount: 0,
        averageQuality: 0,
        lastUpdated: new Date(),
        trend: 'stable',
      };
      this.capabilities.set(domain, profile);
    }

    profile.taskCount++;
    if (success) {
      profile.successCount++;
    } else {
      profile.failureCount++;
    }

    // 更新平均质量（指数移动平均）
    profile.averageQuality = profile.averageQuality * 0.8 + quality * 0.2;

    // 更新技能水平
    const successRate = profile.successCount / profile.taskCount;
    profile.skillLevel = profile.skillLevel * 0.7 + successRate * 0.3;

    // 更新置信度（校准后）
    const calibration = this.calibrateConfidence(domain);
    profile.confidence = profile.confidence * 0.7 + (1 - calibration.calibrationError) * 0.3;

    // 计算趋势
    const recentTasks = this.taskHistory
      .filter(t => t.domain === domain)
      .slice(-10);
    if (recentTasks.length >= 3) {
      const recentSuccess = recentTasks.filter(t => t.success).length / recentTasks.length;
      const olderTasks = this.taskHistory
        .filter(t => t.domain === domain)
        .slice(0, -10);
      if (olderTasks.length >= 3) {
        const olderSuccess = olderTasks.filter(t => t.success).length / olderTasks.length;
        if (recentSuccess > olderSuccess + 0.1) {
          profile.trend = 'improving';
        } else if (recentSuccess < olderSuccess - 0.1) {
          profile.trend = 'declining';
        } else {
          profile.trend = 'stable';
        }
      }
    }

    profile.lastUpdated = new Date();
  }

  /**
   * 校准置信度 — 检测过度自信或过度不自信
   */
  calibrateConfidence(domain: string): ConfidenceCalibration {
    const domainTasks = this.taskHistory.filter(t => t.domain === domain);
    if (domainTasks.length < 3) {
      return {
        predictedConfidence: 0.5,
        actualSuccessRate: 0.5,
        calibrationError: 0,
        isOverconfident: false,
        isUnderconfident: false,
      };
    }

    const avgPredicted = domainTasks.reduce((sum, t) => sum + t.predictedConfidence, 0) / domainTasks.length;
    const actualSuccess = domainTasks.filter(t => t.success).length / domainTasks.length;
    const error = Math.abs(avgPredicted - actualSuccess);

    return {
      predictedConfidence: avgPredicted,
      actualSuccessRate: actualSuccess,
      calibrationError: error,
      isOverconfident: avgPredicted > actualSuccess + 0.15,
      isUnderconfident: avgPredicted < actualSuccess - 0.15,
    };
  }

  /**
   * 获取当前元认知状态
   */
  getMetaCognitionState(): MetaCognitionState {
    const capabilityMap = new Map(this.capabilities);
    
    // 计算总体置信度
    const profiles = Array.from(capabilityMap.values());
    const overallConfidence = profiles.length > 0
      ? profiles.reduce((sum, p) => sum + p.confidence, 0) / profiles.length
      : 0.5;

    // 识别知识差距（低技能或低置信度的领域）
    const knowledgeGaps = profiles
      .filter(p => p.skillLevel < 0.4 || p.confidence < 0.4)
      .map(p => p.domain);

    // 识别优势（高技能且高置信度）
    const strengths = profiles
      .filter(p => p.skillLevel > 0.7 && p.confidence > 0.7)
      .map(p => p.domain);

    // 识别弱点（高置信度但低技能 = 过度自信）
    const weaknesses = profiles
      .filter(p => p.confidence > 0.7 && p.skillLevel < 0.4)
      .map(p => p.domain);

    // 推荐行动
    const recommendedActions: string[] = [];
    for (const gap of knowledgeGaps) {
      recommendedActions.push(`提升 ${gap} 领域的技能（当前技能: ${(capabilityMap.get(gap)?.skillLevel || 0) * 100}%）`);
    }
    for (const weakness of weaknesses) {
      recommendedActions.push(`降低 ${weakness} 领域的置信度（过度自信）`);
    }

    return {
      overallConfidence,
      capabilityMap,
      knowledgeGaps,
      strengths,
      weaknesses,
      recommendedActions,
    };
  }

  /**
   * 获取任务推荐（基于能力匹配）
   */
  getTaskRecommendation(taskDomain: string): {
    shouldAttempt: boolean;
    confidence: number;
    reasoning: string;
    suggestedApproach: string;
  } {
    const profile = this.capabilities.get(taskDomain);
    const state = this.getMetaCognitionState();

    if (!profile) {
      return {
        shouldAttempt: true,
        confidence: 0.5,
        reasoning: `未在 ${taskDomain} 领域执行过任务，建议尝试`,
        suggestedApproach: '采用保守策略，设置 GUARDED 治理模式',
      };
    }

    const calibration = this.calibrateConfidence(taskDomain);
    
    // 过度自信时降低置信度
    let adjustedConfidence = profile.confidence;
    if (calibration.isOverconfident) {
      adjustedConfidence *= 0.7;
    }

    const shouldAttempt = adjustedConfidence > 0.3;
    let reasoning = '';
    let suggestedApproach = '';

    if (adjustedConfidence > 0.8) {
      reasoning = `${taskDomain} 领域技能高 (${(profile.skillLevel * 100).toFixed(0)}%)，置信度校准良好`;
      suggestedApproach = '采用标准策略，可使用 SINGLE 治理模式';
    } else if (adjustedConfidence > 0.5) {
      reasoning = `${taskDomain} 领域技能中等 (${(profile.skillLevel * 100).toFixed(0)}%)，需要验证`;
      suggestedApproach = '采用 GUARDED 治理模式，添加质量检查';
    } else {
      reasoning = `${taskDomain} 领域技能较低 (${(profile.skillLevel * 100).toFixed(0)}%)，建议谨慎`;
      suggestedApproach = '采用 MANUAL 治理模式，需要人工审批';
    }

    if (calibration.isOverconfident) {
      reasoning += ' ⚠️ 检测到过度自信，已降低置信度';
    }

    return {
      shouldAttempt,
      confidence: adjustedConfidence,
      reasoning,
      suggestedApproach,
    };
  }

  /**
   * 生成元认知报告
   */
  generateReport(): string {
    const state = this.getMetaCognitionState();
    
    let report = '# Commander 元认知报告\n\n';
    
    report += `## 总体状态\n`;
    report += `- 总体置信度: ${(state.overallConfidence * 100).toFixed(1)}%\n`;
    report += `- 已学习领域: ${state.capabilityMap.size}\n`;
    report += `- 知识差距: ${state.knowledgeGaps.length}\n`;
    report += `- 优势领域: ${state.strengths.length}\n`;
    report += `- 弱点领域: ${state.weaknesses.length}\n\n`;

    if (state.strengths.length > 0) {
      report += `## 💪 优势领域\n`;
      for (const s of state.strengths) {
        const p = state.capabilityMap.get(s)!;
        report += `- **${s}**: 技能 ${(p.skillLevel * 100).toFixed(0)}%, 成功率 ${(p.successCount / p.taskCount * 100).toFixed(0)}%, 趋势 ${p.trend}\n`;
      }
      report += '\n';
    }

    if (state.knowledgeGaps.length > 0) {
      report += `## ⚠️ 知识差距\n`;
      for (const gap of state.knowledgeGaps) {
        const p = state.capabilityMap.get(gap);
        report += `- **${gap}**: 技能 ${p ? (p.skillLevel * 100).toFixed(0) : '?'}%\n`;
      }
      report += '\n';
    }

    if (state.weaknesses.length > 0) {
      report += `## 🚨 过度自信领域\n`;
      for (const w of state.weaknesses) {
        const p = state.capabilityMap.get(w)!;
        report += `- **${w}**: 置信度 ${(p.confidence * 100).toFixed(0)}% 但技能仅 ${(p.skillLevel * 100).toFixed(0)}%\n`;
      }
      report += '\n';
    }

    if (state.recommendedActions.length > 0) {
      report += `## 📋 推荐行动\n`;
      for (const action of state.recommendedActions) {
        report += `- ${action}\n`;
      }
    }

    return report;
  }
}

/**
 * 创建全局元认知引擎实例
 */
export function createMetaCognitionEngine(): MetaCognitionEngine {
  return new MetaCognitionEngine();
}
