/**
 * Pillar IV: Differentiable Memory & Cognitive Evolution — Abstract Interface Contracts
 *
 * Per Commander Ultimate Architecture Blueprint Section 5.3.
 * All contracts are abstract interfaces with zero external dependencies.
 *
 * Three-layer hybrid memory architecture:
 *   Episodic  → time-indexed experiences (temporal proximity + context match)
 *   Semantic  → entity-relationship knowledge (vector + graph retrieval)
 *   Procedural → tool-use production rules (specificity + utility ordering)
 */

// ============================================================================
// Episodic Memory Store
// ============================================================================

/**
 * An episodic experience record.
 */
export interface IEpisodicRecord {
  /** Unique identifier */
  id: string;
  /** Timestamp of the experience */
  timestamp: number;
  /** Context in which the experience occurred */
  context: string;
  /** Action taken */
  action: string;
  /** Outcome of the action */
  outcome: string;
  /** ACT-R base-level activation: B_i(t) = ln(Σ(t - t_j)^-d) */
  activation: number;
  /** Tags for categorization */
  tags: string[];
}

/**
 * Episodic Memory Store — time-indexed experiences.
 *
 * Per constraint PIV-FR-02, uses temporal graph representation.
 * Supports decay (episodic memories fade unless reinforced),
 * reinforcement (increase activation on access), and
 * context+temporal retrieval.
 */
export interface IEpisodicStore {
  /** Record a new experience */
  record(experience: Omit<IEpisodicRecord, 'id' | 'activation'>): Promise<IEpisodicRecord>;
  /** Recall experiences matching context and time range */
  recall(query: EpisodicQuery): Promise<IEpisodicRecord[]>;
  /** Reinforce an experience (increase activation) */
  reinforce(id: string): Promise<void>;
  /** Apply time-based decay to all episodic memories */
  applyDecay(hoursElapsed: number): Promise<number>;
}

export interface EpisodicQuery {
  /** Context to match */
  context?: string;
  /** Time range start (ISO string) */
  since?: string;
  /** Time range end (ISO string) */
  until?: string;
  /** Tags to filter by */
  tags?: string[];
  /** Maximum results */
  limit?: number;
  /** Minimum activation threshold */
  minActivation?: number;
}

// ============================================================================
// Semantic Memory Store
// ============================================================================

/**
 * A semantic knowledge entity.
 */
export interface ISemanticEntity {
  /** Unique identifier */
  id: string;
  /** Entity name/label */
  name: string;
  /** Entity type */
  type: string;
  /** Textual description */
  description: string;
  /** Vector embedding */
  embedding?: number[];
  /** Relationships to other entities */
  relationships: SemanticRelationship[];
}

export interface SemanticRelationship {
  /** Target entity ID */
  targetId: string;
  /** Relationship type (e.g., "depends_on", "implements", "contradicts") */
  type: string;
  /** Relationship strength (0-1) */
  strength: number;
}

/**
 * Semantic Memory Store — entity-relationship knowledge with vector embeddings.
 *
 * Per constraint PIV-FR-03, uses high-dimensional vector embeddings
 * for similarity search. Per constraint NFR-PERF-08, vector similarity
 * search must be <5ms.
 */
export interface ISemanticStore {
  /** Ingest knowledge with relationships */
  ingest(entity: Omit<ISemanticEntity, 'id'>): Promise<ISemanticEntity>;
  /** Hybrid vector+graph retrieval */
  query(query: SemanticQuery): Promise<ISemanticEntity[]>;
  /** Navigate graph paths between entities */
  traverse(fromId: string, toId: string, maxDepth?: number): Promise<SemanticRelationship[][]>;
}

export interface SemanticQuery {
  /** Text query for vector similarity */
  text?: string;
  /** Entity type filter */
  type?: string;
  /** Relationship type filter */
  relationshipType?: string;
  /** Maximum results */
  limit?: number;
  /** Minimum similarity threshold */
  minSimilarity?: number;
}

// ============================================================================
// Procedural Memory Store
// ============================================================================

/**
 * A production rule in procedural memory.
 *
 * IF context ∧ goal THEN action
 * Ordered by specificity + utility.
 */
export interface IProductionRule {
  /** Unique identifier */
  id: string;
  /** Context conditions (IF part) */
  conditions: string[];
  /** Goal this rule achieves */
  goal: string;
  /** Action to take (THEN part) */
  action: string;
  /** Utility: success_count / invocation_count */
  utility: number;
  /** Number of times invoked */
  invocationCount: number;
  /** Number of times succeeded */
  successCount: number;
  /** Procedural type */
  proceduralType: 'sop' | 'tool' | 'workflow' | 'heuristic';
}

/**
 * Procedural Memory Store — tool-use production rules.
 *
 * Per constraint PIV-FR-04, stores tool muscle memory (skill patterns).
 * Per constraint PIV-FR-11, supports transfer learning across agents.
 */
export interface IProceduralStore {
  /** Learn a new production rule */
  learn(rule: Omit<IProductionRule, 'id' | 'utility' | 'invocationCount' | 'successCount'>): Promise<IProductionRule>;
  /** Select rules matching the current context */
  select(context: string, goal?: string): Promise<IProductionRule[]>;
  /** Compile declarative knowledge into procedural rules */
  compile(episodicId: string): Promise<IProductionRule | null>;
  /** Transfer a rule to another agent */
  transfer(ruleId: string, targetAgentId: string): Promise<boolean>;
  /** Update rule utility after execution */
  updateUtility(ruleId: string, success: boolean): Promise<void>;
}

// ============================================================================
// Unified Memory System
// ============================================================================

/**
 * Unified Memory System facade — the single API for all memory operations.
 *
 * Per constraint PIV-FR-05, supports hybrid addressing (cross-layer queries).
 * Implements joint scoring: score = w1·episodic + w2·semantic + w3·procedural
 */
export interface IMemorySystem {
  /** Write to the appropriate layer(s) */
  store(entry: MemoryInput): Promise<string>;
  /** Joint-scored retrieval across all layers */
  retrieve(query: MemoryQuery): Promise<MemoryResult[]>;
  /** Cross-layer consolidation (episodic→semantic, declarative→procedural) */
  consolidate(): Promise<ConsolidationReport>;
  /** Generate self-reflection from recent experiences */
  reflect(context?: string): Promise<ReflectionOutput>;
}

export interface MemoryInput {
  content: string;
  context?: string;
  importance?: number;
  tags?: string[];
  /** Which layer to target (auto-determined if omitted) */
  targetLayer?: 'episodic' | 'semantic' | 'procedural';
  /** Project scope */
  projectId: string;
}

export interface MemoryQuery {
  query: string;
  projectId: string;
  /** Layer weights for joint scoring (defaults: 0.3/0.4/0.3) */
  layerWeights?: { episodic: number; semantic: number; procedural: number };
  /** Maximum results */
  limit?: number;
  /** Minimum relevance threshold */
  minRelevance?: number;
}

export interface MemoryResult {
  id: string;
  content: string;
  source: 'episodic' | 'semantic' | 'procedural';
  score: number;
  /** Breakdown of the joint score */
  scoreBreakdown: { episodic: number; semantic: number; procedural: number };
}

export interface ConsolidationReport {
  /** Episodic → Semantic promotions */
  promoted: number;
  /** Declarative → Procedural compilations */
  compiled: number;
  /** Deduplicated entries */
  deduplicated: number;
  /** Decayed and removed entries */
  decayed: number;
}

export interface ReflectionOutput {
  /** Self-critique text */
  critique: string;
  /** Suggested improvements */
  suggestions: string[];
  /** Confidence in the reflection (0-1) */
  confidence: number;
}

// ============================================================================
// Meta-Learner
// ============================================================================

/**
 * Meta-Learner for strategy optimization.
 *
 * Per constraint PIV-FR-07, implements Meta-Learner architecture.
 * Per constraint PIV-FR-08, uses Thompson Sampling for
 * exploration/exploitation trade-off.
 */
export interface IMetaLearner {
  /** Update layer weights based on retrieval feedback */
  updateWeights(feedback: RetrievalFeedback): void;
  /** Select the optimal strategy for a given context */
  selectStrategy(context: StrategyContext): StrategySelection;
  /** Evaluate a strategy's effectiveness */
  evaluate(strategyId: string): StrategyEvaluation;
}

export interface RetrievalFeedback {
  /** Which layers contributed to the result */
  layersUsed: Array<'episodic' | 'semantic' | 'procedural'>;
  /** Whether the retrieval was useful */
  wasUseful: boolean;
  /** Task difficulty (affects learning rate) */
  taskDifficulty?: number;
}

export interface StrategyContext {
  taskType: string;
  availableStrategies: string[];
  modelId?: string;
}

export interface StrategySelection {
  strategyId: string;
  confidence: number;
  explorationBonus: number;
}

export interface StrategyEvaluation {
  strategyId: string;
  meanUtility: number;
  sampleCount: number;
  regret: number;
}

// ============================================================================
// Reflexion Loop
// ============================================================================

/**
 * Reflexion Loop for self-improving agent behavior.
 *
 * Per constraint PIV-FR-06, implements Reflexion Loop.
 * Per constraint PIV-FR-12, generates explicit reasoning traces.
 */
export interface IReflexionLoop {
  /** Evaluate an execution outcome */
  evaluate(outcome: ExecutionOutcome): ReflexionVerdict;
  /** Generate a self-critique reflection */
  generateReflection(outcome: ExecutionOutcome): Promise<ReflectionOutput>;
  /** Incorporate a reflection into memory */
  incorporate(reflection: ReflectionOutput): Promise<void>;
  /** Track improvement over time */
  getImprovements(): ImprovementTrend[];
}

export interface ExecutionOutcome {
  /** Whether the task succeeded */
  success: boolean;
  /** Task description */
  task: string;
  /** Execution latency in ms */
  latencyMs: number;
  /** Token cost */
  tokenCost: number;
  /** User satisfaction signal (0-1, if available) */
  userSatisfaction?: number;
}

export type ReflexionVerdict = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';

export interface ImprovementTrend {
  /** Time period */
  period: string;
  /** Success rate trend */
  successRateTrend: 'improving' | 'declining' | 'stable';
  /** Average latency trend */
  latencyTrend: 'improving' | 'declining' | 'stable';
  /** Token efficiency trend */
  tokenEfficiencyTrend: 'improving' | 'declining' | 'stable';
}
