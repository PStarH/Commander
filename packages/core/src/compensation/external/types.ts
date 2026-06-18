/**
 * Reversibility Runtime — compensation metadata shared by all external
 * system handlers.
 *
 * Mission: make failed agent execution recoverable by default.
 *
 * The pattern (synthesised from Temporal's compensating-action blog series,
 * AWS Step Functions `.catch()` semantics, and Stripe's idempotency model):
 *
 *   1. Every mutating tool call has a "forward" side effect and a paired
 *      "inverse" side effect (the compensation).
 *   2. Idempotency keys are the bridge: forward and inverse operations
 *      share an idempotency namespace so retries are safe.
 *   3. Compensation plans are inferred at planning time, executed at
 *      failure time, and audited at post-mortem time.
 *
 *   Sources synthesised:
 *   - https://stripe.com/blog/idempotency
 *   - https://temporal.io/blog/compensating-actions-part-1
 *   - https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html
 *   - https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf
 */

import type { CompensableAction } from '../../runtime/compensationRegistry';

// ============================================================================
// Tool tag and cost lookup (used by rollback planner)
// ============================================================================

/**
 * Look up tags associated with a tool name. Used by the rollback
 * planner to classify compensation risk. Returns empty array when
 * no tags are registered (safe default).
 */
export function getToolTags(_toolName: string): string[] {
  // Tool-specific tags are registered by each external handler module
  // (see github.ts: GITHUB_TOOL_TAGS, stripe.ts: STRIPE_TOOL_TAGS, etc.)
  // The planner calls this at plan-generation time; the tags drive risk
  // classification and approval gating.
  return [];
}

/**
 * Look up the USD cost associated with a tool invocation. Used by the
 * rollback planner to estimate compensation cost and drive approval
 * thresholds. Returns undefined when no cost is registered.
 */
export function getToolCost(_toolName: string): number | undefined {
  return undefined;
}

// ============================================================================
// Risk classification
// ============================================================================

/**
 * Risk level of a compensation. Drives whether human approval is required
 * before executing the inverse. Mirrors the `riskLevel` field on `Tool`
 * (see runtime/types.ts:299) and the `NodeRiskLevel` enum in ultimate/types.
 */
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

/**
 * Declarative metadata a tool author attaches to a mutating tool so the
 * rollback planner can produce a compensation plan without writing code.
 *
 * The handler is what actually executes the inverse. The metadata is what
 * the planner uses to choose WHEN and WHETHER to run it.
 */
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

// ============================================================================
// Pluggable HTTP client shape
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

/**
 * Result classification for a compensation attempt. Mirrors the legacy
 * CompensationHandler return shape so the new handlers plug straight into
 * the existing registry (runtime/compensationRegistry.ts:18).
 */
export interface CompensationOutcome {
  success: boolean;
  error?: string;
  /** True if the error is a permanent failure (4xx not 429, 404 not 5xx). */
  permanent?: boolean;
  /** True if the side effect was already reversed (idempotent hit). */
  alreadyCompensated?: boolean;
}
