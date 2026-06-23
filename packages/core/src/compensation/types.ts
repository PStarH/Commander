/**
 * Compensation types and helpers used by the rollback planner.
 *
 * Originally part of compensation/external/types.ts; moved here when the
 * unused external handler directory was removed.
 */

import type { CompensableAction } from '../runtime/compensationRegistry';

// ============================================================================
// Runtime inference helpers (fallback when no explicit registration)
// Used by rollback planner when TOOL_COMPENSATION_METADATA has no entry.
// ============================================================================

export function inferToolTags(toolName: string): string[] {
  if (toolName.startsWith('file_') || toolName.startsWith('fs_')) return ['low_risk'];
  if (toolName.startsWith('read_') || toolName.startsWith('list_') || toolName.startsWith('get_')) return ['low_risk'];
  if (toolName.includes('delete') || toolName.includes('remove') || toolName.includes('destroy')) return ['destructive'];
  if (toolName.includes('create') || toolName.includes('write') || toolName.includes('update')) return ['requires_approval'];
  if (toolName.includes('send_') || toolName.includes('notify') || toolName.includes('email')) return ['irreversible', 'requires_approval'];
  return [];
}

export function inferToolCost(toolName: string): number | undefined {
  if (toolName.startsWith('stripe_')) return 0.05;
  if (toolName.startsWith('aws_')) return 0.01;
  if (toolName.startsWith('gcp_')) return 0.01;
  if (toolName.startsWith('slack_')) return 0;
  if (toolName.startsWith('github_')) return 0;
  return undefined;
}

// ============================================================================
// Risk classification
// ============================================================================

export type CompensationRisk = 'safe' | 'review' | 'destructive' | 'impossible';

export interface RiskThresholds {
  /** Time after which a forward action is "expired" and its inverse is risky. */
  maxAgeMs: number;
  /** Cost in USD above which human approval is required. */
  maxCostUsd: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  maxAgeMs: 24 * 60 * 60 * 1000, // 24h
  maxCostUsd: 100,
};

// ============================================================================
// Compensation metadata
// ============================================================================

export interface CompensationMetadata {
  /** External system this tool touches ('github', 'stripe', etc.). */
  externalSystem: string;
  /** Risk classification of the inverse operation. */
  risk: CompensationRisk;
  /** Whether the inverse is fully recoverable (false → "compensate but verify"). */
  fullyRecoverable: boolean;
  /** Approximate cost in USD (drives approval gating). 0 for free tools. */
  costUsd?: number;
  /** Tags for matching in the planner (e.g. ['github:pr', 'github:issue']). */
  tags: string[];
  /** True if the handler itself is idempotent on retry. */
  idempotent: boolean;
  /** Optional planner hint: which arg field names carry the resource identifier. */
  resourceKeyFields?: string[];
}

// ============================================================================
// Compensation plan
// ============================================================================

export type PlanStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'requires_approval';

export interface PlanStep {
  /** Stable id (e.g. "step_1_compensate_github_create_pr"). */
  stepId: string;
  /** Description shown to the operator. */
  description: string;
  /** The action to compensate (forward context). */
  forwardAction: CompensableAction;
  /** Resolved compensation handler. */
  handlerName: string;
  /** Optional human-readable plan line (e.g. "Revert PR #42 in owner/repo"). */
  plan: string;
  /** Status. */
  status: PlanStepStatus;
  /** Error if failed. */
  error?: string;
  /** Latency in ms when complete. */
  durationMs?: number;
  /** Number of attempts so far. */
  attempts: number;
  /** When true, this step is buffered (held until all other steps succeed). For irreversible actions. */
  buffered?: boolean;
  /** Human-readable reason why this step is buffered. */
  bufferedReason?: string;
}

export interface CompensationPlan {
  /** The failed forward action that triggered this plan. */
  trigger: CompensableAction;
  /** All steps in execution order (reverse of forward). */
  steps: PlanStep[];
  /** Whether the plan requires human approval to execute. */
  requiresApproval: boolean;
  /** Estimated total cost in USD. */
  estimatedCostUsd: number;
  /** Risk summary. */
  risk: CompensationRisk;
  /** Created at ISO timestamp. */
  createdAt: string;
}

// ============================================================================
// Compensation result
// ============================================================================

export interface CompensationResult {
  plan: CompensationPlan;
  succeeded: PlanStep[];
  failed: PlanStep[];
  skipped: PlanStep[];
  totalDurationMs: number;
  fullyRecovered: boolean;
}

export interface CompensationOutcome {
  success: boolean;
  error?: string;
  /** True if the error is a permanent failure (4xx not 429, 404 not 5xx). */
  permanent?: boolean;
  /** True if the error is transient and should be retried. */
  retryable?: boolean;
  /** True if the side effect was already reversed (idempotent hit). */
  alreadyCompensated?: boolean;
}

// ============================================================================
// Pluggable HTTP client shape (moved from external/httpClient.ts)
// ============================================================================

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Idempotency key. When set, the request is safe to retry. */
  idempotencyKey?: string;
  /** Total request timeout in ms. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** True when the upstream returned 2xx. */
  ok: boolean;
}

export type HttpSendFn = (req: HttpRequest) => Promise<HttpResponse>;
