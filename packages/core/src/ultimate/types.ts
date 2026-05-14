/**
 * Ultimate Multi-Agent Orchestration Types
 *
 * Comprehensive types for the world's most advanced multi-agent system,
 * incorporating research from Anthropic, OpenAI, CAMEL, ROMA, AdaptOrch,
 * DOVA, FoA, RecursiveMAS, and other state-of-the-art systems.
 */

import type { ModelTier, TokenUsage } from '../runtime/types';
import type { TELOSBudget } from '../telos/types';

// ============================================================================
// Orchestration Topologies (AdaptOrch-inspired)
// ============================================================================

/**
 * Canonical orchestration topologies.
 * AdaptOrch research shows topology selection alone yields 12-23% improvement.
 */
export type OrchestrationTopology =
  | 'SINGLE'         // Single agent handles everything
  | 'SEQUENTIAL'     // Chain of agents, one after another
  | 'PARALLEL'       // Multiple agents in parallel, then synthesize
  | 'HIERARCHICAL'   // Orchestrator delegates to workers with recursive decomposition
  | 'HYBRID'         // Mixed topology based on subtask dependencies
  | 'DEBATE'         // Multiple agents debate to reach consensus
  | 'ENSEMBLE'       // Multiple agents independently solve, then vote
  | 'EVALUATOR_OPTIMIZER' // Generator + Evaluator iterative loop
  ;

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
  estimatedAgentCount: number; // Anthropic effort scaling
  estimatedSteps: number;
  estimatedTokens: number;
  tokenBudget: {
    thinking: number;   // tokens for reasoning/planning
    execution: number;  // tokens for tool use
    synthesis: number;  // tokens for result aggregation
  };
  decompositionStrategy: 'NONE' | 'ASPECT' | 'STEP' | 'RECURSIVE';
  capabilitiesNeeded: string[];
  confidence: number; // 0-1, how well the system understands the task
  reasoning: string[];
}

// ============================================================================
// Recursive Decomposition (ROMA-inspired)
// ============================================================================

/**
 * ROMA's four core roles for recursive agent construction.
 */
export type ROMARole = 'ATOMIZER' | 'PLANNER' | 'EXECUTOR' | 'AGGREGATOR';

/**
 * A node in the recursive task decomposition tree.
 */
export interface TaskTreeNode {
  id: string;
  parentId: string | null;
  goal: string;
  role: ROMARole;
  isAtomic: boolean;
  subtasks: TaskTreeNode[];
  dependencies: string[]; // IDs of sibling tasks this depends on
  context: {
    systemPrompt: string;
    availableTools: string[];
    estimatedTokens: number;
  };
  artifact?: ArtifactReference;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL';
  result?: string;
  tokenUsage?: TokenUsage;
  durationMs?: number;
}

// ============================================================================
// Artifact System (Anthropic-inspired)
// ============================================================================

/**
 * Reference to a stored artifact.
 * Instead of passing full content, agents pass lightweight references.
 * The artifact pattern prevents information loss from "telephone game."
 */
export interface ArtifactReference {
  id: string;
  type: 'RESEARCH_FINDING' | 'CODE_DIFF' | 'ANALYSIS' | 'SUMMARY' | 'REPORT' | 'RAW_DATA';
  title: string;
  summary: string; // ~100 char summary for the orchestrator
  createdBy: string; // agent ID
  createdAt: string;
  tokenCount: number;
  tags: string[];
  /** The actual stored content (retrieved on demand) */
  content?: string;
  /** If stored externally, the URI to fetch from */
  externalUri?: string;
}

/**
 * Shared artifact store for agent communication.
 */
export interface ArtifactStore {
  write(artifact: Omit<ArtifactReference, 'id' | 'createdAt'>, content: string): Promise<ArtifactReference>;
  read(id: string): Promise<ArtifactReference | null>;
  find(tags: string[], type?: string): Promise<ArtifactReference[]>;
  delete(id: string): Promise<boolean>;
}

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
  | 'LEAD_SYNTHESIS'     // Orchestrator/lead agent writes final answer
  | 'VOTE'               // Agents vote on best answer
  | 'ROUND_ROBIN'        // Each agent contributes to sections
  | 'DEBATE'             // Agents debate and refine
  | 'HIERARCHICAL'       // Recursive aggregation per subtree
  | 'ENSEMBLE'           // Multiple answers, pick best by quality score
  ;

export interface SynthesisConfig {
  strategy: SynthesisStrategy;
  maxRounds: number;
  consensusThreshold: number; // 0-1, how much agreement needed
  includeDissent: boolean;    // include minority opinions
  qualityGates: QualityGateConfig[];
}

// ============================================================================
// Quality Gates
// ============================================================================

export interface QualityGateConfig {
  name: string;
  type: 'HALLUCINATION_CHECK' | 'CONSISTENCY' | 'COMPLETENESS' | 'ACCURACY' | 'SAFETY';
  enabled: boolean;
  threshold: number; // 0-1 pass threshold
  autoFix: boolean;  // attempt auto-fix if fails
}

// ============================================================================
// Ultimate Execution Context
// ============================================================================

/**
 * Complete context for the ultimate multi-agent execution.
 */
export interface UltimateExecutionContext {
  id: string;
  projectId: string;
  goal: string;
  context: Record<string, unknown>;

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
// Config
// ============================================================================

export interface UltimateOrchestratorConfig {
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
    { name: 'hallucination', type: 'HALLUCINATION_CHECK', enabled: true, threshold: 0.8, autoFix: false },
    { name: 'consistency', type: 'CONSISTENCY', enabled: true, threshold: 0.7, autoFix: false },
    { name: 'completeness', type: 'COMPLETENESS', enabled: true, threshold: 0.6, autoFix: false },
  ],
};

export const DEFAULT_ULTIMATE_CONFIG: UltimateOrchestratorConfig = {
  defaultBudget: { hardCapTokens: 128000, softCapTokens: 96000, costCapUsd: 5.00 },
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
    { name: 'hallucination', type: 'HALLUCINATION_CHECK', enabled: true, threshold: 0.8, autoFix: true },
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
