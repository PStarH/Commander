/**
 * Effort Scaler - Anthropic-style effort scaling rules.
 *
 * Implements Anthropic's findings:
 * - Simple fact-finding: 1 agent, 3-10 tool calls
 * - Direct comparisons: 2-4 subagents, 10-15 calls each
 * - Complex research: 10+ subagents with clearly divided responsibilities
 */
import type { EffortLevel, EffortScalingRules, OrchestrationTopology } from './types';
export declare function getEffortRules(level: EffortLevel): EffortScalingRules;
export declare function classifyEffortLevel(goal: string, contextHints?: {
    toolCount?: number;
    riskLevel?: string;
    depth?: number;
}): EffortLevel;
export declare function selectTopologyForEffort(level: EffortLevel, dag?: {
    parallelismWidth: number;
    criticalPathDepth: number;
    interSubtaskCoupling: number;
}): OrchestrationTopology;
//# sourceMappingURL=effortScaler.d.ts.map