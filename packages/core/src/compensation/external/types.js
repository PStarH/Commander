"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_RISK_THRESHOLDS = void 0;
exports.getToolTags = getToolTags;
exports.getToolCost = getToolCost;
// ============================================================================
// Tool tag and cost lookup (used by rollback planner)
// ============================================================================
/**
 * Look up tags associated with a tool name. Used by the rollback
 * planner to classify compensation risk. Returns empty array when
 * no tags are registered (safe default).
 */
function getToolTags(_toolName) {
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
function getToolCost(_toolName) {
    return undefined;
}
exports.DEFAULT_RISK_THRESHOLDS = {
    maxAgeMs: 24 * 60 * 60 * 1000, // 24h
    maxCostUsd: 100,
};
