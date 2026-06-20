/**
 * Orchestration Module
 *
 * Provides multi-agent orchestration patterns based on Microsoft AI Agent Orchestration Patterns.
 * Reference: research-notes.md - Multi-Agent Orchestration Patterns (2026-04-09)
 */

// Base Orchestrator — shared tree helpers, LLM wrappers, decision logic
export {
  generateNodeId,
  findNodeById,
  collectAllNodes,
  countActiveNodes,
  cloneTree,
  getPendingNodes,
  callLLMWithValidation,
  sharedWorkerExecute,
  sharedCriticEvaluate,
  sharedManagerDecompose,
  sharedManagerReview,
  buildTree,
  applyReview,
  computePlateauThreshold,
  hasCriticalFindings,
  computeFindingsFingerprint,
  computeImprovementRate,
  makeBaseDecision,
  buildBaseSummary,
  SHARED_CRITIC_PROMPT,
  SHARED_WORKER_PROMPT,
  SHARED_MANAGER_DECOMPOSE_PROMPT,
  SHARED_MANAGER_REVIEW_PROMPT,
} from './baseOrchestrator';
export type {
  NodeStatus,
  BaseNode,
  LLMJSONResult,
  WorkerExecuteOptions,
  CriticEvaluateOptions,
  CriticOutput,
  DecompositionSubGoal,
  DecompositionOutput,
  ReviewAssessment,
  ReviewOutput,
  BuildTreeOptions,
  DecisionConfig,
  DecisionResult,
} from './baseOrchestrator';

// Sequential Pattern (Priority P0)
export * from './sequential';
export * from './executor';
// Parallel Task Pool
export { TaskPool } from './taskPool';
export type { PoolTask, PoolResult, PoolConfig } from './taskPool';
// Task Framework
export {
  createTask,
  updateTaskStatus,
  appendTaskOutput,
  readTaskOutput,
  killTask,
  getTask,
  listTasks,
  cleanupTask,
  getActiveCount,
} from './task';
export type { TaskType, TaskStatus, TaskHandle, TaskSpec } from './task';
