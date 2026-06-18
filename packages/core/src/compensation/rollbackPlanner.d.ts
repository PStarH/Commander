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
import { type PlanStep, type CompensationPlan, type CompensationMetadata, type RiskThresholds } from './external/types';
export declare function registerCompensationMetadata(toolName: string, meta: CompensationMetadata): void;
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
    failure?: {
        toolName: string;
        args: Record<string, unknown>;
        error: string;
    };
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
export declare function generateRollbackPlan(input: PlanInput): CompensationPlan;
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
    handlers?: Record<string, (action: CompensableAction) => Promise<{
        success: boolean;
        error?: string;
        permanent?: boolean;
    }>>;
}
import type { CompensationResult } from './external/types';
/**
 * Execute a plan. Returns the per-step results and a flag indicating
 * full state recovery. The caller (typically the agent runtime) is
 * responsible for resolving any approval gates before calling.
 */
export declare function executeRollbackPlan(plan: CompensationPlan, options?: ExecutePlanOptions): Promise<CompensationResult>;
//# sourceMappingURL=rollbackPlanner.d.ts.map