/**
 * Rollback Planner — automatic inference of compensation plans.
 *
 * Mission: every mutating tool call should have a pre-computed
 * "if this fails, undo it" plan BEFORE the call is made. The plan is
 * an array of `PlanStep`s with explicit human-readable descriptions,
 * risk classifications, and approval requirements.
 *
 *   Sources synthesised:
 *   - Temporal "compensating actions" (https://temporal.io/blog/compensating-actions-part-1)
 *   - AWS Step Functions `.catch()` semantics
 *   - Stripe idempotency for the plan-key-as-idempotency-key pattern
 *   - Garcia-Molina 1987 Sagas (saga execution coordinator)
 *
 * The planner takes the agent's LLM-generated plan (a sequence of
 * planned tool calls) and produces:
 *   1. A per-step compensation plan (inverse operations)
 *   2. Risk classification (drives human approval)
 *   3. Cost estimate (drives approval + budget)
 *   4. Plan execution order (LIFO, matching saga semantics)
 *
 * The plan is *generated* at planning time and *executed* by the
 * ExecutionScheduler at failure time. Decoupling generation from
 * execution is what Temporal's "replay" pattern depends on.
 */

import type { CompensableAction } from '../runtime/compensationRegistry';
import {
  inferToolTags,
  inferToolCost,
  type CompensationRisk,
  type PlanStep,
  type CompensationPlan,
  type CompensationMetadata,
  DEFAULT_RISK_THRESHOLDS,
  type RiskThresholds,
} from './types';
import { randomUUID } from 'node:crypto';

// ============================================================================
// Tool metadata registry (declarative compensation specs)
// ============================================================================

/**
 * Per-tool compensation metadata. Plugin authors register their
 * metadata at startup; the planner reads from this map.
 */
const TOOL_COMPENSATION_METADATA: Map<string, CompensationMetadata> = new Map();

export function registerCompensationMetadata(toolName: string, meta: CompensationMetadata): void {
  TOOL_COMPENSATION_METADATA.set(toolName, meta);
}

function getMetadata(toolName: string): CompensationMetadata {
  const registered = TOOL_COMPENSATION_METADATA.get(toolName);
  if (registered) return registered;

  // Fallback: runtime inference from tool name
  const tags = inferToolTags(toolName);
  return {
    externalSystem: toolName.split('_')[0] ?? 'unknown',
    risk: classifyRisk(toolName, tags),
    fullyRecoverable: !tags.includes('non_reversible') && !tags.includes('irreversible'),
    costUsd: inferToolCost(toolName),
    tags,
    idempotent: tags.includes('low_risk') || ['DELETE', 'delete', 'remove'].some((k) => toolName.includes(k)),
    resourceKeyFields: inferResourceKeyFields(toolName),
  };
}

function classifyRisk(toolName: string, tags: string[]): CompensationRisk {
  if (tags.includes('non_reversible')) return 'impossible';
  if (tags.includes('destructive') && tags.includes('requires_approval')) {
    return 'destructive';
  }
  if (tags.includes('destructive')) return 'review';
  if (tags.includes('low_risk')) return 'safe';
  return 'review';
}

// ============================================================================
// Resource Key Registry — declarative mapping of tool prefixes to their
// resource identifier fields.  Plugin authors register their tools here
// instead of adding to a growing if/else chain.
// ============================================================================

const RESOURCE_KEY_REGISTRY: Record<string, string[]> = {
  'stripe_charge': ['chargeId'],
  'stripe_payment_intent': ['paymentIntentId'],
  'stripe_subscription': ['subscriptionId'],
  'stripe_customer': ['customerId'],
  'stripe_transfer': ['transferId'],
  'github_pr': ['owner', 'repo', 'pullNumber'],
  'github_issue': ['owner', 'repo', 'issueNumber'],
  'github_branch': ['owner', 'repo', 'branch'],
  'github_tag': ['owner', 'repo', 'tag'],
  'slack_chat_postMessage': ['channel', 'ts'],
  'slack_reactions': ['channel', 'timestamp', 'name'],
  'slack_chat_scheduleMessage': ['channel', 'scheduledMessageId'],
  'slack_conversations_invite': ['channel', 'user'],
  'notion_page': ['pageId'],
  'notion_block': ['blockId'],
  'notion_database': ['databaseId'],
  'notion_comment': ['commentId'],
  'jira_issue': ['issueIdOrKey'],
  'linear_': ['id'],
  'file_': ['path'],
  'mkdir': ['path'],
  'rmdir': ['path'],
  'db_': ['connectionId', 'rows'],
  'sql_': ['connectionId', 'rows'],
  'pg_': ['connectionId', 'rows'],
  'mysql_': ['connectionId', 'rows'],
};

/**
 * Register resource key fields for a tool prefix.  Plugin authors call
 * this at startup instead of modifying the hardcoded if/else chain.
 */
export function registerResourceKeys(prefix: string, fields: string[]): void {
  RESOURCE_KEY_REGISTRY[prefix] = fields;
}

function inferResourceKeyFields(toolName: string): string[] {
  // Exact prefix match first
  for (const [prefix, fields] of Object.entries(RESOURCE_KEY_REGISTRY)) {
    if (toolName.startsWith(prefix)) return fields;
  }
  return [];
}

// ============================================================================
// Plan generation
// ============================================================================

export interface PlannedToolCall {
  toolName: string;
  args: Record<string, unknown>;
  /** When the LLM intends to run this (synthetic for planning). */
  scheduledAt?: string;
}

export interface PlanInput {
  /** All tool calls the agent plans to make, in order. */
  plannedCalls: PlannedToolCall[];
  /** Optional: the call that just failed, triggering this plan. */
  failure?: { toolName: string; args: Record<string, unknown>; error: string };
  /** Risk thresholds to drive approval. */
  riskThresholds?: RiskThresholds;
  /** True if any step requires human approval → whole plan pauses. */
  interactiveApproval?: boolean;
}

/**
 * Generate a compensation plan for the failed run. The plan covers all
 * EXECUTED (post-commit) actions, in REVERSE order, with the failure
 * at the top. Read-only steps are skipped. Non-reversible steps are
 * flagged but the plan still includes them so the operator sees them.
 */
export function generateRollbackPlan(input: PlanInput): CompensationPlan {
  const thresholds = input.riskThresholds ?? DEFAULT_RISK_THRESHOLDS;
  const calls = input.plannedCalls;
  const executedIndex = input.failure
    ? calls.findIndex(
        (c) => c.toolName === input.failure!.toolName && shallowEqual(c.args, input.failure!.args),
      )
    : calls.length;
  // Actions committed before the failure point. If the failure isn't in
  // the planned list, treat the entire sequence as "executed".
  const executedCalls = executedIndex < 0 ? calls : calls.slice(0, executedIndex);

  const steps: PlanStep[] = [];
  let estimatedCostUsd = 0;
  let requiresApproval = false;
  let worstRisk: CompensationRisk = 'safe';

  // REVERSE order, matching saga LIFO.
  for (let i = executedCalls.length - 1; i >= 0; i--) {
    const call = executedCalls[i];
    const meta = getMetadata(call.toolName);
    const action: CompensableAction = {
      actionId: `planned_${i}_${randomUUID().slice(0, 8)}`,
      toolName: call.toolName,
      args: call.args,
      description: `${call.toolName}(${JSON.stringify(call.args).slice(0, 100)})`,
      tags: meta.tags,
      runId: 'planned', // Replaced at execution time
    };
    const step: PlanStep = {
      stepId: `step_${i}_${call.toolName}`,
      description: humanizeInverse(call, meta),
      forwardAction: action,
      handlerName: call.toolName,
      plan: humanizePlanLine(call, meta),
      status: 'pending',
      attempts: 0,
      // P1-8: Irreversible action buffering.
      // Actions that cannot be undone (send_email, send_sms, payments, etc.)
      // are held until all other compensation steps succeed.
      // This prevents cascading failures where a reversible step fails
      // after an irreversible one has already been committed.
      buffered: meta.risk === 'impossible' || meta.tags.includes('irreversible'),
      bufferedReason:
        meta.risk === 'impossible'
          ? `Irreversible action: ${call.toolName} — held until all other steps succeed`
          : undefined,
    };
    steps.push(step);

    estimatedCostUsd += meta.costUsd ?? 0;

    if (meta.costUsd !== undefined && meta.costUsd > thresholds.maxCostUsd) {
      requiresApproval = true;
    }
    if (meta.risk === 'destructive' || meta.risk === 'impossible') {
      requiresApproval = true;
    }
    if (riskSeverity(meta.risk) > riskSeverity(worstRisk)) {
      worstRisk = meta.risk;
    }
  }

  return {
    trigger: input.failure
      ? {
          actionId: 'trigger',
          toolName: input.failure.toolName,
          args: input.failure.args,
          description: input.failure.error,
          tags: [],
          runId: 'planned',
        }
      : {
          actionId: 'no-failure',
          toolName: 'unknown',
          args: {},
          description: 'no failure',
          tags: [],
          runId: 'planned',
        },
    steps,
    requiresApproval,
    estimatedCostUsd,
    risk: worstRisk,
    createdAt: new Date().toISOString(),
  };
}

// ============================================================================
// Plan execution
// ============================================================================

export interface ExecutePlanOptions {
  /** Maximum attempts per step. Default 3. */
  maxAttemptsPerStep?: number;
  /** When true, requires the operator to explicitly approve the plan. */
  requireApproval?: (plan: CompensationPlan) => Promise<boolean>;
  /** When provided, called once per step with the human-readable plan. */
  onStepStart?: (step: PlanStep) => void | Promise<void>;
  /** When provided, called once per step after success/failure. */
  onStepComplete?: (step: PlanStep) => void | Promise<void>;
  /** Handler override map. Keyed by tool name. */
  handlers?: Record<
    string,
    (
      action: CompensableAction,
    ) => Promise<{ success: boolean; error?: string; permanent?: boolean }>
  >;
}

import type { CompensationResult } from './types';
import { assertPlanFeasible, type HandlerMap } from './planValidator';

/**
 * Execute a plan. Returns the per-step results and a flag indicating
 * full state recovery. The caller (typically the agent runtime) is
 * responsible for resolving any approval gates before calling.
 *
 * Pre-condition: `assertPlanFeasible()` is called first to guarantee
 * that every non-buffered step has a registered handler. If the plan
 * is infeasible, this throws BEFORE any step executes, preventing
 * partial rollback.
 */
export async function executeRollbackPlan(
  plan: CompensationPlan,
  options: ExecutePlanOptions = {},
): Promise<CompensationResult> {
  // PRE-FLIGHT: validate that all non-buffered steps have handlers
  // BEFORE executing anything. This prevents the "partial rollback"
  // disaster where steps 1-2 succeed, step 3 throws "no handler",
  // and the system is left in an unrecoverable half-rolled state.
  assertPlanFeasible(plan, options.handlers as HandlerMap | undefined);

  const max = options.maxAttemptsPerStep ?? 3;
  const startTime = Date.now();

  if (options.requireApproval && plan.requiresApproval) {
    const approved = await options.requireApproval(plan);
    if (!approved) {
      // Skip all steps; mark them as "skipped" with a reason.
      for (const s of plan.steps) {
        s.status = 'skipped';
        s.error = 'Plan requires approval; operator declined';
      }
      return {
        plan,
        succeeded: [],
        failed: [],
        skipped: plan.steps,
        totalDurationMs: Date.now() - startTime,
        fullyRecovered: false,
      };
    }
  }

  const succeeded: PlanStep[] = [];
  const failed: PlanStep[] = [];
  const skipped: PlanStep[] = [];

  // Shared helper: execute a single compensation step with retry.
  const executeStep = async (step: PlanStep): Promise<void> => {
    await options.onStepStart?.(step);
    const handler = options.handlers?.[step.forwardAction.toolName];
    if (!handler) {
      step.status = 'skipped';
      step.error = `No compensation handler for ${step.buffered ? 'buffered ' : ''}"${step.forwardAction.toolName}"`;
      skipped.push(step);
      await options.onStepComplete?.(step);
      return;
    }
    step.status = 'running';
    let lastError: string | undefined;
    let lastPermanent: boolean | undefined;
    let attempt = 0;
    for (attempt = 0; attempt < max; attempt++) {
      step.attempts = attempt + 1;
      const t0 = Date.now();
      try {
        const r = await handler(step.forwardAction);
        step.durationMs = (step.durationMs ?? 0) + (Date.now() - t0);
        if (r.success) {
          step.status = 'succeeded';
          succeeded.push(step);
          break;
        }
        lastError = r.error;
        lastPermanent = r.permanent;
        if (r.permanent) break;
      } catch (err) {
        lastError = (err as Error).message;
        lastPermanent = false;
      }
    }
    if (step.status === 'running') {
      step.status = 'failed';
      step.error = lastError ?? 'unknown';
      if (lastPermanent) step.error = `[permanent] ${step.error}`;
      failed.push(step);
    }
    await options.onStepComplete?.(step);
  };

  // P1-8: Separate buffered (irreversible) steps from normal steps.
  // Normal steps execute first. Buffered steps only execute AFTER
  // all normal steps succeed to prevent cascading failures.
  const normalSteps = plan.steps.filter((s) => !s.buffered);
  const bufferedSteps = plan.steps.filter((s) => s.buffered);

  // Phase 1: Execute normal (reversible) compensation steps.
  for (const step of normalSteps) {
    await executeStep(step);
  }

  // P1-8 Phase 2: Execute buffered (irreversible) steps ONLY if all
  // normal steps succeeded.
  if (bufferedSteps.length > 0) {
    if (failed.length === 0) {
      for (const step of bufferedSteps) {
        await executeStep(step);
      }
    } else {
      for (const step of bufferedSteps) {
        step.status = 'skipped';
        step.error = `Buffered: held due to ${failed.length} normal step failure(s)`;
        skipped.push(step);
      }
    }
  }

  return {
    plan,
    succeeded,
    failed,
    skipped,
    totalDurationMs: Date.now() - startTime,
    fullyRecovered: failed.length === 0,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function resolveAffectedPaths(toolName: string, args: Record<string, unknown>): string[] {
  const candidates: unknown[] = [];
  for (const key of ['path', 'paths', 'filePath', 'file', 'destination', 'target']) {
    const value = args[key];
    if (value !== undefined && value !== null) candidates.push(value);
  }
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      paths.push(candidate);
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string') paths.push(item);
      }
    }
  }
  return paths.length > 0 ? paths : [toolName];
}

function humanizeInverse(call: PlannedToolCall, _meta: CompensationMetadata): string {
  return `Undo ${call.toolName}`;
}

function humanizePlanLine(call: PlannedToolCall, meta: CompensationMetadata): string {
  const tags = meta.tags.join(', ');
  if (call.toolName.startsWith('github_pr')) return `Close GitHub PR (${tags})`;
  if (call.toolName.startsWith('github_issue')) return `Close GitHub issue (${tags})`;
  if (call.toolName.startsWith('github_branch')) return `Delete GitHub branch (${tags})`;
  if (call.toolName.startsWith('slack_chat_postMessage')) {
    return `Delete Slack message in ${String(call.args.channel ?? '?')}`;
  }
  if (call.toolName.startsWith('stripe_charge')) return `Refund Stripe charge (${tags})`;
  if (call.toolName.startsWith('stripe_payment_intent'))
    return `Cancel Stripe PaymentIntent (${tags})`;
  if (call.toolName.startsWith('notion_page_create')) return `Archive Notion page (${tags})`;
  if (call.toolName.startsWith('jira_issue_create')) return `Delete Jira issue (${tags})`;
  if (call.toolName.startsWith('linear_issue_create')) return `Archive Linear issue (${tags})`;
  if (call.toolName.startsWith('file_')) {
    const paths = resolveAffectedPaths(call.toolName, call.args);
    return `Restore filesystem path(s): ${paths.join(', ') || call.toolName}`;
  }
  if (call.toolName.startsWith('db_') || call.toolName.startsWith('sql_')) {
    return `Apply inverse SQL for ${call.toolName}`;
  }
  return `Compensate ${call.toolName} (${tags})`;
}

function riskSeverity(r: CompensationRisk): number {
  switch (r) {
    case 'safe':
      return 0;
    case 'review':
      return 1;
    case 'destructive':
      return 2;
    case 'impossible':
      return 3;
  }
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}
