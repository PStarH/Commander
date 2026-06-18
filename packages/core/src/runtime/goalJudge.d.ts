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
import type { LLMProvider } from './types';
export interface StopCondition {
    /** Unique identifier (e.g., "no-ts-errors", "all-tests-pass") */
    id: string;
    /** Human-readable description shown to the judge and in CLI */
    description: string;
    /** Condition type determines how the judge evaluates it */
    type: 'MUST_HAVE' | 'MUST_NOT_HAVE' | 'MUST_MATCH' | 'MUST_BE_ABOVE' | 'CUSTOM';
    /** Pattern to check (for MUST_MATCH: regex; for MUST_HAVE: substring) */
    pattern?: string;
    /** Numeric threshold (for MUST_BE_ABOVE: e.g., test pass count) */
    threshold?: number;
    /** Custom evaluation prompt appended to judge instructions (for CUSTOM) */
    customPrompt?: string;
}
export interface StopConditionResult {
    conditionId: string;
    description: string;
    passed: boolean;
    evidence: string;
}
export interface JudgeVerdict {
    /** Did the output pass all stop conditions? */
    passed: boolean;
    /** Confidence 0-1 in the verdict */
    confidence: number;
    /** Human-readable reasoning */
    reasoning: string;
    /** Specific evidence from the output supporting the verdict */
    evidence: string[];
    /** Per-condition results */
    conditionsChecked: StopConditionResult[];
    /** Model used for judging */
    modelUsed: string;
    /** Provider used for judging */
    provider: string;
    /** Tokens consumed by the judge call */
    tokensUsed: number;
    /** When the verdict was made */
    timestamp: number;
}
export interface GoalJudgeConfig {
    /** Whether the judge gate is active */
    enabled: boolean;
    /** Specific model to use (default: cheapest eco model from cascade) */
    model?: string;
    /** Maximum token budget for the judge call (default: 800) */
    judgeTokenBudget: number;
    /** Minimum confidence to pass (default: 0.8) */
    passThreshold: number;
    /** Maximum judge retries — if exceeded, the verdict defaults to pass
     *  to avoid blocking the agent indefinitely (default: 1) */
    maxJudgeRetries: number;
}
export declare const DEFAULT_GOAL_JUDGE_CONFIG: GoalJudgeConfig;
export declare class GoalJudge {
    private config;
    private router;
    private provider?;
    private runtime?;
    private registry;
    private verdictCache;
    private readonly maxCacheSize;
    constructor(config?: Partial<GoalJudgeConfig>, provider?: LLMProvider);
    /**
     * Set the LLM provider for the judge (can be different from the main agent).
     */
    setProvider(provider: LLMProvider): void;
    /**
     * Set the runtime reference to resolve cross-provider verification.
     */
    setRuntime(runtime: {
        getProvider(name: string): LLMProvider | undefined;
    }): void;
    /**
     * Set per-run stop conditions. Called before execution starts.
     */
    setStopConditions(runId: string, conditions: StopCondition[]): void;
    /**
     * Set global stop conditions (applied to all runs).
     */
    setGlobalStopConditions(conditions: StopCondition[]): void;
    /**
     * Get current stop conditions for a run (run-specific + global merged).
     */
    getStopConditions(runId: string): StopCondition[];
    /**
     * Get global conditions only.
     */
    getGlobalStopConditions(): StopCondition[];
    /**
     * Clear per-run conditions.
     */
    clear(runId: string): void;
    /**
     * Reset all state.
     */
    reset(): void;
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
    judge(params: {
        runId: string;
        goal: string;
        output: string;
        evidenceCount?: number;
        /** Optional cached verdict for idempotency */
        idempotencyKey?: string;
    }): Promise<JudgeVerdict>;
    private judgeWithLLM;
    private judgeWithRules;
    private checkCondition;
}
/** Get the global GoalJudge (single-tenant) or tenant-scoped (multi-tenant). */
export declare function getGoalJudge(): GoalJudge;
/** Reset the GoalJudge singleton (for test isolation). */
export declare function resetGoalJudge(): void;
//# sourceMappingURL=goalJudge.d.ts.map