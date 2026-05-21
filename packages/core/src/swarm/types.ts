/**
 * Swarm Module — 递归分解 + 子 Manager 自裂变 + Fusion 冲突检测
 *
 * Phase 2 of the drive/swarm roadmap:
 * Manager spawns child managers for complex sub-goals,
 * Fusion engine detects cross-worker conflicts,
 * Fission decisions based on goal complexity.
 */

import type { GoalConfig, CritiqueResult } from '../goal/types';

// ============================================================================
// Swarm Configuration
// ============================================================================

export interface SwarmConfig {
  /** Base goal config for each manager's local loop */
  goalConfig: Partial<GoalConfig>;
  /** Maximum recursion depth (default: 3) */
  maxDepth: number;
  /** Maximum parallel workers across the entire tree (default: 10) */
  maxWorkers: number;
  /** Complexity score threshold (1-10) for fission decision (default: 5) */
  fissionThreshold: number;
  /** Enable tool-backed workers via AgentRuntime (default: false) */
  enableWorkerTools: boolean;
  /** Model to use for all LLM calls */
  model?: string;
  /** Restrict worker tools to these names (requires enableWorkerTools) */
  workerToolNames?: string[];
}

export const DEFAULT_SWARM_CONFIG: SwarmConfig = {
  goalConfig: {},
  maxDepth: 3,
  maxWorkers: 10,
  fissionThreshold: 5,
  enableWorkerTools: false,
};

// ============================================================================
// Swarm Tree
// ============================================================================

export interface SwarmNode {
  id: string;
  goal: string;
  parentId: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 're_opened';
  workerOutput?: string;
  critique?: CritiqueResult;
  /** Locally-decomposed sub-nodes (from this manager's decomposition, non-recursive) */
  subNodes: SwarmNode[];
  /** Child managers spawned by fission (recursive decomposition) */
  children: SwarmManager[];
  dependencies: string[];
  metadata?: Record<string, unknown>;
}

export interface SwarmManager {
  id: string;
  goal: string;
  depth: number;
  /** The full decomposition hierarchy for this child manager */
  topology: SwarmTopology;
  /** Execution result */
  result?: SwarmResult;
}

export interface SwarmTopology {
  /** Total managers spawned in this sub-tree (including self) */
  managerCount: number;
  /** Total nodes (sub-nodes across all managers in this sub-tree) */
  totalNodes: number;
  /** Max depth reached in this sub-tree */
  depth: number;
  /** Breadth (number of root-level sub-goals) at each level */
  levelBreaths: number[];
}

// ============================================================================
// Fusion Engine
// ============================================================================

export interface FusionConflict {
  type: 'file_overlap' | 'dependency_cycle' | 'logical_contradiction' | 'resource_contention';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  nodeIds: string[];
  suggestedResolution?: string;
}

export interface FusionReport {
  round: number;
  conflicts: FusionConflict[];
  resolvedCount: number;
  summary: string;
}

// ============================================================================
// Swarm Result
// ============================================================================

export type SwarmStatus = 'completed' | 'partial' | 'failed';

export interface SwarmResult {
  goal: string;
  status: SwarmStatus;
  totalRounds: number;
  totalTokensUsed: number;
  totalDurationMs: number;
  topology: SwarmTopology;
  rootNodes: SwarmNode[];
  fusionReports: FusionReport[];
  summary: string;
}
