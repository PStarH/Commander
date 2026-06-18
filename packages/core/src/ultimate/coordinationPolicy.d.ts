import type { DeliberationPlan, OrchestrationTopology, TaskDAG } from './types';
import type { LearnedWeights } from './learnedWeights';
export type CoordinationPattern = 'SINGLE_AGENT' | 'PLANNER_EXECUTOR' | 'REVIEWER' | 'SPECIALIST_SWARM' | 'HIERARCHICAL_DELEGATION' | 'DEBATE' | 'ENSEMBLE' | 'HANDOFF' | 'CONSENSUS';
export type CoordinationMode = 'single' | 'two_agent' | 'swarm';
export interface CoordinationOverhead {
    agentCount: number;
    coordinationChannels: number;
    tokenMultiplier: number;
    coordinationTokenEstimate: number;
    coordinationCostUsd: number;
    latencyPenaltyMs: number;
    parallelismEfficiency: number;
    coupling: number;
}
export interface CoordinationGainEstimate {
    qualityGain: number;
    latencyGain: number;
    coverageGain: number;
    overheadPenalty: number;
    netRoi: number;
}
export interface CoordinationDecision {
    selectedTopology: OrchestrationTopology;
    pattern: CoordinationPattern;
    mode: CoordinationMode;
    overhead: CoordinationOverhead;
    gain: CoordinationGainEstimate;
    negativeRoi: boolean;
    fallbackTopology?: OrchestrationTopology;
    reasons: string[];
    evidence: string[];
}
export declare function evaluateCoordinationPolicy(deliberation: DeliberationPlan, candidateTopology: OrchestrationTopology, dag?: TaskDAG, learnedWeights?: LearnedWeights, tenantId?: string): CoordinationDecision;
//# sourceMappingURL=coordinationPolicy.d.ts.map