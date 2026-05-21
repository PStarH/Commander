/**
 * Public types for the Commander Agent SDK.
 */

import type {
  AgentExecutionContext,
  OrchestrationTopology,
  EffortLevel,
} from '@commander/core';

/** Configuration for creating a CommanderClient. */
export interface CommanderClientConfig {
  /** API key for the LLM provider. Defaults to env vars (OPENAI_API_KEY, etc.). */
  apiKey?: string;
  /** LLM provider type ('openai', 'anthropic', 'google', etc.). Auto-detected from env if omitted. */
  provider?: string;
  /** Model identifier. Auto-selected if omitted. */
  model?: string;
  /** Max token budget for execution. Default: 64000. */
  tokenBudget?: number;
  /** Base URL for the provider API (for self-hosted/compatible APIs). */
  baseUrl?: string;
}

/** Result of a Commander execution. */
export interface ExecutionResult {
  /** Final status. */
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  /** Human-readable summary. */
  summary: string;
  /** Individual execution steps. */
  steps: ExecutionStepSummary[];
  /** Total tokens consumed. */
  totalTokenUsage: number;
  /** Total execution time in milliseconds. */
  totalDurationMs: number;
  /** Error message if failed. */
  error?: string;
}

/** Summary of a single execution step. */
export interface ExecutionStepSummary {
  stepNumber: number;
  action: string;
  status: string;
  tokenUsage: number;
  durationMs: number;
}

/** Event emitted during streaming execution. */
export interface ExecutionEvent {
  type: 'agent.started' | 'agent.completed' | 'agent.failed' | 'agent.message'
      | 'tool.executed' | 'system.alert' | 'output.delta' | 'output.completed'
      | 'reasoning.delta';
  timestamp: string;
  data: Record<string, unknown>;
}

/** Summary of an execution session (past or in-progress). */
export interface SessionSummary {
  runId: string;
  task: string;
  status: string;
  timestamp: string;
}

/** System status snapshot. */
export interface SystemStatus {
  provider: string;
  model: string;
  uptime: string;
  totalRuns: number;
  activeSessions: number;
  memoryUsage: number;
}
