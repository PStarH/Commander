"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCompensationMetadata = registerCompensationMetadata;
exports.generateRollbackPlan = generateRollbackPlan;
exports.executeRollbackPlan = executeRollbackPlan;
const types_1 = require("./external/types");
const filesystem_1 = require("./external/filesystem");
const node_crypto_1 = require("node:crypto");
// ============================================================================
// Tool metadata registry (declarative compensation specs)
// ============================================================================
/**
 * Per-tool compensation metadata. Plugin authors register their
 * metadata at startup; the planner reads from this map.
 */
const TOOL_COMPENSATION_METADATA = new Map();
function registerCompensationMetadata(toolName, meta) {
    TOOL_COMPENSATION_METADATA.set(toolName, meta);
}
function getMetadata(toolName) {
    var _a;
    return ((_a = TOOL_COMPENSATION_METADATA.get(toolName)) !== null && _a !== void 0 ? _a : {
        externalSystem: 'unknown',
        risk: classifyRisk(toolName, (0, types_1.getToolTags)(toolName)),
        fullyRecoverable: !(0, types_1.getToolTags)(toolName).includes('non_reversible'),
        costUsd: (0, types_1.getToolCost)(toolName),
        tags: (0, types_1.getToolTags)(toolName),
        idempotent: (0, types_1.getToolTags)(toolName).includes('low_risk') || true, // Most HTTP DELETEs are idempotent
        resourceKeyFields: inferResourceKeyFields(toolName),
    });
}
function classifyRisk(toolName, tags) {
    if (tags.includes('non_reversible'))
        return 'impossible';
    if (tags.includes('destructive') && tags.includes('requires_approval')) {
        return 'destructive';
    }
    if (tags.includes('destructive'))
        return 'review';
    if (tags.includes('low_risk'))
        return 'safe';
    return 'review';
}
function inferResourceKeyFields(toolName) {
    if (toolName.includes('stripe_charge'))
        return ['chargeId'];
    if (toolName.includes('stripe_payment_intent'))
        return ['paymentIntentId'];
    if (toolName.includes('stripe_subscription'))
        return ['subscriptionId'];
    if (toolName.includes('stripe_customer'))
        return ['customerId'];
    if (toolName.includes('stripe_transfer'))
        return ['transferId'];
    if (toolName.startsWith('github_pr') || toolName === 'gh_pr_create') {
        return ['owner', 'repo', 'pullNumber'];
    }
    if (toolName.startsWith('github_issue') || toolName === 'gh_issue_create') {
        return ['owner', 'repo', 'issueNumber'];
    }
    if (toolName.startsWith('github_branch') || toolName === 'gh_branch_create') {
        return ['owner', 'repo', 'branch'];
    }
    if (toolName.startsWith('github_tag'))
        return ['owner', 'repo', 'tag'];
    if (toolName.startsWith('slack_chat_postMessage'))
        return ['channel', 'ts'];
    if (toolName.startsWith('slack_reactions'))
        return ['channel', 'timestamp', 'name'];
    if (toolName.startsWith('slack_chat_scheduleMessage'))
        return ['channel', 'scheduledMessageId'];
    if (toolName.startsWith('slack_conversations_invite'))
        return ['channel', 'user'];
    if (toolName.startsWith('notion_')) {
        if (toolName.includes('page'))
            return ['pageId'];
        if (toolName.includes('block'))
            return ['blockId'];
        if (toolName.includes('database'))
            return ['databaseId'];
        if (toolName.includes('comment'))
            return ['commentId'];
    }
    if (toolName.startsWith('jira_issue'))
        return ['issueIdOrKey'];
    if (toolName.startsWith('linear_'))
        return ['id'];
    if (toolName.startsWith('file_'))
        return ['path'];
    if (toolName.startsWith('mkdir') || toolName.startsWith('rmdir'))
        return ['path'];
    if (toolName.startsWith('db_') ||
        toolName.startsWith('sql_') ||
        toolName.startsWith('pg_') ||
        toolName.startsWith('mysql_')) {
        return ['connectionId', 'rows'];
    }
    return [];
}
/**
 * Generate a compensation plan for the failed run. The plan covers all
 * EXECUTED (post-commit) actions, in REVERSE order, with the failure
 * at the top. Read-only steps are skipped. Non-reversible steps are
 * flagged but the plan still includes them so the operator sees them.
 */
function generateRollbackPlan(input) {
    var _a, _b;
    const thresholds = (_a = input.riskThresholds) !== null && _a !== void 0 ? _a : types_1.DEFAULT_RISK_THRESHOLDS;
    const calls = input.plannedCalls;
    const executedIndex = input.failure
        ? calls.findIndex((c) => c.toolName === input.failure.toolName && shallowEqual(c.args, input.failure.args))
        : calls.length;
    // Actions committed before the failure point. If the failure isn't in
    // the planned list, treat the entire sequence as "executed".
    const executedCalls = executedIndex < 0 ? calls : calls.slice(0, executedIndex);
    const steps = [];
    let estimatedCostUsd = 0;
    let requiresApproval = false;
    let worstRisk = 'safe';
    // REVERSE order, matching saga LIFO.
    for (let i = executedCalls.length - 1; i >= 0; i--) {
        const call = executedCalls[i];
        const meta = getMetadata(call.toolName);
        const action = {
            actionId: `planned_${i}_${(0, node_crypto_1.randomUUID)().slice(0, 8)}`,
            toolName: call.toolName,
            args: call.args,
            description: `${call.toolName}(${JSON.stringify(call.args).slice(0, 100)})`,
            tags: meta.tags,
            runId: 'planned', // Replaced at execution time
        };
        const step = {
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
            bufferedReason: meta.risk === 'impossible'
                ? `Irreversible action: ${call.toolName} — held until all other steps succeed`
                : undefined,
        };
        steps.push(step);
        estimatedCostUsd += (_b = meta.costUsd) !== null && _b !== void 0 ? _b : 0;
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
/**
 * Execute a plan. Returns the per-step results and a flag indicating
 * full state recovery. The caller (typically the agent runtime) is
 * responsible for resolving any approval gates before calling.
 */
async function executeRollbackPlan(plan, options = {}) {
    var _a;
    const max = (_a = options.maxAttemptsPerStep) !== null && _a !== void 0 ? _a : 3;
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
    const succeeded = [];
    const failed = [];
    const skipped = [];
    // Shared helper: execute a single compensation step with retry.
    const executeStep = async (step) => {
        var _a, _b, _c, _d, _e;
        await ((_a = options.onStepStart) === null || _a === void 0 ? void 0 : _a.call(options, step));
        const handler = (_b = options.handlers) === null || _b === void 0 ? void 0 : _b[step.forwardAction.toolName];
        if (!handler) {
            step.status = 'skipped';
            step.error = `No compensation handler for ${step.buffered ? 'buffered ' : ''}"${step.forwardAction.toolName}"`;
            skipped.push(step);
            await ((_c = options.onStepComplete) === null || _c === void 0 ? void 0 : _c.call(options, step));
            return;
        }
        step.status = 'running';
        let lastError;
        let lastPermanent;
        let attempt = 0;
        for (attempt = 0; attempt < max; attempt++) {
            step.attempts = attempt + 1;
            const t0 = Date.now();
            try {
                const r = await handler(step.forwardAction);
                step.durationMs = ((_d = step.durationMs) !== null && _d !== void 0 ? _d : 0) + (Date.now() - t0);
                if (r.success) {
                    step.status = 'succeeded';
                    succeeded.push(step);
                    break;
                }
                lastError = r.error;
                lastPermanent = r.permanent;
                if (r.permanent)
                    break;
            }
            catch (err) {
                lastError = err.message;
                lastPermanent = false;
            }
        }
        if (step.status === 'running') {
            step.status = 'failed';
            step.error = lastError !== null && lastError !== void 0 ? lastError : 'unknown';
            if (lastPermanent)
                step.error = `[permanent] ${step.error}`;
            failed.push(step);
        }
        await ((_e = options.onStepComplete) === null || _e === void 0 ? void 0 : _e.call(options, step));
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
        }
        else {
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
function humanizeInverse(call, _meta) {
    return `Undo ${call.toolName}`;
}
function humanizePlanLine(call, meta) {
    var _a;
    const tags = meta.tags.join(', ');
    if (call.toolName.startsWith('github_pr'))
        return `Close GitHub PR (${tags})`;
    if (call.toolName.startsWith('github_issue'))
        return `Close GitHub issue (${tags})`;
    if (call.toolName.startsWith('github_branch'))
        return `Delete GitHub branch (${tags})`;
    if (call.toolName.startsWith('slack_chat_postMessage')) {
        return `Delete Slack message in ${String((_a = call.args.channel) !== null && _a !== void 0 ? _a : '?')}`;
    }
    if (call.toolName.startsWith('stripe_charge'))
        return `Refund Stripe charge (${tags})`;
    if (call.toolName.startsWith('stripe_payment_intent'))
        return `Cancel Stripe PaymentIntent (${tags})`;
    if (call.toolName.startsWith('notion_page_create'))
        return `Archive Notion page (${tags})`;
    if (call.toolName.startsWith('jira_issue_create'))
        return `Delete Jira issue (${tags})`;
    if (call.toolName.startsWith('linear_issue_create'))
        return `Archive Linear issue (${tags})`;
    if (call.toolName.startsWith('file_')) {
        const paths = (0, filesystem_1.resolveAffectedPaths)(call.toolName, call.args);
        return `Restore filesystem path(s): ${paths.join(', ') || call.toolName}`;
    }
    if (call.toolName.startsWith('db_') || call.toolName.startsWith('sql_')) {
        return `Apply inverse SQL for ${call.toolName}`;
    }
    return `Compensate ${call.toolName} (${tags})`;
}
function riskSeverity(r) {
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
function shallowEqual(a, b) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length)
        return false;
    for (const k of aKeys) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
            return false;
    }
    return true;
}
