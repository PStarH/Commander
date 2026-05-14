/**
 * Effort Scaler - Anthropic-style effort scaling rules.
 *
 * Implements Anthropic's findings:
 * - Simple fact-finding: 1 agent, 3-10 tool calls
 * - Direct comparisons: 2-4 subagents, 10-15 calls each
 * - Complex research: 10+ subagents with clearly divided responsibilities
 */
import type { EffortLevel, EffortScalingRules, OrchestrationTopology } from './types';

const EFFORT_RULES: Record<EffortLevel, EffortScalingRules> = {
  SIMPLE: {
    level: 'SIMPLE',
    minSubAgents: 1,
    maxSubAgents: 1,
    minToolCallsPerAgent: 3,
    maxToolCallsPerAgent: 10,
    recommendedTopology: 'SINGLE',
    thinkingTokens: 512,
    maxDepth: 0,
  },
  MODERATE: {
    level: 'MODERATE',
    minSubAgents: 2,
    maxSubAgents: 4,
    minToolCallsPerAgent: 10,
    maxToolCallsPerAgent: 15,
    recommendedTopology: 'PARALLEL',
    thinkingTokens: 2048,
    maxDepth: 1,
  },
  COMPLEX: {
    level: 'COMPLEX',
    minSubAgents: 5,
    maxSubAgents: 10,
    minToolCallsPerAgent: 10,
    maxToolCallsPerAgent: 20,
    recommendedTopology: 'HIERARCHICAL',
    thinkingTokens: 4096,
    maxDepth: 2,
  },
  DEEP_RESEARCH: {
    level: 'DEEP_RESEARCH',
    minSubAgents: 10,
    maxSubAgents: 20,
    minToolCallsPerAgent: 15,
    maxToolCallsPerAgent: 30,
    recommendedTopology: 'HYBRID',
    thinkingTokens: 8192,
    maxDepth: 3,
  },
};

export function getEffortRules(level: EffortLevel): EffortScalingRules {
  return { ...EFFORT_RULES[level] };
}

export function classifyEffortLevel(
  goal: string,
  contextHints?: { toolCount?: number; riskLevel?: string; depth?: number },
): EffortLevel {
  const length = goal.length;
  const toolCount = contextHints?.toolCount ?? 0;
  const riskLevel = contextHints?.riskLevel ?? 'LOW';
  const depth = contextHints?.depth ?? 0;

  if (length > 3000 || toolCount > 15 || riskLevel === 'CRITICAL' || depth > 3) {
    return 'DEEP_RESEARCH';
  }
  if (length > 1500 || toolCount > 8 || riskLevel === 'HIGH' || depth > 2) {
    return 'COMPLEX';
  }
  if (length > 400 || toolCount > 3 || riskLevel === 'MEDIUM' || depth > 1) {
    return 'MODERATE';
  }
  return 'SIMPLE';
}

export function selectTopologyForEffort(level: EffortLevel, dag?: {
  parallelismWidth: number;
  criticalPathDepth: number;
  interSubtaskCoupling: number;
}): OrchestrationTopology {
  const rules = getEffortRules(level);

  if (!dag) return rules.recommendedTopology;

  if (dag.interSubtaskCoupling > 0.7) {
    return 'SEQUENTIAL';
  }
  if (dag.criticalPathDepth > 3 && dag.parallelismWidth > 2) {
    return 'HIERARCHICAL';
  }
  if (dag.parallelismWidth > 3) {
    return 'PARALLEL';
  }
  return rules.recommendedTopology;
}
