/**
 * Orchestration Module
 *
 * Provides multi-agent orchestration patterns based on Microsoft AI Agent Orchestration Patterns.
 * Reference: research-notes.md - Multi-Agent Orchestration Patterns (2026-04-09)
 */

// Sequential Pattern (Priority P0)
export * from './sequential';
export * from './executor';
// Parallel Task Pool
export { TaskPool } from './taskPool';
export type { PoolTask, PoolResult, PoolConfig } from './taskPool';
