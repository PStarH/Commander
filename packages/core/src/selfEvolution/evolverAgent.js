"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvolverAgent = void 0;
exports.getEvolverAgent = getEvolverAgent;
exports.resetEvolverAgent = resetEvolverAgent;
const metaLearner_1 = require("./metaLearner");
const MUTATION_RULES = {
    hallucination: [
        {
            domain: 'quality_gate',
            configPath: 'qualityGates.hallucination.threshold',
            mode: 'delta',
            value: 0.9,
            minConfidence: 0.5,
            description: 'Tighten hallucination gate threshold from {old} to {new} after detecting hallucination failures',
            condition: (v) => typeof v === 'number' && v > 0.5,
        },
    ],
    context_overflow: [
        {
            domain: 'thinking_budget',
            configPath: 'defaultThinkingBudget.maxThinkingTokens',
            mode: 'delta',
            value: 0.75,
            minConfidence: 0.5,
            description: 'Reduce thinking budget from {old} to {new} after context overflow',
            condition: (v) => typeof v === 'number' && v > 512,
        },
        {
            domain: 'thinking_budget',
            configPath: 'defaultThinkingBudget.subAgentThinkingTokens',
            mode: 'delta',
            value: 0.75,
            minConfidence: 0.5,
            description: 'Reduce sub-agent thinking budget from {old} to {new} after context overflow',
            condition: (v) => typeof v === 'number' && v > 256,
        },
    ],
    timeout: [
        {
            domain: 'runtime',
            configPath: 'maxParallelSubAgents',
            mode: 'delta',
            value: 0.8,
            minConfidence: 0.4,
            description: 'Reduce parallel agents from {old} to {new} after timeout',
            condition: (v) => typeof v === 'number' && v > 2,
        },
    ],
    model_refusal: [
        {
            domain: 'model_tier',
            configPath: 'modelTierMapping.MODERATE',
            mode: 'absolute',
            value: 'power',
            minConfidence: 0.6,
            description: 'Upgrade moderate tier from {old} to {new} after model refusal',
            condition: (v) => v !== 'power' && v !== 'consensus',
        },
    ],
    missing_capability: [
        {
            domain: 'model_tier',
            configPath: 'modelTierMapping.COMPLEX',
            mode: 'absolute',
            value: 'consensus',
            minConfidence: 0.6,
            description: 'Upgrade complex tier from {old} to {new} after missing capability',
            condition: (v) => v !== 'consensus',
        },
    ],
    planning_error: [
        {
            domain: 'synthesis',
            configPath: 'defaultSynthesisConfig.maxRounds',
            mode: 'delta',
            value: 1.5,
            minConfidence: 0.5,
            description: 'Increase synthesis rounds from {old} to {new} after planning errors',
            condition: (v) => typeof v === 'number' && v < 5,
        },
        {
            domain: 'quality_gate',
            configPath: 'qualityGates.consistency.threshold',
            mode: 'delta',
            value: 1.05,
            minConfidence: 0.5,
            description: 'Tighten consistency gate threshold from {old} to {new} after planning errors',
            condition: (v) => typeof v === 'number' && v < 0.95,
        },
    ],
    dependency_failure: [
        {
            domain: 'runtime',
            configPath: 'maxParallelSubAgents',
            mode: 'delta',
            value: 0.75,
            minConfidence: 0.4,
            description: 'Reduce parallel agents from {old} to {new} after dependency failures',
            condition: (v) => typeof v === 'number' && v > 1,
        },
    ],
    quality_gate: [
        {
            domain: 'quality_gate',
            configPath: 'qualityGates.accuracy.threshold',
            mode: 'delta',
            value: 0.95,
            minConfidence: 0.5,
            description: 'Tighten accuracy gate threshold from {old} to {new} after quality gate failures',
            condition: (v) => typeof v === 'number' && v > 0.3,
        },
    ],
    tool_misuse: [
        {
            domain: 'runtime',
            configPath: 'maxParallelSubAgents',
            mode: 'delta',
            value: 0.8,
            minConfidence: 0.5,
            description: 'Reduce parallel agents from {old} to {new} after tool misuse to reduce tool contention',
            condition: (v) => typeof v === 'number' && v > 2,
        },
    ],
    rate_limit: [
        {
            domain: 'runtime',
            configPath: 'maxParallelSubAgents',
            mode: 'delta',
            value: 0.5,
            minConfidence: 0.5,
            description: 'Reduce parallel agents from {old} to {new} after rate limiting',
            condition: (v) => typeof v === 'number' && v > 1,
        },
    ],
    authentication: [
        {
            domain: 'model_tier',
            configPath: 'modelTierMapping.MODERATE',
            mode: 'absolute',
            value: 'power',
            minConfidence: 0.5,
            description: 'Upgrade model tier from {old} to {new} after auth failures (may need stronger model)',
            condition: (v) => v !== 'power' && v !== 'consensus',
        },
    ],
    resource_exhaustion: [
        {
            domain: 'thinking_budget',
            configPath: 'defaultThinkingBudget.maxThinkingTokens',
            mode: 'delta',
            value: 0.6,
            minConfidence: 0.5,
            description: 'Reduce thinking budget from {old} to {new} after resource exhaustion',
            condition: (v) => typeof v === 'number' && v > 512,
        },
        {
            domain: 'runtime',
            configPath: 'maxParallelSubAgents',
            mode: 'delta',
            value: 0.5,
            minConfidence: 0.5,
            description: 'Reduce parallel agents from {old} to {new} after resource exhaustion',
            condition: (v) => typeof v === 'number' && v > 1,
        },
    ],
    data_validation: [
        {
            domain: 'quality_gate',
            configPath: 'qualityGates.accuracy.threshold',
            mode: 'delta',
            value: 1.05,
            minConfidence: 0.5,
            description: 'Tighten accuracy gate from {old} to {new} after data validation failures',
            condition: (v) => typeof v === 'number' && v < 0.95,
        },
    ],
    unclassified: [],
};
// ============================================================================
// Config access helpers (navigates dot-separated paths in the config object)
// ============================================================================
function getConfigValue(config, path) {
    const parts = path.split('.');
    let current = config;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== 'object')
            return undefined;
        current = current[part];
    }
    return current;
}
function setConfigValue(config, path, value) {
    const parts = path.split('.');
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current === null || current === undefined || typeof current !== 'object')
            return;
        const next = current[parts[i]];
        if (next === undefined || next === null || typeof next !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    if (current !== null && current !== undefined && typeof current === 'object') {
        current[parts[parts.length - 1]] = value;
    }
}
// ============================================================================
// Path resolution helpers for special config structures
// ============================================================================
/**
 * Resolve a path that may reference nested array fields (e.g. "qualityGates.hallucination.threshold").
 * qualityGates is a QualityGateConfig[] array, so we need to find the right entry by name.
 */
function resolvePath(config, path) {
    const parts = path.split('.');
    // Handle qualityGates.{name}.{field} — look up by name in the array
    if (parts[0] === 'qualityGates' && parts.length >= 3) {
        const gateName = parts[1];
        const field = parts[2];
        const gate = config.qualityGates;
        if (!gate)
            return null;
        const entry = gate.find((g) => g.name === gateName);
        if (!entry)
            return null;
        return { parent: entry, key: field };
    }
    // Standard dot path traversal
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
        const val = current[parts[i]];
        if (val === undefined || val === null || typeof val !== 'object')
            return null;
        current = val;
    }
    return { parent: current, key: parts[parts.length - 1] };
}
// ============================================================================
// Evolver Agent
// ============================================================================
let evolverCounter = 0;
/** Minimum interval between evolution cycles (ms) to prevent over-tuning */
const EVOLVER_COOLDOWN_MS = 60000;
class EvolverAgent {
    constructor() {
        this.lastMutationTime = 0;
        // ── Canary Config Deployment ──────────────────────────────────────────
        this.currentCanary = null;
        this.defaultRolloutFraction = 0.1; // 10% of runs use canary config
    }
    /** Returns ms until the cooldown expires (0 = ready) */
    get cooldownRemaining() {
        const elapsed = Date.now() - this.lastMutationTime;
        return Math.max(0, EVOLVER_COOLDOWN_MS - elapsed);
    }
    /**
     * Given trajectory analysis insights, produce config mutations tuned to the
     * observed failure patterns. Does NOT mutate config — just returns the plan.
     */
    evolve(insights, config) {
        var _a;
        const mutations = [];
        for (const insight of insights) {
            if (insight.success)
                continue;
            const rules = (_a = MUTATION_RULES[insight.failureCategory]) !== null && _a !== void 0 ? _a : [];
            if (rules.length === 0)
                continue;
            for (const rule of rules) {
                // Skip if insight confidence is below this rule's minimum threshold
                if (insight.confidence < rule.minConfidence)
                    continue;
                // Resolve the current value
                const resolved = resolvePath(config, rule.configPath);
                if (!resolved)
                    continue;
                const currentVal = resolved.parent[resolved.key];
                // Check condition
                if (rule.condition && !rule.condition(currentVal))
                    continue;
                // Compute new value
                let newVal;
                if (rule.mode === 'delta' &&
                    typeof currentVal === 'number' &&
                    typeof rule.value === 'number') {
                    newVal = Math.round(currentVal * rule.value * 100) / 100;
                }
                else {
                    newVal = rule.value;
                }
                // Skip if no actual change
                if (newVal === currentVal)
                    continue;
                const mutationId = `evolver_${++evolverCounter}_${Date.now()}`;
                const description = rule.description
                    .replace('{old}', String(currentVal))
                    .replace('{new}', String(newVal));
                mutations.push({
                    id: mutationId,
                    domain: rule.domain,
                    description,
                    triggeredBy: insight.failureCategory,
                    confidence: insight.confidence,
                    configPath: rule.configPath,
                    oldValue: currentVal,
                    newValue: newVal,
                });
            }
        }
        return mutations;
    }
    /**
     * Apply mutations to the config object. Mutations are idempotent — applying
     * the same mutation twice is a no-op (oldValue already matches newValue).
     */
    applyMutations(config, mutations) {
        let applied = 0;
        for (const mutation of mutations) {
            const resolved = resolvePath(config, mutation.configPath);
            if (!resolved)
                continue;
            const currentVal = resolved.parent[resolved.key];
            // Idempotent: skip if already at target
            if (currentVal === mutation.newValue)
                continue;
            // Safety: skip if current value doesn't match expected old value
            if (currentVal !== mutation.oldValue)
                continue;
            resolved.parent[resolved.key] = mutation.newValue;
            applied++;
        }
        return applied;
    }
    /**
     * Revert mutations, restoring config to old values.
     */
    revertMutations(config, mutations) {
        let reverted = 0;
        for (const mutation of mutations) {
            const resolved = resolvePath(config, mutation.configPath);
            if (!resolved)
                continue;
            const currentVal = resolved.parent[resolved.key];
            // Only revert if the current value matches the mutation's newValue
            // (i.e. hasn't been changed again by something else)
            if (currentVal !== mutation.newValue)
                continue;
            resolved.parent[resolved.key] = mutation.oldValue;
            reverted++;
        }
        return reverted;
    }
    /**
     * Create falsifiable predictions for each mutation via MetaLearner.
     */
    createPredictions(mutations, exp, taskTypes) {
        const ml = (0, metaLearner_1.getMetaLearner)();
        for (const mutation of mutations) {
            ml.createPrediction(mutation.id, mutation.description, String(mutation.newValue), String(mutation.oldValue), exp.modelUsed, taskTypes, [mutation.triggeredBy], [mutation.triggeredBy]);
        }
    }
    /**
     * Run a full evolution cycle: analyze insights → produce mutations →
     * apply → create predictions. Returns what was done.
     */
    runCycle(insights, config, exp, taskTypes) {
        // Cooldown: skip if mutations were applied recently to prevent over-tuning
        if (this.cooldownRemaining > 0) {
            return {
                mutations: [],
                applied: 0,
                reverted: 0,
                cycleId: `evolve_${Date.now()}`,
            };
        }
        const mutations = this.evolve(insights, config);
        const applied = this.applyMutations(config, mutations);
        if (applied > 0) {
            this.lastMutationTime = Date.now();
        }
        this.createPredictions(mutations, exp, taskTypes);
        (0, messageBus_1.getMessageBus)().publish('system.alert', 'evolver-agent', {
            type: 'evolution_cycle',
            mutations: mutations.length,
            applied: 0,
            canary: mutations.length > 0
                ? `pending (${this.defaultRolloutFraction * 100}% rollout)`
                : undefined,
            details: mutations.map((m) => ({
                id: m.id,
                domain: m.domain,
                description: m.description,
                oldValue: m.oldValue,
                newValue: m.newValue,
            })),
        });
        // Store as canary deployment instead of applying globally
        if (mutations.length > 0) {
            this.startCanary(mutations);
        }
        return {
            mutations,
            applied: 0, // Not applied globally — deployed as canary
            reverted: 0,
            cycleId: `evolve_${Date.now()}`,
        };
    }
    // ========================================================================
    // Canary Config Deployment API
    // ========================================================================
    /**
     * Check whether this run should use the canary config.
     * Returns true for a random fraction of runs when a canary is active.
     */
    shouldUseCanary() {
        if (!this.currentCanary)
            return false;
        // Active (undecided): random 10% rollout. Promoted: 100% rollout.
        // Rejected canaries have currentCanary = null, so they're blocked above.
        return Math.random() < this.currentCanary.rolloutFraction;
    }
    /**
     * Get the pending canary mutations that should be applied.
     * Returns null if no canary is active or run shouldn't use canary.
     */
    getCanaryMutations() {
        if (!this.currentCanary || this.currentCanary.decided)
            return null;
        return [...this.currentCanary.mutations];
    }
    /**
     * Record the outcome of a canary run.
     * Accumulates verdicts and auto-decides when enough data is collected.
     */
    recordCanaryVerdict(runId, success) {
        if (!this.currentCanary || this.currentCanary.decided)
            return;
        // Avoid double-counting
        if (this.currentCanary.runIds.includes(runId))
            return;
        this.currentCanary.runIds.push(runId);
        this.currentCanary.verdicts.push({
            runId,
            success,
            timestamp: new Date().toISOString(),
        });
        // Auto-decide when we have enough runs
        if (this.currentCanary.runIds.length >= this.currentCanary.minRuns) {
            const successRate = this.currentCanary.verdicts.filter((v) => v.success).length /
                this.currentCanary.verdicts.length;
            const ml = (0, metaLearner_1.getMetaLearner)();
            const recentVerdicts = ml
                .getVerdicts()
                .filter((v) => this.currentCanary.mutations.some((m) => m.id === v.predictionId));
            // Promote if success rate is good AND predictions are confirmed
            const predictionsPositive = recentVerdicts.length === 0 ||
                recentVerdicts.filter((v) => v.netImpact === 'positive').length >=
                    recentVerdicts.length * 0.5;
            if (successRate >= 0.5 && predictionsPositive) {
                this.promoteCanary();
            }
            else {
                this.rejectCanary();
            }
        }
    }
    /**
     * Promote the canary — apply to 100% of subsequent runs.
     */
    promoteCanary() {
        if (!this.currentCanary)
            return;
        this.currentCanary.decided = true;
        // After promotion, set rollout to 100% so all future runs use it
        this.currentCanary.rolloutFraction = 1.0;
        (0, messageBus_1.getMessageBus)().publish('system.alert', 'evolver-agent', {
            type: 'canary_promoted',
            mutations: this.currentCanary.mutations.length,
            runs: this.currentCanary.runIds.length,
            successRate: this.currentCanary.verdicts.length > 0
                ? this.currentCanary.verdicts.filter((v) => v.success).length /
                    this.currentCanary.verdicts.length
                : 0,
        });
    }
    /**
     * Reject the canary — discard pending mutations.
     */
    rejectCanary() {
        if (!this.currentCanary)
            return;
        const count = this.currentCanary.mutations.length;
        this.currentCanary = null;
        (0, messageBus_1.getMessageBus)().publish('system.alert', 'evolver-agent', {
            type: 'canary_rejected',
            mutations: count,
            reason: 'success_rate_below_threshold',
        });
    }
    /**
     * Get current canary deployment status.
     */
    getCanaryStatus() {
        if (!this.currentCanary) {
            return {
                active: false,
                mutations: 0,
                runCount: 0,
                rolloutFraction: 0,
                startedAt: 0,
                successRate: 0,
                decided: false,
                pendingRuns: 0,
            };
        }
        const successRate = this.currentCanary.verdicts.length > 0
            ? this.currentCanary.verdicts.filter((v) => v.success).length /
                this.currentCanary.verdicts.length
            : 0;
        return {
            active: true,
            mutations: this.currentCanary.mutations.length,
            runCount: this.currentCanary.runIds.length,
            rolloutFraction: this.currentCanary.rolloutFraction,
            startedAt: this.currentCanary.startedAt,
            successRate,
            decided: this.currentCanary.decided,
            pendingRuns: Math.max(0, this.currentCanary.minRuns - this.currentCanary.runIds.length),
        };
    }
    /**
     * Force-promote or force-reject a canary (admin action).
     */
    forceCanaryDecision(promote) {
        if (!this.currentCanary || this.currentCanary.decided)
            return;
        if (promote) {
            this.promoteCanary();
        }
        else {
            this.rejectCanary();
        }
    }
    // ── Internal canary helpers ─────────────────────────────────────────
    startCanary(mutations) {
        // If there's an existing undecided canary, merge the mutations
        if (this.currentCanary && !this.currentCanary.decided) {
            this.currentCanary.mutations.push(...mutations);
            return;
        }
        this.currentCanary = {
            mutations: [...mutations],
            rolloutFraction: this.defaultRolloutFraction,
            runIds: [],
            startedAt: Date.now(),
            minRuns: 5,
            verdicts: [],
            decided: false,
        };
    }
}
exports.EvolverAgent = EvolverAgent;
const tenantAwareSingleton_1 = require("../runtime/tenantAwareSingleton");
const evolverSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new EvolverAgent());
function getEvolverAgent() {
    return evolverSingleton.get();
}
function resetEvolverAgent() {
    evolverSingleton.reset();
}
// Circular-safe import (messageBus is imported at the bottom to avoid circular deps)
const messageBus_1 = require("../runtime/messageBus");
