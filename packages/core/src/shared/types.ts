/**
 * Shared Neutral Types
 *
 * Types that are used by both the runtime execution layer and higher-level
 * orchestration layers (ultimate, drive, etc.) live here.  Keeping them in a
 * neutral module prevents higher layers from depending on runtime internals just
 * to describe task trees, artifacts, or model tiers.
 */

/**
 * Token usage tracking.
 *
 * Cache fields are optional — only providers that support prompt caching
 * (Anthropic, OpenAI, Gemini) populate them.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Tokens served from prompt cache (Anthropic cache_read, OpenAI cached_tokens, Gemini cachedContent) */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache (Anthropic cache_creation, OpenAI implicit on first hit) */
  cacheWriteTokens?: number;
}

/**
 * Model capability tiers for routing decisions.
 */
export type ModelTier = 'eco' | 'standard' | 'power' | 'consensus';

// ============================================================================
// Recursive Decomposition Types (shared across runtime and orchestration)
// ============================================================================

/**
 * ROMA's core roles for recursive agent construction, extended with
 * topology-specific roles so the atomizer can tag sub-agents for their
 * execution semantics (debate, ensemble, consensus, handoff, evaluator-optimizer).
 */
export type ROMARole =
  | 'ATOMIZER'
  | 'PLANNER'
  | 'EXECUTOR'
  | 'AGGREGATOR'
  | 'HANDOFF_AGENT_1'
  | 'HANDOFF_AGENT_2'
  | 'HANDOFF_AGENT_3'
  | 'HANDOFF_AGENT_4'
  | 'HANDOFF_AGENT_5'
  | 'HANDOFF_AGENT_6'
  | 'HANDOFF_AGENT_7'
  | 'HANDOFF_AGENT_8'
  | 'DEBATER_1'
  | 'DEBATER_2'
  | 'DEBATER_3'
  | 'DEBATER_4'
  | 'DEBATER_5'
  | 'DEBATER_6'
  | 'DEBATER_7'
  | 'DEBATER_8'
  | 'JUDGE'
  | 'VOTER_1'
  | 'VOTER_2'
  | 'VOTER_3'
  | 'VOTER_4'
  | 'VOTER_5'
  | 'VOTER_6'
  | 'VOTER_7'
  | 'VOTER_8'
  | 'CONSENSUS_AGENT_1'
  | 'CONSENSUS_AGENT_2'
  | 'CONSENSUS_AGENT_3'
  | 'CONSENSUS_AGENT_4'
  | 'CONSENSUS_AGENT_5'
  | 'CONSENSUS_AGENT_6'
  | 'CONSENSUS_AGENT_7'
  | 'CONSENSUS_AGENT_8'
  | 'IMPLEMENTER'
  | 'EVALUATOR';

/**
 * Reference to a stored artifact.
 * Instead of passing full content, agents pass lightweight references.
 */
export interface ArtifactReference {
  id: string;
  type: 'RESEARCH_FINDING' | 'CODE_DIFF' | 'ANALYSIS' | 'SUMMARY' | 'REPORT' | 'RAW_DATA';
  title: string;
  summary: string;
  createdBy: string;
  createdAt: string;
  tokenCount: number;
  tags: string[];
  content?: string;
  externalUri?: string;
}

/**
 * Shared artifact store for agent communication.
 */
export interface ArtifactStore {
  write(
    artifact: Omit<ArtifactReference, 'id' | 'createdAt'>,
    content: string,
  ): Promise<ArtifactReference>;
  read(id: string): Promise<ArtifactReference | null>;
  find(tags: string[], type?: string): Promise<ArtifactReference[]>;
  delete(id: string): Promise<boolean>;
}

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
  dependencies: string[];
  context: {
    systemPrompt: string;
    availableTools: string[];
    estimatedTokens: number;
    splitFrom?: string;
    mergedFrom?: string[];
  };
  artifact?: ArtifactReference;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'SKIPPED';
  result?: string;
  fullSubtaskResults?: string;
  tokenUsage?: TokenUsage;
  durationMs?: number;
  estimatedDurationMs?: number;
  isOnCriticalPath?: boolean;
  preferredModelTier?: ModelTier;
  /** AgentLineage instance ID (Phase 2.2) — set by subAgentExecutor on spawn. */
  lineageInstanceId?: string;
}
