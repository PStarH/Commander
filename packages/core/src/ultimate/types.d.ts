/**
 * Ultimate Multi-Agent Orchestration Types
 *
 * Comprehensive types for the world's most advanced multi-agent system,
 * incorporating research from Anthropic, OpenAI, CAMEL, ROMA, AdaptOrch,
 * DOVA, FoA, RecursiveMAS, and other state-of-the-art systems.
 */
import type { ModelTier, TaskTreeNode, ROMARole, ArtifactReference, ArtifactStore } from '../shared/types';
import type { TELOSBudget } from '../telos/types';
/**
 * Risk level for a sub-agent node.
 */
export type NodeRiskLevel = 'low' | 'medium' | 'high' | 'critical';
/**
 * Assessment of a node's risk.
 */
export interface NodeRiskAssessment {
    nodeId: string;
    level: NodeRiskLevel;
    reasons: string[];
    confidence: number;
}
/**
 * Gate configuration for human-in-the-loop approval.
 */
export interface HumanApprovalGate {
    enabled: boolean;
    nodeIds?: string[];
    tags?: string[];
    riskThreshold?: NodeRiskLevel;
    sampling?: number;
    timeoutMs?: number;
    onTimeout?: 'approve' | 'reject' | 'modify';
}
/**
 * Canonical orchestration topologies.
 * AdaptOrch research shows topology selection alone yields 12-23% improvement.
 */
export type OrchestrationTopology = 'SINGLE' | 'SEQUENTIAL' | 'PARALLEL' | 'HIERARCHICAL' | 'HYBRID' | 'DEBATE' | 'ENSEMBLE' | 'EVALUATOR_OPTIMIZER' | 'HANDOFF' | 'CONSENSUS';
/**
 * Task dependency graph for topology routing.
 */
export interface TaskDAG {
    nodes: TaskDAGNode[];
    edges: TaskDAGEdge[];
    metadata: {
        parallelismWidth: number;
        criticalPathDepth: number;
        interSubtaskCoupling: number;
    };
}
export interface TaskDAGNode {
    id: string;
    label: string;
    estimatedComplexity: number;
    estimatedTokens: number;
    requiredCapabilities: string[];
    atomic: boolean;
}
export interface TaskDAGEdge {
    from: string;
    to: string;
    type: 'SEQUENTIAL' | 'PARALLEL' | 'CONDITIONAL';
    dataDependency: boolean;
}
/**
 * Deliberation phase: meta-reasoning BEFORE any tool invocation.
 * DOVA research: reduces unnecessary API calls by 40-60% on simple tasks.
 */
export interface DeliberationPlan {
    requiresExternalInfo: boolean;
    taskType: 'FACTUAL' | 'REASONING' | 'CREATIVE' | 'RESEARCH' | 'CODING' | 'ANALYSIS';
    recommendedTopology: OrchestrationTopology;
    /** Pre-computed effort level from deliberation (avoids redundant re-classification) */
    effortLevel?: EffortLevel;
    estimatedAgentCount: number;
    estimatedSteps: number;
    estimatedTokens: number;
    estimatedDurationMs: number;
    tokenBudget: {
        thinking: number;
        execution: number;
        synthesis: number;
    };
    decompositionStrategy: 'NONE' | 'ASPECT' | 'STEP' | 'RECURSIVE';
    capabilitiesNeeded: string[];
    confidence: number;
    reasoning: string[];
    /** SPAgent-inspired: true if early steps are simple evidence-gathering suitable for speculation */
    suitableForSpeculation: boolean;
    /** Astraea-inspired: classify task as I/O-bound (waiting for external data) or compute-bound (LLM reasoning) */
    taskNature: 'IO_BOUND' | 'COMPUTE_BOUND' | 'MIXED';
    /** Chimera-inspired: per-agent time budget in ms, derived from estimatedDurationMs × topology factor */
    timeBudgetPerAgentMs: number;
}
export type { ROMARole, TaskTreeNode };
export type { ArtifactReference, ArtifactStore };
/**
 * Persistent agent team with shared inbox messaging.
 * Unlike stateless sub-agents, teams persist, share a task list,
 * and message each other directly for coordinated debugging.
 */
export interface AgentTeam {
    id: string;
    name: string;
    members: TeamMember[];
    sharedTaskList: SharedTask[];
    inbox: InboxMessage[];
    status: 'FORMING' | 'ACTIVE' | 'DISBANDED';
    createdAt: string;
    metadata: Record<string, unknown>;
}
export interface TeamMember {
    agentId: string;
    role: 'LEAD' | 'RESEARCHER' | 'CODER' | 'REVIEWER' | 'TESTER' | 'SPECIALIST';
    capabilities: string[];
    status: 'IDLE' | 'BUSY' | 'BLOCKED';
    currentTask?: string;
}
export interface SharedTask {
    id: string;
    description: string;
    assignedTo?: string;
    status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'BLOCKED';
    dependencies: string[];
    createdAt: string;
    completedAt?: string;
}
export interface InboxMessage {
    id: string;
    from: string;
    to: string | 'ALL';
    subject: string;
    body: string;
    attachments?: ArtifactReference[];
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    createdAt: string;
    readAt?: string;
}
/**
 * Versioned Capability Vector (VCV) - machine-readable agent capability profile.
 * From FoA (Federation of Agents) research: enables semantic routing.
 */
export interface CapabilityVector {
    agentId: string;
    version: string;
    capabilities: AgentCapability[];
    cost: {
        perInputToken: number;
        perOutputToken: number;
        perTask: number;
    };
    limitations: string[];
    reliability: {
        successRate: number;
        avgLatencyMs: number;
        totalTasksCompleted: number;
    };
    lastUpdated: string;
}
export interface AgentCapability {
    name: string;
    domain: string;
    strength: number;
    description: string;
    requiredModels?: string[];
}
/**
 * Anthropic effort scaling rules:
 * - Simple fact-finding: 1 agent, 3-10 tool calls
 * - Direct comparisons: 2-4 subagents, 10-15 calls each
 * - Complex research: 10+ subagents with clearly divided responsibilities
 */
export type EffortLevel = 'SIMPLE' | 'MODERATE' | 'COMPLEX' | 'DEEP_RESEARCH';
export interface EffortScalingRules {
    level: EffortLevel;
    minSubAgents: number;
    maxSubAgents: number;
    minToolCallsPerAgent: number;
    maxToolCallsPerAgent: number;
    recommendedTopology: OrchestrationTopology;
    thinkingTokens: number;
    maxDepth: number;
    /** Model tier for lead/synthesizer agents (stronger model). */
    leadModelTier: ModelTier;
    /** Model tier for specialist/atomic agents (cheaper model). */
    specialistModelTier: ModelTier;
}
/**
 * Budget for extended thinking (Anthropic-style controllable scratchpad).
 * The lead agent uses thinking to plan approach, assess tools,
 * determine query complexity, and define subagent roles.
 */
export interface ThinkingBudget {
    enabled: boolean;
    maxThinkingTokens: number;
    /** Sub-agents also get thinking budget for interleaved evaluation */
    subAgentThinkingTokens: number;
    /** Minimum thinking tokens before allowing tool calls */
    minThinkingBeforeTools: number;
}
/**
 * Strategy for synthesizing results from multiple agents.
 */
export type SynthesisStrategy = 'LEAD_SYNTHESIS' | 'VOTE' | 'ROUND_ROBIN' | 'DEBATE' | 'HIERARCHICAL' | 'ENSEMBLE';
export interface SynthesisConfig {
    strategy: SynthesisStrategy;
    maxRounds: number;
    consensusThreshold: number;
    includeDissent: boolean;
    qualityGates: QualityGateConfig[];
}
export interface QualityGateConfig {
    [key: string]: unknown;
    name: string;
    type: 'HALLUCINATION_CHECK' | 'CONSISTENCY' | 'COMPLETENESS' | 'ACCURACY' | 'SAFETY';
    enabled: boolean;
    threshold: number;
    autoFix: boolean;
}
/**
 * Reducer function: merges current value with update value.
 * Each state key independently defines how concurrent writes merge.
 */
export type StateReducer<V> = (current: V, update: V) => V;
/**
 * State field definition: value type + optional reducer.
 * Fields without reducer use LastValue semantics (overwrite).
 * Fields with reducer use BinaryOperatorAggregate semantics (merge).
 */
export interface StateFieldDef<V> {
    defaultValue: () => V;
    reducer?: StateReducer<V>;
}
/**
 * Typed shared state between agents. Each key has:
 * - A typed value
 * - An optional reducer for merge semantics
 * - A default value factory
 *
 * Accumulating fields (findings, errors, messages) use append reducers.
 * Overwrite fields (currentStep, topology) use LastValue semantics.
 */
export interface SharedStateSchema {
    findings: StateFieldDef<string[]>;
    errors: StateFieldDef<string[]>;
    messages: StateFieldDef<Array<{
        from: string;
        subject: string;
        body: string;
    }>>;
    artifacts: StateFieldDef<string[]>;
    costAccumulator: StateFieldDef<number>;
    currentStep: StateFieldDef<string>;
}
/** The concrete shared state type (inferred from schema) */
export interface SharedState {
    findings: string[];
    errors: string[];
    messages: Array<{
        from: string;
        subject: string;
        body: string;
    }>;
    artifacts: string[];
    costAccumulator: number;
    currentStep: string;
}
/** Partial update returned by agents — only fields they changed */
export type SharedStateUpdate = Partial<SharedState>;
/**
 * Complete context for the ultimate multi-agent execution.
 */
export interface UltimateExecutionContext {
    id: string;
    projectId: string;
    goal: string;
    context: Record<string, unknown>;
    sharedState: SharedState;
    deliberation?: DeliberationPlan;
    effortLevel: EffortLevel;
    scalingRules: EffortScalingRules;
    topology: OrchestrationTopology;
    taskDAG?: TaskDAG;
    taskTree?: TaskTreeNode;
    artifacts: ArtifactReference[];
    team?: AgentTeam;
    budget: TELOSBudget;
    thinkingBudget: ThinkingBudget;
    synthesisConfig: SynthesisConfig;
    governance: {
        requiresApproval: boolean;
        approvalGateAt?: 'PLAN' | 'EXECUTION' | 'DEPLOYMENT';
        humanInTheLoop: boolean;
    };
    maxRetries: number;
    circuitBreaker: {
        maxErrors: number;
        cooldownMs: number;
        currentErrors: number;
        tripped: boolean;
    };
}
export interface UltimateExecutionResult {
    id: string;
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
    summary: string;
    synthesis: string;
    artifacts: ArtifactReference[];
    executionTree: TaskTreeNode[];
    metrics: UltimateMetrics;
    errors: ExecutionError[];
    reasoning: string[];
}
export interface UltimateMetrics {
    totalTokens: number;
    totalCostUsd: number;
    totalDurationMs: number;
    llmCalls: number;
    toolCalls: number;
    subAgentsSpawned: number;
    artifactsCreated: number;
    qualityScore: number;
    topologyUsed: OrchestrationTopology;
    effortLevelUsed: EffortLevel;
}
export interface ExecutionError {
    nodeId: string;
    agentId: string;
    message: string;
    recovered: boolean;
    recoveryAction?: string;
}
export interface TaskState {
    phase: 'discovery' | 'planning' | 'execution' | 'refinement' | 'verification' | 'termination';
    completedSteps: number;
    estimatedTotalSteps: number;
    gatheredEvidence: EvidenceItem[];
    confidence: number;
    remainingBudget: number;
    elapsedMs: number;
    lastStepResult?: StepResult;
    needsReplanning: boolean;
    terminationReason?: string;
}
export interface EvidenceItem {
    source: string;
    content: string;
    confidence: number;
    timestamp: number;
}
export interface StepResult {
    stepId: string;
    success: boolean;
    output: string;
    durationMs: number;
    tokenCost: number;
    qualityScore?: number;
}
export interface SubWorkflow {
    id: string;
    topology: OrchestrationTopology;
    steps: string[];
    estimatedCost: number;
    estimatedDuration: number;
    successRate: number;
}
export interface WorkflowDecision {
    subWorkflowId: string;
    topology: OrchestrationTopology;
    priority: number;
    rationale: string;
    alternatives: string[];
}
export interface AdaptiveExecutionResult {
    finalResult: UltimateExecutionResult;
    taskState: TaskState;
    decisions: WorkflowDecision[];
    stagesTraversed: string[];
    rePlanningCount: number;
    metrics: {
        totalDurationMs: number;
        totalTokens: number;
        stageDurations: Map<string, number>;
        adaptationCount: number;
    };
}
export interface UltimateOrchestratorConfig {
    [key: string]: unknown;
    defaultBudget: TELOSBudget;
    defaultThinkingBudget: ThinkingBudget;
    defaultSynthesisConfig: SynthesisConfig;
    defaultEffortLevel: EffortLevel;
    maxRecursiveDepth: number;
    maxParallelSubAgents: number;
    enableDeliberation: boolean;
    enableArtifactSystem: boolean;
    enableTeams: boolean;
    enableCapabilityRouting: boolean;
    enableCircuitBreaker: boolean;
    qualityGates: QualityGateConfig[];
    modelTierMapping: Record<EffortLevel, ModelTier>;
}
export declare const DEFAULT_THINKING_BUDGET: ThinkingBudget;
export declare const DEFAULT_SYNTHESIS_CONFIG: SynthesisConfig;
export declare const DEFAULT_ULTIMATE_CONFIG: UltimateOrchestratorConfig;
//# sourceMappingURL=types.d.ts.map