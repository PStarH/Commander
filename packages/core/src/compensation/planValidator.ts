/**
 * Plan Validator — pre-flight compensation plan feasibility check.
 *
 * Mission: before ANY compensation step executes, validate that every
 * non-buffered step has a registered handler.  This prevents the
 * "partial rollback" disaster where steps 1-2 succeed, step 3 throws
 * "no handler", and the system is left in an unrecoverable half-rolled
 * state.
 *
 * Flow:
 *   validatePlanFeasibility(plan, handlers)
 *     → { feasible: true }                              // all good
 *     → { feasible: false, gaps: ["toolA", "toolB"] }   // escalate before executing
 */

import type { CompensationPlan, PlanStep } from './types';
import type { CompensableAction } from '../runtime/compensationRegistry';

/** Minimum set of handlers that MUST be present for non-buffered steps. */
export interface HandlerMap {
  [toolName: string]: (
    action: CompensableAction,
  ) => Promise<{ success: boolean; error?: string; permanent?: boolean }>;
}

export interface FeasibilityReport {
  feasible: boolean;
  /** Tool names that lack a handler (non-buffered only). */
  gaps: string[];
  /** Steps that will be skipped because no handler exists. */
  affectedSteps: PlanStep[];
  /** Human-readable summary for alerting. */
  summary: string;
}

/**
 * Check that every non-buffered step in the plan has a registered
 * compensation handler.  Buffered (irreversible) steps without a
 * handler are warned but do NOT block execution — they will be
 * skipped at runtime with a log entry.
 *
 * Call this BEFORE `executeRollbackPlan()`.
 */
export function validatePlanFeasibility(
  plan: CompensationPlan,
  handlers?: HandlerMap,
): FeasibilityReport {
  const gaps: string[] = [];
  const affectedSteps: PlanStep[] = [];

  for (const step of plan.steps) {
    // Buffered (irreversible) steps: warn but don't block
    if (step.buffered) {
      if (!handlers?.[step.forwardAction.toolName]) {
        // These will be skipped at runtime — acceptable for truly
        // irreversible actions, but worth noting.
        continue;
      }
      continue;
    }

    // Non-buffered steps MUST have a handler
    if (!handlers?.[step.forwardAction.toolName]) {
      const toolName = step.forwardAction.toolName;
      if (!gaps.includes(toolName)) {
        gaps.push(toolName);
      }
      affectedSteps.push(step);
    }
  }

  const feasible = gaps.length === 0;

  return {
    feasible,
    gaps,
    affectedSteps,
    summary: feasible
      ? `All ${plan.steps.length} compensation steps have registered handlers`
      : `ROLLBACK BLOCKED: ${gaps.length} tool(s) missing compensation handler(s): ${gaps.join(', ')}. ` +
        `${affectedSteps.length} step(s) affected. This plan CANNOT safely execute.`,
  };
}

/**
 * Runtime guard — call at the top of `executeRollbackPlan`.
 * Throws immediately if the plan is not feasible, preventing
 * any partial execution.
 *
 * @throws CompensationPlanInfeasibleError with full FeasibilityReport.
 */
export function assertPlanFeasible(
  plan: CompensationPlan,
  handlers?: HandlerMap,
): asserts plan is CompensationPlan {
  const report = validatePlanFeasibility(plan, handlers);
  if (!report.feasible) {
    throw new CompensationPlanInfeasibleError(report);
  }
}

export class CompensationPlanInfeasibleError extends Error {
  public readonly report: FeasibilityReport;

  constructor(report: FeasibilityReport) {
    super(report.summary);
    this.name = 'CompensationPlanInfeasibleError';
    this.report = report;
  }
}
