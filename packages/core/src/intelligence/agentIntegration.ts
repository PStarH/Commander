/**
 * Agent Intelligence Integration
 *
 * Connects the intelligence layer to the agent runtime.
 * This is called automatically by the agent — users don't interact with it directly.
 *
 * Flow:
 * 1. Before task: check failure patterns, estimate cost
 * 2. During task: track execution for skill extraction
 * 3. After task: record outcome, extract skills
 */

import { getCostPredictor, type CostEstimate } from './costPredictor';
import { getFailurePatternLearner, type FailureWarning } from './failurePatterns';
import { getImpactAnalyzer } from './impactAnalyzer';
import { getSkillExtractor } from './skillExtractor';
import { getMetricsCollector } from '../runtime/metricsCollector';

// ============================================================================
// Types
// ============================================================================

export interface PreTaskIntelligence {
  costEstimate: CostEstimate;
  failureWarnings: FailureWarning[];
  suggestedSkill?: {
    name: string;
    steps: string[];
    confidence: number;
  };
}

export interface PostTaskIntelligence {
  recordedCost: boolean;
  extractedSkill?: {
    name: string;
    description: string;
  };
  failureRecorded: boolean;
}

// ============================================================================
// Agent Intelligence Integration
// ============================================================================

export class AgentIntelligence {
  /**
   * Called BEFORE a task executes.
   * Returns cost estimate, failure warnings, and suggested skill.
   */
  async preTask(params: {
    task: string;
    taskType: string;
    effortLevel: string;
    topology: string;
    estimatedTokens: number;
    estimatedDurationMs: number;
    agentCount: number;
  }): Promise<PreTaskIntelligence> {
    const costPredictor = getCostPredictor();
    const failureLearner = getFailurePatternLearner();

    // 1. Estimate cost
    const costEstimate = costPredictor.predict({
      taskType: params.taskType,
      effortLevel: params.effortLevel,
      topology: params.topology,
      estimatedTokens: params.estimatedTokens,
      estimatedDurationMs: params.estimatedDurationMs,
      agentCount: params.agentCount,
    });

    // 2. Check for failure pattern warnings
    const failureWarnings = failureLearner.checkWarnings(params.task);

    // 3. Check for matching skill
    const skillExtractor = getSkillExtractor();
    const matchingSkill = skillExtractor.findMatchingSkill(params.task);

    return {
      costEstimate,
      failureWarnings,
      suggestedSkill: matchingSkill
        ? {
            name: matchingSkill.name,
            steps: matchingSkill.steps,
            confidence: matchingSkill.confidence,
          }
        : undefined,
    };
  }

  /**
   * Called AFTER a task completes.
   * Records cost, extracts skills, records failures.
   */
  async postTask(params: {
    task: string;
    taskType: string;
    effortLevel: string;
    topology: string;
    tokens: number;
    durationMs: number;
    success: boolean;
    steps: Array<{ action: string; tool: string; result: string }>;
    error?: string;
    /** The runId for skill provenance tracking */
    runId?: string;
  }): Promise<PostTaskIntelligence> {
    const costPredictor = getCostPredictor();
    const failureLearner = getFailurePatternLearner();
    const skillExtractor = getSkillExtractor();

    // 1. Record actual cost
    costPredictor.record({
      taskType: params.taskType,
      effortLevel: params.effortLevel,
      topology: params.topology,
      tokens: params.tokens,
      durationMs: params.durationMs,
      success: params.success,
    });

    let extractedSkill: PostTaskIntelligence['extractedSkill'];
    let failureRecorded = false;

    if (params.success) {
      // 2. Extract skill from successful execution
      const result = skillExtractor.extract({
        task: params.task,
        taskType: params.taskType,
        steps: params.steps,
        tokens: params.tokens,
        success: true,
        runId: params.runId,
      });

      // Record extraction metric
      try {
        const outcome =
          result.skills.length > 0
            ? result.skills[0].usageCount > 1
              ? 'updated'
              : 'extracted'
            : 'rejected';
        getMetricsCollector().recordSkillExtraction(outcome, result.skills[0]?.category);
      } catch (err) {
        console.warn('[Catch]', err);
        /* best-effort */
      }

      if (result.skills.length > 0) {
        extractedSkill = {
          name: result.skills[0].name,
          description: result.skills[0].description,
        };
      }
    } else if (params.error) {
      // 3. Record failure pattern
      failureLearner.recordFailure({
        task: params.task,
        error: params.error,
        context: `Topology: ${params.topology}, Tokens: ${params.tokens}`,
      });
      failureRecorded = true;
    }

    return {
      recordedCost: true,
      extractedSkill,
      failureRecorded,
    };
  }

  /**
   * Get intelligence summary for display.
   */
  getSummary(intelligence: PreTaskIntelligence): string {
    const lines: string[] = [];

    // Cost estimate
    lines.push('📊 成本预估:');
    lines.push(`   Token: ${intelligence.costEstimate.estimatedTokens.toLocaleString()}`);
    lines.push(`   成本: $${intelligence.costEstimate.estimatedCostUsd.toFixed(4)}`);
    lines.push(`   时间: ${(intelligence.costEstimate.estimatedDurationMs / 1000).toFixed(0)}s`);
    lines.push(`   置信度: ${(intelligence.costEstimate.confidence * 100).toFixed(0)}%`);

    // Failure warnings
    if (intelligence.failureWarnings.length > 0) {
      lines.push('\n⚠️ 风险提醒:');
      for (const warning of intelligence.failureWarnings) {
        const icon =
          warning.severity === 'high' ? '🔴' : warning.severity === 'medium' ? '🟡' : '🟢';
        lines.push(`   ${icon} ${warning.pattern.description}`);
        lines.push(`      建议: ${warning.suggestion}`);
      }
    }

    // Suggested skill
    if (intelligence.suggestedSkill) {
      lines.push(`\n💡 已有类似经验: ${intelligence.suggestedSkill.name}`);
      lines.push(`   置信度: ${(intelligence.suggestedSkill.confidence * 100).toFixed(0)}%`);
    }

    return lines.join('\n');
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultIntelligence: AgentIntelligence | null = null;

export function getAgentIntelligence(): AgentIntelligence {
  if (!defaultIntelligence) {
    defaultIntelligence = new AgentIntelligence();
  }
  return defaultIntelligence;
}
