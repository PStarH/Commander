/**
 * Ultimate Multi-Agent Orchestration Types
 *
 * Comprehensive types for the world's most advanced multi-agent system,
 * incorporating research from Anthropic, OpenAI, CAMEL, ROMA, AdaptOrch,
 * DOVA, FoA, RecursiveMAS, and other state-of-the-art systems.
 */

import type {
  ModelTier,
  TaskTreeNode,
  ROMARole,
  ArtifactReference,
  ArtifactStore,
} from '../shared/types';
import type { TELOSBudget } from '../telos/types';

// ============================================================================
// Risk & Approval Types
// ============================================================================

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

// ============================================================================
// Orchestration Topologies (Anthropic-aligned canonical 5; 9 legacy names
// retained as @deprecated aliases for the 2-minor-version migration window)
// ============================================================================
//
// D3.2 consolidation: 10 legacy enumeration values have been merged into 5
// canonical patterns that follow the Anthropic "Building effective agents"
// (Oct 2024) ontology (Prompt Chaining / Routing / Parallelization /
// Orchestrator-Workers / Evaluator-Optimizer). See the audit memo in
// docs/audits/ultimate-orchestration-debloat.md for the rationale.
//
// Migrating callers should switch to `OrchestrationTopologyCanonical`
// (the 5-value narrow). The wider `OrchestrationTopology` union still
// accepts all 9 legacy names — each alias is marked `@deprecated` with the
// JSDoc canonical replacement, and `normalizeTopology()` emits a one-line
// `console.warn` per process per deprecated name on first use.

/**
 * Canonical orchestration topology names — Anthropic-aligned set of 5
 * patterns. Use this narrow type for all NEW code.
 *
 *   SINGLE         — single agent, no orchestration (Routing: trivial)
 *   CHAIN          — sequential agent chain (Prompt Chaining)
 *   DISPATCH       — parallel agents aggregated (Parallelization: Section/Vote)
 *   ORCHESTRATOR   — orchestrator + worker hierarchy (Orchestrator-Workers)
 *   REVIEW         — generator + evaluator iterative loop (Evaluator-Optimizer)
 *
 * Topology selection is based on task DAG analysis and cost constraints.
 */
export type OrchestrationTopologyCanonical =
  | 'SINGLE' // Single agent handles everything
  | 'CHAIN' // Sequential chain of agents (formerly SEQUENTIAL / HANDOFF)
  | 'DISPATCH' // Parallel agents aggregated (formerly PARALLEL / ENSEMBLE / CONSENSUS)
  | 'ORCHESTRATOR' // Orchestrator delegates to workers (formerly HIERARCHICAL / HYBRID)
  | 'REVIEW'; // Generator + Evaluator iterative loop (formerly EVALUATOR_OPTIMIZER / DEBATE)

/**
 * Public orchestration topology enumeration. Includes the 5 canonical
 * names plus legacy aliases that are still exercised by tests and by
 * runtime dispatch paths. Legacy aliases are accepted at runtime and
 * normalized to their canonical parent where appropriate.
 */
export type OrchestrationTopology =
  | OrchestrationTopologyCanonical
  // Legacy execution modes — still used for dispatch in orchestrator and
  // coordination policy. Each has a distinct execution path with its own
  // loop, coordination pattern, and performance profile. These are NOT pure
  // aliases even though normalizeTopology maps them to a canonical parent.
  | 'SEQUENTIAL'
  | 'HANDOFF'
  | 'PARALLEL'
  | 'HIERARCHICAL'
  | 'EVALUATOR_OPTIMIZER'
  | 'HYBRID'
  | 'DEBATE'
  | 'ENSEMBLE'
  | 'CONSENSUS';

/**
 * Maps each legacy OrchestrationTopology name to its canonical replacement.
 * Used by `normalizeTopology()` and by `/docs/api/legacy-topology-shim.md`.
 */
export const TOPOLOGY_ALIAS_MAP: Readonly<Record<string, OrchestrationTopologyCanonical>> =
  Object.freeze({
    SEQUENTIAL: 'CHAIN',
    HANDOFF: 'CHAIN',
    PARALLEL: 'DISPATCH',
    ENSEMBLE: 'DISPATCH',
    CONSENSUS: 'DISPATCH',
    HIERARCHICAL: 'ORCHESTRATOR',
    HYBRID: 'ORCHESTRATOR',
    EVALUATOR_OPTIMIZER: 'REVIEW',
    DEBATE: 'REVIEW',
  });

/** Module-level tracker that ensures each deprecated name warns only once per process. */
const warnedTopologyAliases = new Set<string>();

/**
 * Emits a one-line `console.warn` the first time a given deprecated
 * topology name is normalized — per process. Subsequent calls for the same
 * alias are silent (no repeated log spam). The warning is a Node
 * `DeprecationWarning`-style advisory, not an exception, so no behavior
 * changes; it just signals to operators and consumers that migration
 * should happen before the 2-minor-version hard-removal cutoff.
 */
export function warnDeprecatedTopologyOnce(name: string): void {
  if (warnedTopologyAliases.has(name)) return;
  warnedTopologyAliases.add(name);

  console.warn(
    `[DeprecationWarning] OrchestrationTopology "${name}" is deprecated. ` +
      `Use "${TOPOLOGY_ALIAS_MAP[name]}" instead. ` +
      `The legacy name will be hard-removed in 2 minor versions.`,
  );
}

/**
 * Normalizes a topology name to its canonical 5-value form. Returns the
 * input unchanged when it is already canonical. When `name` is one of the
 * legacy aliases (e.g. `'SEQUENTIAL'`), emits a one-line `console.warn`
 * (per process, per name) and returns the mapped canonical.
 *
 * This helper is intended for input-boundary call sites (CLI ingest,
 * telemetry emission, intent-log writes, public API ingest). Legacy
 * aliases are accepted at runtime for backward compatibility even though
 * they are no longer part of the `OrchestrationTopology` type union.
 */
export function normalizeTopology(name: OrchestrationTopology): OrchestrationTopologyCanonical {
  if (Object.prototype.hasOwnProperty.call(TOPOLOGY_ALIAS_MAP, name)) {
    warnDeprecatedTopologyOnce(name);
    return TOPOLOGY_ALIAS_MAP[name] as OrchestrationTopologyCanonical;
  }
  // Named lookups proved `name` is NOT a deprecated alias; since the
  // canonical 5 names exist in the wider union as `OrchestrationTopology`,
  // TS can't narrow it without help. Cast is safe by construction.
  return name as OrchestrationTopologyCanonical;
}

/** Test helper — clears the once-per-process warn cache (for unit tests). */
export function _resetDeprecatedTopologyWarnCacheForTests(): void {
  warnedTopologyAliases.clear();
}

/**
 * Task dependency graph for topology routing.
 */
export interface TaskDAG {
  nodes: TaskDAGNode[];
  edges: TaskDAGEdge[];
  metadata: {
    parallelismWidth: number;
    criticalPathDepth: number;
    interSubtaskCoupling: number; // 0 (independent) to 1 (tightly coupled)
  };
}

export interface TaskDAGNode {
  id: string;
  label: string;
  estimatedComplexity: number; // 1-10
  estimatedTokens: number;
  requiredCapabilities: string[];
  atomic: boolean; // false = needs further decomposition
}

export interface TaskDAGEdge {
  from: string;
  to: string;
  type: 'SEQUENTIAL' | 'PARALLEL' | 'CONDITIONAL';
  dataDependency: boolean; // true if output of 'from' is input of 'to'
}

// ============================================================================
// Deliberation Engine (DOVA-inspired)
// ============================================================================

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
  estimatedAgentCount: number; // Anthropic effort scaling
  estimatedSteps: number;
  estimatedTokens: number;
  estimatedDurationMs: number; // Time budget for the entire execution
  tokenBudget: {
    thinking: number; // tokens for reasoning/planning
    execution: number; // tokens for tool use
    synthesis: number; // tokens for result aggregation
  };
  decompositionStrategy: 'NONE' | 'ASPECT' | 'STEP' | 'RECURSIVE';
  /** Optional agent-role hint propagated by topology-aware decomposition. */
  role?: ROMARole;
  capabilitiesNeeded: string[];
  confidence: number; // 0-1, how well the system understands the task
  reasoning: string[];
  /** SPAgent-inspired: true if early steps are simple evidence-gathering suitable for speculation */
  suitableForSpeculation: boolean;
  /** Astraea-inspired: classify task as I/O-bound (waiting for external data) or compute-bound (LLM reasoning) */
  taskNature: 'IO_BOUND' | 'COMPUTE_BOUND' | 'MIXED';
  /** Chimera-inspired: per-agent time budget in ms, derived from estimatedDurationMs × topology factor */
  timeBudgetPerAgentMs: number;
}

// ============================================================================
// Recursive Decomposition (ROMA-inspired)
// Re-exported from runtime/types — shared across runtime and orchestration layers
// ============================================================================

export type { ROMARole, TaskTreeNode };

// ============================================================================
// Artifact System (Anthropic-inspired)
// Re-exported from runtime/types
// ============================================================================

export type { ArtifactReference, ArtifactStore };

// ============================================================================
// Agent Teams (Claude Code Agent Teams-inspired)
// ============================================================================

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

// ============================================================================
// Capability Registry (FoA-inspired)
// ============================================================================

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
  strength: number; // 0-1
  description: string;
  requiredModels?: string[]; // e.g., ['claude-4-opus', 'gpt-4.1']
}

// ============================================================================
// Effort Scaling Rules (Anthropic-inspired)
// ============================================================================

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
  maxDepth: number; // max recursive decomposition depth
  /** Model tier for lead/synthesizer agents (stronger model). */
  leadModelTier: ModelTier;
  /** Model tier for specialist/atomic agents (cheaper model). */
  specialistModelTier: ModelTier;
}

// ============================================================================
// Thinking Management (Anthropic extended thinking)
// ============================================================================

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

// ============================================================================
// Synthesis
// ============================================================================

/**
 * Strategy for synthesizing results from multiple agents.
 */
export type SynthesisStrategy =
  | 'LEAD_SYNTHESIS' // Orchestrator/lead agent writes final answer
  | 'VOTE' // Agents vote on best answer
  | 'ROUND_ROBIN' // Each agent contributes to sections
  | 'DEBATE' // Agents debate and refine
  | 'HIERARCHICAL' // Recursive aggregation per subtree
  | 'ENSEMBLE'; // Multiple answers, pick best by quality score

export interface SynthesisConfig {
  strategy: SynthesisStrategy;
  maxRounds: number;
  consensusThreshold: number; // 0-1, how much agreement needed
  includeDissent: boolean; // include minority opinions
  qualityGates: QualityGateConfig[];
}

// ============================================================================
// Quality Gates
// ============================================================================

export interface QualityGateConfig {
  [key: string]: unknown;
  name: string;
  type: 'HALLUCINATION_CHECK' | 'CONSISTENCY' | 'COMPLETENESS' | 'ACCURACY' | 'SAFETY';
  enabled: boolean;
  threshold: number;
  autoFix: boolean;
}

// ============================================================================
// Shared State with Per-Key Reducers (LangGraph-inspired)
// ============================================================================

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
  messages: StateFieldDef<Array<{ from: string; subject: string; body: string }>>;
  artifacts: StateFieldDef<string[]>;
  costAccumulator: StateFieldDef<number>;
  currentStep: StateFieldDef<string>;
}

/** The concrete shared state type (inferred from schema) */
export interface SharedState {
  findings: string[];
  errors: string[];
  messages: Array<{ from: string; subject: string; body: string }>;
  artifacts: string[];
  costAccumulator: number;
  currentStep: string;
}

/** Partial update returned by agents — only fields they changed */
export type SharedStateUpdate = Partial<SharedState>;

// ============================================================================
// Ultimate Execution Context
// ============================================================================

/**
 * Complete context for the ultimate multi-agent execution.
 */
export interface UltimateExecutionContext {
  id: string;
  projectId: string;
  /** Optional tenant id for multi-tenant routing/learning isolation. */
  tenantId?: string;
  goal: string;
  context: Record<string, unknown>;
  sharedState: SharedState;

  // Deliberation phase output
  deliberation?: DeliberationPlan;

  // Effort scaling
  effortLevel: EffortLevel;
  scalingRules: EffortScalingRules;

  // Topology
  topology: OrchestrationTopology;
  taskDAG?: TaskDAG;

  // Decomposition
  taskTree?: TaskTreeNode;

  // Artifacts created during execution
  artifacts: ArtifactReference[];

  // Teams
  team?: AgentTeam;

  // Budget
  budget: TELOSBudget;
  thinkingBudget: ThinkingBudget;

  // Synthesis
  synthesisConfig: SynthesisConfig;

  // Governance
  governance: {
    requiresApproval: boolean;
    approvalGateAt?: 'PLAN' | 'EXECUTION' | 'DEPLOYMENT';
    humanInTheLoop: boolean;
  };

  // Error handling
  maxRetries: number;
  circuitBreaker: {
    maxErrors: number;
    cooldownMs: number;
    currentErrors: number;
    tripped: boolean;
  };
}

// ============================================================================
// Ultimate Execution Result
// ============================================================================

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
  qualityScore: number; // 0-1
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

// ============================================================================
// Runtime Workflow Adapter Types (Phase 3.5)
// ============================================================================

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

// ============================================================================
// Config
// ============================================================================

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

export const DEFAULT_THINKING_BUDGET: ThinkingBudget = {
  enabled: true,
  maxThinkingTokens: 4096,
  subAgentThinkingTokens: 1024,
  minThinkingBeforeTools: 256,
};

export const DEFAULT_SYNTHESIS_CONFIG: SynthesisConfig = {
  strategy: 'LEAD_SYNTHESIS',
  maxRounds: 2,
  consensusThreshold: 0.7,
  includeDissent: true,
  qualityGates: [
    {
      name: 'hallucination',
      type: 'HALLUCINATION_CHECK',
      enabled: true,
      threshold: 0.8,
      autoFix: false,
    },
    { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: false },
    { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
  ],
};

export const DEFAULT_ULTIMATE_CONFIG: UltimateOrchestratorConfig = {
  defaultBudget: { hardCapTokens: 128000, softCapTokens: 96000, costCapUsd: 5.0 },
  defaultThinkingBudget: DEFAULT_THINKING_BUDGET,
  defaultSynthesisConfig: DEFAULT_SYNTHESIS_CONFIG,
  defaultEffortLevel: 'MODERATE',
  maxRecursiveDepth: 3,
  maxParallelSubAgents: 10,
  enableDeliberation: true,
  enableArtifactSystem: true,
  enableTeams: true,
  enableCapabilityRouting: true,
  enableCircuitBreaker: true,
  qualityGates: [
    {
      name: 'hallucination',
      type: 'HALLUCINATION_CHECK',
      enabled: true,
      threshold: 0.8,
      autoFix: true,
    },
    { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: true },
    { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
    { name: 'accuracy', type: 'ACCURACY', enabled: true, threshold: 0.7, autoFix: false },
    { name: 'safety', type: 'SAFETY', enabled: true, threshold: 0.9, autoFix: false },
  ],
  modelTierMapping: {
    SIMPLE: 'eco',
    MODERATE: 'standard',
    COMPLEX: 'power',
    DEEP_RESEARCH: 'consensus',
  },
};
