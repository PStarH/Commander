import type { DeliberationPlan, OrchestrationTopology, TaskDAG } from './types';
import { COST_PER_TOKEN } from '../config/constants';
import type { LearnedWeights } from './learnedWeights';

export type CoordinationPattern =
  | 'SINGLE_AGENT'
  | 'PLANNER_EXECUTOR'
  | 'REVIEWER'
  | 'SPECIALIST_SWARM'
  | 'HIERARCHICAL_DELEGATION'
  | 'DEBATE'
  | 'ENSEMBLE'
  | 'HANDOFF'
  | 'CONSENSUS';

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

const TOPOLOGY_TOKEN_MULTIPLIER: Record<OrchestrationTopology, number> = {
  SINGLE: 1.0,
  // Canonical (D3.2) — mirror the legacy alias values so canonical-name
  // lookups yield the same token multiplier as the deprecated-equivalent
  // legacy name (e.g., `CHAIN` behaves exactly like `SEQUENTIAL`).
  CHAIN: 1.1,
  DISPATCH: 2.0,
  ORCHESTRATOR: 3.0,
  REVIEW: 2.5,
  HYBRID: 4.0,
  DEBATE: 3.5,
  ENSEMBLE: 3.0,
  CONSENSUS: 3.5,
  SEQUENTIAL: 1.1,
  HANDOFF: 1.1,
  PARALLEL: 2.0,
  HIERARCHICAL: 3.0,
  EVALUATOR_OPTIMIZER: 2.5,
};

/** Default ROI threshold — learned weights can override this per task type. */
const DEFAULT_ROI_THRESHOLD = 0.05;

export function evaluateCoordinationPolicy(
  deliberation: DeliberationPlan,
  candidateTopology: OrchestrationTopology,
  dag?: TaskDAG,
  learnedWeights?: LearnedWeights,
  tenantId?: string,
): CoordinationDecision {
  const agentCount = Math.max(1, Math.round(deliberation.estimatedAgentCount || 1));
  const coordinationChannels = agentCount <= 1 ? 0 : (agentCount * (agentCount - 1)) / 2;
  const tokenMultiplier = TOPOLOGY_TOKEN_MULTIPLIER[candidateTopology];
  const roiThreshold = learnedWeights
    ? learnedWeights.getCoordinationWeight(
        'roi_threshold',
        deliberation.taskType,
        DEFAULT_ROI_THRESHOLD,
        tenantId,
      )
    : DEFAULT_ROI_THRESHOLD;

  const coupling = learnedWeights
    ? learnedWeights.getCoordinationWeight(
        'coupling',
        deliberation.taskType,
        inferCoupling(deliberation, dag),
        tenantId,
      )
    : inferCoupling(deliberation, dag);
  const usefulParallelism = inferUsefulParallelism(deliberation, dag);
  const parallelismEfficiency = Math.max(
    0,
    Math.min(1, (Math.min(agentCount, usefulParallelism) / agentCount) * (1 - coupling * 0.55)),
  );

  const coordinationTokenEstimate = estimateCoordinationTokens(
    agentCount,
    coordinationChannels,
    candidateTopology,
  );
  const coordinationCostUsd = coordinationTokenEstimate * COST_PER_TOKEN;
  const latencyPenaltyMs = estimateLatencyPenaltyMs(
    agentCount,
    coordinationChannels,
    coupling,
    candidateTopology,
  );
  const pattern = selectCoordinationPattern(deliberation, candidateTopology, agentCount, dag);
  const gain = estimateGain(
    deliberation,
    candidateTopology,
    {
      agentCount,
      coordinationChannels,
      tokenMultiplier,
      coordinationTokenEstimate,
      coordinationCostUsd,
      latencyPenaltyMs,
      parallelismEfficiency,
      coupling,
    },
    usefulParallelism,
    learnedWeights,
    tenantId,
  );

  const reasons: string[] = [];
  const evidence: string[] = [
    'Anthropic: multi-agent research helps breadth-first, parallel, high-value research but used about 15x chat tokens.',
    'Amdahl/Brooks: serial work and coordination channels bound returns as participants increase.',
    'OpenAI: start with one agent; add specialists only for capability, policy, prompt, or trace isolation.',
    ...buildDynamicEvidence(
      deliberation,
      candidateTopology,
      learnedWeights,
      tenantId,
      coupling,
      roiThreshold,
    ),
  ];

  if (agentCount <= 1) reasons.push('Only one useful worker estimated.');
  if (usefulParallelism < 1.5) reasons.push('Task has little independent parallel work.');
  if (coupling >= 0.75)
    reasons.push('Subtasks are tightly coupled, so handoffs become a bottleneck.');
  if (deliberation.estimatedTokens < 2000 && !deliberation.requiresExternalInfo) {
    reasons.push('Low-token local task is unlikely to repay coordination setup.');
  }
  if (gain.netRoi < roiThreshold) {
    reasons.push(
      `Estimated coordination ROI ${gain.netRoi.toFixed(2)} is below learned threshold ${roiThreshold.toFixed(2)}.`,
    );
  }

  const lowValueLocalTask =
    deliberation.taskType === 'FACTUAL' &&
    deliberation.estimatedTokens < 2000 &&
    !deliberation.requiresExternalInfo;
  const tightlyCoupledSmallGraph = coupling >= 0.85 && usefulParallelism <= 2 && agentCount > 1;
  const weakNoEvidenceCase =
    gain.netRoi < roiThreshold &&
    !hasPositiveCoordinationSignal(deliberation, candidateTopology, dag);
  const negativeRoi =
    candidateTopology !== 'SINGLE' &&
    (agentCount <= 1 || lowValueLocalTask || tightlyCoupledSmallGraph || weakNoEvidenceCase);

  const fallbackTopology = negativeRoi
    ? chooseFallbackTopology(deliberation, coupling, usefulParallelism)
    : undefined;
  const mode = fallbackTopology === 'SINGLE' ? 'single' : selectMode(agentCount, pattern);

  return {
    selectedTopology: candidateTopology,
    pattern,
    mode,
    overhead: {
      agentCount,
      coordinationChannels,
      tokenMultiplier,
      coordinationTokenEstimate,
      coordinationCostUsd,
      latencyPenaltyMs,
      parallelismEfficiency,
      coupling,
    },
    gain,
    negativeRoi,
    fallbackTopology,
    reasons,
    evidence,
  };
}

function inferCoupling(deliberation: DeliberationPlan, dag?: TaskDAG): number {
  if (dag) return dag.metadata.interSubtaskCoupling;
  switch (deliberation.taskType) {
    case 'RESEARCH':
      return 0.25;
    case 'ANALYSIS':
      return 0.35;
    case 'CREATIVE':
      return 0.3;
    case 'CODING':
      return 0.55;
    case 'REASONING':
      return 0.65;
    case 'FACTUAL':
    default:
      return deliberation.requiresExternalInfo ? 0.45 : 0.8;
  }
}

function inferUsefulParallelism(deliberation: DeliberationPlan, dag?: TaskDAG): number {
  if (dag) return Math.max(1, dag.metadata.parallelismWidth);
  if (deliberation.taskNature === 'IO_BOUND') {
    return Math.max(2, Math.min(deliberation.estimatedAgentCount, 8));
  }
  switch (deliberation.taskType) {
    case 'RESEARCH':
      return Math.max(3, Math.min(deliberation.estimatedAgentCount, 10));
    case 'ANALYSIS':
      return Math.max(2, Math.min(deliberation.estimatedAgentCount, 5));
    case 'CREATIVE':
      return Math.max(2, Math.min(deliberation.estimatedAgentCount, 4));
    case 'CODING':
      return Math.max(1, Math.min(deliberation.estimatedAgentCount, 3));
    case 'REASONING':
      return Math.max(1, Math.min(deliberation.estimatedAgentCount, 2));
    case 'FACTUAL':
    default:
      return deliberation.requiresExternalInfo ? 2 : 1;
  }
}

function estimateCoordinationTokens(
  agentCount: number,
  coordinationChannels: number,
  topology: OrchestrationTopology,
): number {
  if (topology === 'SINGLE') return 0;
  const topologyBase = topology === 'CHAIN' ? 200 : topology === 'DISPATCH' ? 450 : 700;
  return Math.round(topologyBase + agentCount * 350 + coordinationChannels * 80);
}

function estimateLatencyPenaltyMs(
  agentCount: number,
  coordinationChannels: number,
  coupling: number,
  topology: OrchestrationTopology,
): number {
  if (topology === 'SINGLE') return 0;
  const syncPenalty = topology === 'DISPATCH' ? 600 : topology === 'CHAIN' ? 900 : 1400;
  return Math.round(syncPenalty + agentCount * 250 + coordinationChannels * 100 * coupling);
}

function estimateGain(
  deliberation: DeliberationPlan,
  topology: OrchestrationTopology,
  overhead: CoordinationOverhead,
  usefulParallelism: number,
  learnedWeights?: LearnedWeights,
  tenantId?: string,
): CoordinationGainEstimate {
  const defaultBreadth = breadthSignal(deliberation, usefulParallelism);
  const breadthGain = learnedWeights
    ? learnedWeights.getCoordinationWeight(
        'breadth_gain',
        deliberation.taskType,
        defaultBreadth,
        tenantId,
      )
    : defaultBreadth;
  const structureGain = structuralSignal(deliberation, topology);
  const contextGain =
    deliberation.estimatedTokens > 50_000
      ? 0.2
      : deliberation.estimatedTokens > 20_000
        ? 0.12
        : deliberation.estimatedTokens > 8_000
          ? 0.06
          : 0;
  const isolationGain = isolationSignal(deliberation, topology);
  const coverageGain = Math.min(0.3, breadthGain + contextGain + structureGain);
  const qualityGain = Math.min(0.35, coverageGain + isolationGain);
  const latencyGain =
    deliberation.taskNature === 'IO_BOUND' && usefulParallelism > 1
      ? Math.min(0.25, (1 - 1 / Math.max(1, usefulParallelism)) * 0.3)
      : 0;
  const overheadPenalty = Math.min(
    0.6,
    (overhead.tokenMultiplier - 1) * 0.08 +
      Math.sqrt(overhead.coordinationChannels) * 0.02 +
      overhead.coupling * 0.12 +
      (overhead.parallelismEfficiency < 0.35 ? 0.08 : 0),
  );
  return {
    qualityGain,
    latencyGain,
    coverageGain,
    overheadPenalty,
    netRoi: qualityGain + latencyGain - overheadPenalty,
  };
}

function structuralSignal(deliberation: DeliberationPlan, topology: OrchestrationTopology): number {
  if (
    (topology === 'ORCHESTRATOR' || topology === 'HYBRID') &&
    (deliberation.taskType === 'RESEARCH' || deliberation.taskType === 'REASONING')
  ) {
    return 0.08;
  }
  return 0;
}

function breadthSignal(deliberation: DeliberationPlan, usefulParallelism: number): number {
  if (usefulParallelism <= 1) return 0;
  if (deliberation.taskType === 'RESEARCH') return 0.12;
  if (deliberation.taskType === 'ANALYSIS') return 0.08;
  if (deliberation.taskType === 'CREATIVE') return 0.08;
  if (deliberation.taskNature === 'IO_BOUND') return 0.08;
  return 0.03;
}

function isolationSignal(deliberation: DeliberationPlan, topology: OrchestrationTopology): number {
  const needsReview = deliberation.taskType === 'CODING' || deliberation.taskType === 'ANALYSIS';
  if (topology === 'REVIEW' && needsReview) return 0.08;
  if (topology === 'CHAIN' && deliberation.capabilitiesNeeded.length > 2) return 0.06;
  if (topology === 'DEBATE' && deliberation.taskType === 'REASONING') return 0.05;
  if (topology === 'ENSEMBLE' && deliberation.taskType === 'CREATIVE') return 0.05;
  return 0;
}

function selectCoordinationPattern(
  deliberation: DeliberationPlan,
  topology: OrchestrationTopology,
  agentCount: number,
  dag?: TaskDAG,
): CoordinationPattern {
  if (topology === 'SINGLE' || agentCount <= 1) return 'SINGLE_AGENT';
  if (topology === 'REVIEW') return 'REVIEWER';
  if (topology === 'ORCHESTRATOR' || topology === 'HYBRID') return 'HIERARCHICAL_DELEGATION';
  if (topology === 'DEBATE') return 'DEBATE';
  if (topology === 'ENSEMBLE') return 'ENSEMBLE';
  if (topology === 'CHAIN') return 'HANDOFF';
  if (topology === 'CONSENSUS') return 'CONSENSUS';
  if (agentCount === 2 || dag?.metadata.criticalPathDepth === 2) return 'PLANNER_EXECUTOR';
  if (topology === 'DISPATCH') return 'SPECIALIST_SWARM';
  return deliberation.taskType === 'CODING' ? 'PLANNER_EXECUTOR' : 'SPECIALIST_SWARM';
}

function selectMode(agentCount: number, pattern: CoordinationPattern): CoordinationMode {
  if (pattern === 'SINGLE_AGENT' || agentCount <= 1) return 'single';
  if (agentCount <= 2 || pattern === 'PLANNER_EXECUTOR' || pattern === 'REVIEWER')
    return 'two_agent';
  return 'swarm';
}

function chooseFallbackTopology(
  deliberation: DeliberationPlan,
  coupling: number,
  _: number,
): OrchestrationTopology {
  if (coupling >= 0.7 && deliberation.estimatedAgentCount > 1) return 'CHAIN';
  return 'SINGLE';
}

function hasPositiveCoordinationSignal(
  deliberation: DeliberationPlan,
  topology: OrchestrationTopology,
  dag?: TaskDAG,
): boolean {
  if (deliberation.taskType === 'RESEARCH' && deliberation.estimatedAgentCount >= 3) return true;
  if (deliberation.taskType === 'ANALYSIS' && deliberation.estimatedAgentCount >= 3) return true;
  if (deliberation.taskType === 'REASONING' && deliberation.estimatedAgentCount >= 5) return true;
  if (deliberation.taskType === 'CREATIVE' && deliberation.estimatedAgentCount >= 3) return true;
  if (deliberation.taskNature === 'IO_BOUND' && deliberation.estimatedAgentCount >= 2) return true;
  if (dag && dag.metadata.criticalPathDepth > 3 && dag.metadata.interSubtaskCoupling < 0.4)
    return true;
  if (dag && dag.metadata.parallelismWidth > 3 && dag.metadata.interSubtaskCoupling < 0.7)
    return true;
  if (topology === 'REVIEW' && deliberation.taskType === 'CODING') return true;
  if (topology === 'DEBATE' && deliberation.taskType === 'REASONING') return true;
  if (topology === 'ENSEMBLE' && deliberation.taskType === 'CREATIVE') return true;
  if (deliberation.taskType === 'CODING' && deliberation.estimatedAgentCount >= 3 && !dag)
    return true;
  return false;
}

function buildDynamicEvidence(
  deliberation: DeliberationPlan,
  candidateTopology: OrchestrationTopology,
  learnedWeights: LearnedWeights | undefined,
  tenantId: string | undefined,
  coupling: number,
  roiThreshold: number,
): string[] {
  if (!learnedWeights) return [];

  const out: string[] = [];
  const state = learnedWeights.getState(deliberation.taskType, candidateTopology, tenantId);
  if (state && state.samples > 0) {
    const successRate = ((state.ema + 0.5) * 100).toFixed(0);
    out.push(
      `Tenant history: ${candidateTopology} on ${deliberation.taskType} has observed success rate ~${successRate}% across ${state.samples} samples.`,
    );
  }

  const observedCoupling = learnedWeights.getCoordinationWeight(
    'coupling',
    deliberation.taskType,
    -1,
    tenantId,
  );
  if (observedCoupling >= 0) {
    out.push(
      `Learned coupling estimate for tenant: ${observedCoupling.toFixed(2)} (heuristic: ${coupling.toFixed(2)}).`,
    );
  }

  const observedRoiThreshold = learnedWeights.getCoordinationWeight(
    'roi_threshold',
    deliberation.taskType,
    -1,
    tenantId,
  );
  if (observedRoiThreshold >= 0) {
    out.push(
      `Learned ROI threshold for tenant: ${observedRoiThreshold.toFixed(2)} (default: ${roiThreshold.toFixed(2)}).`,
    );
  }

  return out;
}
