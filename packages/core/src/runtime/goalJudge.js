"use strict";
/**
 * Goal Judge — Independent verification with a separate, cheaper model.
 *
 * Core insight from competitive analysis (MiMo Code / OhMyPi):
 * The main agent model is inherently biased toward declaring "done" because
 * completion is its training objective. An independent judge model, running
 * a different provider/model, catches premature declarations by evaluating
 * the output against user-defined stop conditions.
 *
 * Design principles:
 * 1. **Separate model**: Always uses an eco-tier model (cheapest in cascade
 *    chain) — different provider from the main agent to avoid shared biases.
 * 2. **Stop conditions**: User-defined criteria that MUST be met before
 *    declaring completion (e.g., "all tests pass", "no TypeScript errors").
 * 3. **Adversarial stance**: The judge is instructed to find reasons the
 *    task is NOT complete — false negative bias is intentional.
 * 4. **Evidence-based**: The judge must cite specific evidence from the
 *    output, not just say "looks good".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoalJudge = exports.DEFAULT_GOAL_JUDGE_CONFIG = void 0;
exports.getGoalJudge = getGoalJudge;
exports.resetGoalJudge = resetGoalJudge;
const modelRouter_1 = require("./modelRouter");
const messageBus_1 = require("./messageBus");
const metricsCollector_1 = require("./metricsCollector");
const logging_1 = require("../logging");
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
exports.DEFAULT_GOAL_JUDGE_CONFIG = {
    enabled: true,
    judgeTokenBudget: 800,
    passThreshold: 0.8,
    maxJudgeRetries: 1,
};
// ============================================================================
// Stop Condition Registry (per-run)
// ============================================================================
class StopConditionRegistry {
    constructor() {
        /** Per-run conditions: runId → conditions */
        this.conditions = new Map();
        this.maxEntries = 200;
    }
    set(runId, conditions) {
        if (this.conditions.size >= this.maxEntries) {
            const firstKey = this.conditions.keys().next().value;
            if (firstKey)
                this.conditions.delete(firstKey);
        }
        this.conditions.set(runId, conditions);
    }
    get(runId) {
        var _a;
        return (_a = this.conditions.get(runId)) !== null && _a !== void 0 ? _a : [];
    }
    getGlobal() {
        var _a;
        return (_a = this.conditions.get('__global__')) !== null && _a !== void 0 ? _a : [];
    }
    setGlobal(conditions) {
        this.conditions.set('__global__', conditions);
    }
    delete(runId) {
        this.conditions.delete(runId);
    }
    reset() {
        this.conditions.clear();
    }
}
// ============================================================================
// Premature-declaration patterns (adversarial checks)
// ============================================================================
/**
 * Common phrases where agents declare "done" without evidence.
 * The judge checks for these and flags them as insufficient.
 */
const PREMATURE_DECLARATION_PATTERNS = [
    "I've completed the task",
    'The task is now complete',
    'All done!',
    'Everything is working',
    'The implementation is finished',
    'I have successfully',
    'Task completed successfully',
    'Done!',
    'Finished!',
];
// ============================================================================
// Judge prompt
// ============================================================================
function buildJudgePrompt(goal, output, conditions, evidenceCount) {
    const outputSnippet = output.length > 4000
        ? output.slice(0, 2000) + '\n...[truncated]...\n' + output.slice(-2000)
        : output;
    const conditionsBlock = conditions.length > 0
        ? conditions
            .map((c, i) => {
            let detail = `  ${i + 1}. [${c.type}] ${c.description}`;
            if (c.pattern)
                detail += `\n     Pattern: ${c.pattern}`;
            if (c.threshold !== undefined)
                detail += `\n     Threshold: ${c.threshold}`;
            if (c.customPrompt)
                detail += `\n     Custom: ${c.customPrompt}`;
            return detail;
        })
            .join('\n')
        : '  No specific stop conditions defined.';
    return [
        'You are an independent Goal Judge. Your job is ADVERSARIAL — actively find reasons',
        'the task is NOT complete. The main agent may have prematurely declared success.',
        '',
        '## Original Goal',
        goal.slice(0, 1000),
        '',
        '## Agent Output',
        outputSnippet,
        '',
        '## Stop Conditions (ALL must be satisfied)',
        conditionsBlock,
        '',
        '## Evidence Summary',
        `Tool calls executed: ${evidenceCount}`,
        '',
        '## Instructions',
        '1. Check EACH stop condition against the output. For each, state PASS or FAIL with evidence.',
        '2. Check if the output actually demonstrates completion (not just claims it).',
        `3. Watch for premature declarations: ${PREMATURE_DECLARATION_PATTERNS.slice(0, 5).join(', ')} etc.`,
        '4. If the agent claims success but shows no concrete evidence (files changed, tests run, etc.), FAIL.',
        '5. If you are unsure, lean toward FAIL — false negatives are safer than false positives.',
        '',
        'Reply JSON:',
        '{',
        '  "passed": true/false,',
        '  "confidence": 0.0-1.0,',
        '  "reasoning": "brief explanation",',
        '  "evidence": ["specific evidence 1", "specific evidence 2"],',
        '  "conditions": [',
        '    {"id": "cond-id", "passed": true/false, "evidence": "specific check result"}',
        '  ]',
        '}',
    ].join('\n');
}
// ============================================================================
// Goal Judge
// ============================================================================
class GoalJudge {
    constructor(config, provider) {
        this.verdictCache = new Map();
        this.maxCacheSize = 100;
        this.config = { ...exports.DEFAULT_GOAL_JUDGE_CONFIG, ...config };
        this.router = (0, modelRouter_1.getModelRouter)();
        this.provider = provider;
        this.registry = new StopConditionRegistry();
    }
    /**
     * Set the LLM provider for the judge (can be different from the main agent).
     */
    setProvider(provider) {
        this.provider = provider;
    }
    /**
     * Set the runtime reference to resolve cross-provider verification.
     */
    setRuntime(runtime) {
        this.runtime = runtime;
    }
    /**
     * Set per-run stop conditions. Called before execution starts.
     */
    setStopConditions(runId, conditions) {
        this.registry.set(runId, conditions);
    }
    /**
     * Set global stop conditions (applied to all runs).
     */
    setGlobalStopConditions(conditions) {
        this.registry.setGlobal(conditions);
    }
    /**
     * Get current stop conditions for a run (run-specific + global merged).
     */
    getStopConditions(runId) {
        const perRun = this.registry.get(runId);
        const global = this.registry.getGlobal();
        // Per-run conditions override global ones with the same id
        const merged = new Map();
        for (const c of global)
            merged.set(c.id, c);
        for (const c of perRun)
            merged.set(c.id, c);
        return Array.from(merged.values());
    }
    /**
     * Get global conditions only.
     */
    getGlobalStopConditions() {
        return this.registry.getGlobal();
    }
    /**
     * Clear per-run conditions.
     */
    clear(runId) {
        this.registry.delete(runId);
        this.verdictCache.delete(runId);
    }
    /**
     * Reset all state.
     */
    reset() {
        this.registry.reset();
        this.verdictCache.clear();
    }
    /**
     * Evaluate whether a task is truly complete.
     *
     * This is the main entry point. It:
     * 1. Resolves a cheap independent model (eco tier, different provider if possible)
     * 2. Runs the adversarial judge prompt with stop conditions
     * 3. Returns a verdict with pass/fail, reasoning, and evidence
     *
     * Falls back to a rule-based heuristic when no provider is available.
     */
    async judge(params) {
        const { runId, goal, output, evidenceCount = 0, idempotencyKey } = params;
        // Cache check for idempotent retries
        const cacheKey = idempotencyKey !== null && idempotencyKey !== void 0 ? idempotencyKey : `${runId}:${goal.slice(0, 50)}:${output.slice(0, 50)}`;
        const cached = this.verdictCache.get(cacheKey);
        if (cached) {
            (0, logging_1.getGlobalLogger)().debug('GoalJudge', 'Returning cached verdict', {
                cacheKey: cacheKey.slice(0, 60),
            });
            return cached;
        }
        const bus = (0, messageBus_1.getMessageBus)();
        const mc = (0, metricsCollector_1.getMetricsCollector)();
        const conditions = this.getStopConditions(runId);
        // Publish judge start event
        bus.publish('goal.judge_started', 'goal-judge', {
            runId,
            conditionCount: conditions.length,
            evidenceCount,
        });
        let verdict;
        // Try LLM-based judging if a provider is available
        if (this.provider && this.config.enabled) {
            try {
                verdict = await this.judgeWithLLM(goal, output, conditions, evidenceCount);
            }
            catch (err) {
                (0, logging_1.getGlobalLogger)().warn('GoalJudge', 'LLM judge failed, falling back to rule-based', {
                    error: err.message,
                });
                verdict = this.judgeWithRules(goal, output, conditions, evidenceCount);
                verdict.reasoning = `[LLM judge failed: ${err.message}] ${verdict.reasoning}`;
            }
        }
        else {
            // No provider → rule-based heuristic
            verdict = this.judgeWithRules(goal, output, conditions, evidenceCount);
            verdict.modelUsed = 'rule-based';
            verdict.provider = 'heuristic';
            verdict.tokensUsed = 0;
        }
        // Cache and publish
        this.verdictCache.set(cacheKey, verdict);
        if (this.verdictCache.size > this.maxCacheSize) {
            const firstKey = this.verdictCache.keys().next().value;
            if (firstKey)
                this.verdictCache.delete(firstKey);
        }
        bus.publish('goal.judge_completed', 'goal-judge', {
            runId,
            passed: verdict.passed,
            confidence: verdict.confidence,
            tokensUsed: verdict.tokensUsed,
            modelUsed: verdict.modelUsed,
        });
        try {
            mc.incrementCounter('goal_judge_total', 'Goal judge verdicts', 1, [
                { name: 'passed', value: String(verdict.passed) },
                { name: 'model', value: verdict.modelUsed },
            ]);
        }
        catch {
            /* best-effort */
        }
        return verdict;
    }
    // --------------------------------------------------------------------------
    // LLM-based judging
    // --------------------------------------------------------------------------
    async judgeWithLLM(goal, output, conditions, evidenceCount) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
        // Select cheapest eco model from the cascade chain
        const cascade = this.router.getCascadeChain('general', 3);
        const judgeModel = (_a = cascade[0]) !== null && _a !== void 0 ? _a : this.router.getModel('gpt-4o-mini');
        const modelId = (_c = (_b = this.config.model) !== null && _b !== void 0 ? _b : judgeModel === null || judgeModel === void 0 ? void 0 : judgeModel.id) !== null && _c !== void 0 ? _c : 'gpt-4o-mini';
        // Resolve the provider — prefer a different provider from the main agent
        // to avoid shared biases (e.g., if main agent uses claude-sonnet, judge
        // could use gpt-4o-mini). The cascade chain's first entry is typically eco-tier.
        const resolvedModel = (_d = this.router.getModel(modelId)) !== null && _d !== void 0 ? _d : judgeModel;
        const providerName = (_e = resolvedModel === null || resolvedModel === void 0 ? void 0 : resolvedModel.provider) !== null && _e !== void 0 ? _e : 'openai';
        // Build the judge prompt
        const prompt = buildJudgePrompt(goal, output, conditions, evidenceCount);
        const maxTokens = Math.min(this.config.judgeTokenBudget, 300);
        // Use the provider — prefixed model for routing
        const apiModel = modelId.replace(/@\w+$/, '');
        const request = {
            model: apiModel,
            messages: [{ role: 'user', content: prompt }],
            maxTokens,
            temperature: 0, // Deterministic judging
        };
        // Resolve cross-provider: try to use a different provider from the main agent
        let judgeProvider = this.provider;
        if (this.runtime && providerName) {
            const crossProvider = this.runtime.getProvider(providerName);
            if (crossProvider && crossProvider !== this.provider) {
                judgeProvider = crossProvider;
            }
        }
        const startTime = Date.now();
        const response = await (judgeProvider !== null && judgeProvider !== void 0 ? judgeProvider : this.provider).call(request);
        const elapsed = Date.now() - startTime;
        const tokensUsed = (_g = (_f = response.usage) === null || _f === void 0 ? void 0 : _f.totalTokens) !== null && _g !== void 0 ? _g : 0;
        // Parse the JSON response
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        let parsed;
        try {
            parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        }
        catch {
            parsed = null;
        }
        if (!parsed || typeof parsed.passed !== 'boolean') {
            // Failed to parse — use rule-based fallback
            (0, logging_1.getGlobalLogger)().warn('GoalJudge', 'Failed to parse judge LLM response, using rule-based fallback', {
                content: response.content.slice(0, 200),
            });
            const fallback = this.judgeWithRules(goal, output, conditions, evidenceCount);
            fallback.tokensUsed = tokensUsed;
            fallback.modelUsed = modelId;
            fallback.provider = providerName;
            fallback.reasoning = `[Parse failed] ${fallback.reasoning}`;
            return fallback;
        }
        const conditionsChecked = Array.isArray(parsed.conditions)
            ? parsed.conditions.map((c) => {
                var _a, _b, _c, _d, _e, _f;
                return ({
                    conditionId: (_a = c.id) !== null && _a !== void 0 ? _a : 'unknown',
                    description: (_d = (_c = (_b = conditions.find((sc) => sc.id === c.id)) === null || _b === void 0 ? void 0 : _b.description) !== null && _c !== void 0 ? _c : c.id) !== null && _d !== void 0 ? _d : 'unknown',
                    passed: (_e = c.passed) !== null && _e !== void 0 ? _e : false,
                    evidence: (_f = c.evidence) !== null && _f !== void 0 ? _f : '',
                });
            })
            : conditions.map((c) => ({
                conditionId: c.id,
                description: c.description,
                passed: parsed.passed,
                evidence: 'Judged holistically',
            }));
        const verdict = {
            passed: parsed.passed,
            confidence: Math.max(0, Math.min(1, (_h = parsed.confidence) !== null && _h !== void 0 ? _h : (parsed.passed ? 0.8 : 0.3))),
            reasoning: (_j = parsed.reasoning) !== null && _j !== void 0 ? _j : 'No reasoning provided',
            evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
            conditionsChecked,
            modelUsed: modelId,
            provider: providerName,
            tokensUsed,
            timestamp: Date.now(),
        };
        try {
            (0, metricsCollector_1.getMetricsCollector)().recordLLMCall(modelId, providerName, tokensUsed, elapsed, undefined, undefined);
        }
        catch {
            /* best-effort */
        }
        return verdict;
    }
    // --------------------------------------------------------------------------
    // Rule-based fallback judging (zero-cost, works without provider)
    // --------------------------------------------------------------------------
    judgeWithRules(goal, output, conditions, evidenceCount) {
        const outputLower = output.toLowerCase();
        const conditionsChecked = [];
        const evidence = [];
        let allPassed = true;
        // 1. Check premature declaration signals
        let hasPrematureSignal = false;
        for (const pattern of PREMATURE_DECLARATION_PATTERNS) {
            if (outputLower.includes(pattern.toLowerCase())) {
                hasPrematureSignal = true;
                evidence.push(`WARNING: Output contains premature declaration: "${pattern}"`);
                break;
            }
        }
        // 2. Check each stop condition
        for (const c of conditions) {
            const result = this.checkCondition(c, output, goal);
            conditionsChecked.push(result);
            if (!result.passed) {
                allPassed = false;
                evidence.push(`FAILED condition [${c.id}]: ${result.evidence}`);
            }
            else {
                evidence.push(`PASSED condition [${c.id}]: ${result.evidence}`);
            }
        }
        // 3. Evidence count check: very low evidence with premature declaration = fail
        if (evidenceCount < 2 && hasPrematureSignal) {
            allPassed = false;
            evidence.push(`INSUFFICIENT: Only ${evidenceCount} tool calls but claims completion`);
        }
        // 4. Output length check: trivially short outputs with "done" signal are suspicious
        const outputWords = output.split(/\s+/).length;
        if (outputWords < 50 && hasPrematureSignal) {
            allPassed = false;
            evidence.push(`SUSPICIOUS: Short output (${outputWords} words) with completion claim`);
        }
        // 5. Check if goal keywords appear in the output (basic relevance)
        const goalKeywords = goal
            .split(/\s+/)
            .filter((w) => w.length > 4)
            .map((w) => w.toLowerCase());
        const matchedKeywords = goalKeywords.filter((kw) => outputLower.includes(kw));
        const keywordRatio = goalKeywords.length > 0 ? matchedKeywords.length / goalKeywords.length : 1;
        if (keywordRatio < 0.3 && goalKeywords.length > 3) {
            allPassed = false;
            evidence.push(`RELEVANCE: Only ${matchedKeywords.length}/${goalKeywords.length} goal keywords found in output`);
        }
        const confidence = allPassed ? 0.75 : 0.3;
        const reasoning = allPassed
            ? `Rule-based check passed: ${conditionsChecked.length} conditions checked, ${evidenceCount} tool calls, no premature-declaration flags.`
            : `Rule-based check failed: ${conditionsChecked.filter((c) => !c.passed).length}/${conditionsChecked.length} conditions not met.`;
        return {
            passed: allPassed,
            confidence,
            reasoning,
            evidence,
            conditionsChecked,
            modelUsed: 'rule-based',
            provider: 'heuristic',
            tokensUsed: 0,
            timestamp: Date.now(),
        };
    }
    checkCondition(condition, output, _goal) {
        var _a, _b, _c, _d;
        const outputLower = output.toLowerCase();
        switch (condition.type) {
            case 'MUST_HAVE': {
                const pattern = (_a = condition.pattern) !== null && _a !== void 0 ? _a : condition.description;
                const found = outputLower.includes(pattern.toLowerCase());
                return {
                    conditionId: condition.id,
                    description: condition.description,
                    passed: found,
                    evidence: found ? `Found "${pattern}" in output` : `Missing "${pattern}" in output`,
                };
            }
            case 'MUST_NOT_HAVE': {
                const pattern = (_b = condition.pattern) !== null && _b !== void 0 ? _b : condition.description;
                const found = outputLower.includes(pattern.toLowerCase());
                return {
                    conditionId: condition.id,
                    description: condition.description,
                    passed: !found,
                    evidence: found
                        ? `Found forbidden pattern "${pattern}" in output`
                        : `Forbidden pattern "${pattern}" not found`,
                };
            }
            case 'MUST_MATCH': {
                if (!condition.pattern) {
                    return {
                        conditionId: condition.id,
                        description: condition.description,
                        passed: false,
                        evidence: 'No pattern specified for MUST_MATCH condition',
                    };
                }
                try {
                    const regex = new RegExp(condition.pattern, 'i');
                    const match = regex.test(output);
                    return {
                        conditionId: condition.id,
                        description: condition.description,
                        passed: match,
                        evidence: match
                            ? `Output matches pattern: ${condition.pattern}`
                            : `Output does not match pattern: ${condition.pattern}`,
                    };
                }
                catch {
                    return {
                        conditionId: condition.id,
                        description: condition.description,
                        passed: false,
                        evidence: `Invalid regex pattern: ${condition.pattern}`,
                    };
                }
            }
            case 'MUST_BE_ABOVE':
                // MUST_BE_ABOVE requires semantic understanding to find the right number.
                // Rule-based mode cannot reliably distinguish "100 tests passed" from
                // "100 errors found". Mark as requiring LLM judge.
                return {
                    conditionId: condition.id,
                    description: condition.description,
                    passed: false,
                    evidence: `MUST_BE_ABOVE requires LLM judge — cannot reliably verify threshold ${(_c = condition.threshold) !== null && _c !== void 0 ? _c : 0} in rule-based mode`,
                };
            case 'CUSTOM':
                // CUSTOM conditions can only be evaluated by LLM.
                // Rule-based mode marks them as passed with a note.
                return {
                    conditionId: condition.id,
                    description: condition.description,
                    passed: true,
                    evidence: 'CUSTOM condition requires LLM judge — passed by default in rule-based mode',
                };
            default:
                return {
                    conditionId: condition.id,
                    description: condition.description,
                    passed: false,
                    evidence: `Unknown condition type: ${(_d = condition.type) !== null && _d !== void 0 ? _d : 'undefined'}`,
                };
        }
    }
}
exports.GoalJudge = GoalJudge;
// ============================================================================
// Singleton
// ============================================================================
const goalJudgeSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new GoalJudge());
/** Get the global GoalJudge (single-tenant) or tenant-scoped (multi-tenant). */
function getGoalJudge() {
    return goalJudgeSingleton.get();
}
/** Reset the GoalJudge singleton (for test isolation). */
function resetGoalJudge() {
    goalJudgeSingleton.reset();
}
