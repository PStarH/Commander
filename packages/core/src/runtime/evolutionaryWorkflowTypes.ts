/**
 * Types for the Evolutionary Workflow Engine.
 * Extracted from evolutionaryWorkflowEngine.ts to keep modules under 500 lines.
 */

import type { TaskTreeNode } from './types';

// ============================================================================
// Workflow gene encoding
// ============================================================================

/** A workflow node — represents a subtask or tool call */
export interface WorkflowNode {
  id: string;
  type: 'agent' | 'tool' | 'condition' | 'merge';
  goal: string;
  tools: string[];
  modelTier: string;
  parallelizable: boolean;
  timeoutMs: number;
  maxRetries: number;
}

/** A workflow edge — dependency between nodes */
export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
  weight: number;
}

/** A workflow DAG — the complete evolutionary individual */
export interface WorkflowDAG {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  fitness: number;
  generation: number;
  taskType: string;
  createdAt: string;
  lastEvaluatedAt?: string;
  executionCount: number;
  avgDurationMs: number;
  avgQualityScore: number;
  avgTokenCost: number;
}

// ============================================================================
// Evolution config (internal)
// ============================================================================

export interface EvolutionConfig {
  populationSize: number;
  maxGenerations: number;
  mutationRate: number;
  crossoverRate: number;
  elitismRate: number;
  minFitnessThreshold: number;
  stagnationGenerations: number;
  evaluationMethod: 'simulation' | 'execution' | 'hybrid';
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  populationSize: 10,
  maxGenerations: 50,
  mutationRate: 0.15,
  crossoverRate: 0.7,
  elitismRate: 0.2,
  minFitnessThreshold: 0.7,
  stagnationGenerations: 10,
  evaluationMethod: 'hybrid',
};

// ============================================================================
// Workflow evaluator types (internal)
// ============================================================================

export interface WorkflowEvaluatorConfig {
  maxSimulationSteps?: number;
  costWeight?: number;
  qualityWeight?: number;
  speedWeight?: number;
}

export interface WorkflowScore {
  overall: number;
  quality: number;
  cost: number;
  speed: number;
  reliability: number;
}

// ============================================================================
// Public API types
// ============================================================================

export interface EvolutionResult {
  bestDag: WorkflowDAG;
  generations: number;
  populationStats: Array<{
    generation: number;
    bestFitness: number;
    avgFitness: number;
  }>;
  taskTree: TaskTreeNode;
  improvements: string[];
}

export interface EvolutionOptions {
  taskType: string;
  availableTools: string[];
  existingTree?: TaskTreeNode;
  generations?: number;
  populationSize?: number;
  maxDurationSeconds?: number;
}
