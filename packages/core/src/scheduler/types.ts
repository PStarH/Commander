/**
 * Scheduler — types for repeatable workflow automation.
 *
 * Architecture:
 *   WorkflowDefinition  →  a named, reusable unit of work (loaded from markdown)
 *   ScheduleEntry       →  a workflow bound to a trigger (cron/webhook/manual)
 *   Scheduler           →  watches ScheduleEntries, fires workflows on trigger
 *
 * Triggers supported initially:
 *   - "cron": standard 5-field cron expression
 *   - "interval": simple seconds/minutes/hours
 *   - "once": fire at an absolute ISO time
 *
 * Future triggers (designed for, not yet wired):
 *   - "webhook": POST to an endpoint triggers the workflow
 *   - "github:pr.opened", "github:push": GitHub event triggers
 */

import type { EffortLevel, OrchestrationTopology } from '../ultimate/types';

// ============================================================================
// Workflow Definition — the "what"
// ============================================================================

export interface WorkflowDefinition {
  /** Kebab-case identifier, derived from filename */
  id: string;
  /** Human-readable name from YAML frontmatter */
  name: string;
  /** Short description of what this workflow does */
  description: string;
  /** The task goal — passed directly as the `goal` to UltimateOrchestrator */
  goal: string;
  /** Ordered list of steps (parsed from markdown body) */
  steps: WorkflowStep[];
  /** When Commander should trigger this workflow */
  triggers: WorkflowTrigger[];
  /** Orchestration hints */
  topology?: OrchestrationTopology;
  effort?: EffortLevel;
  agentCount?: number;
  /** File path this was loaded from */
  sourcePath: string;
  /** Whether this was loaded from project or user scope */
  scope: 'project' | 'user';
}

export interface WorkflowStep {
  id: string;
  goal: string;
  tools: string[];
  modelTier: 'cheap' | 'standard' | 'best';
  parallelizable: boolean;
  dependsOn: string[];
  timeoutMs: number;
}

export interface WorkflowTrigger {
  type: 'cron' | 'interval' | 'once';
  /** 5-field cron: "0 6 * * 1" = Mondays 6am */
  cron?: string;
  /** e.g. "30m", "2h", "1d" */
  interval?: string;
  /** ISO 8601 timestamp for one-shot */
  at?: string;
  /** Human label for logs */
  label: string;
}

// ============================================================================
// Schedule Entry — a bound instance (what + when + status)
// ============================================================================

export interface ScheduleEntry {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: WorkflowTrigger;
  /** ISO timestamp of when this schedule was created */
  createdAt: string;
  /** ISO timestamp of last execution attempt */
  lastRunAt?: string;
  /** ISO timestamp of next scheduled run */
  nextRunAt?: string;
  /** Running count */
  runCount: number;
  /** Whether this schedule is active */
  enabled: boolean;
  /** Tags for grouping/filtering */
  tags: string[];
}

// ============================================================================
// Execution Record — persisted after each run
// ============================================================================

export interface ExecutionRecord {
  id: string;
  scheduleId: string;
  workflowId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'failed' | 'cancelled';
  summary?: string;
  error?: string;
  durationMs?: number;
  tokenUsage?: { input: number; output: number; total: number };
}

// ============================================================================
// Scheduler Config
// ============================================================================

export interface SchedulerConfig {
  /** How often the scheduler checks for due tasks (ms). Default: 30_000 */
  tickIntervalMs: number;
  /** Max workflows running concurrently. Default: 3 */
  maxConcurrency: number;
  /** Where to persist schedule state */
  stateDir: string;
  /** Where to discover workflow definitions */
  workflowDirs: string[];
}
