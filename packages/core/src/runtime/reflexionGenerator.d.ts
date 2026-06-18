/**
 * Reflexion Generator — Structured self-reflection for failed actions.
 *
 * Based on Reflexion (Shinn et al., NeurIPS 2023): after a failure, generate a
 * structured reflection (what failed, why, what to try next) and inject it into
 * the next attempt's context. The paper's ablation shows +8% absolute improvement
 * on HumanEval over raw retry — the highest-leverage self-improvement technique
 * available without model retraining.
 *
 * Strategy: heuristic-first, LLM-fallback. Most errors are common patterns
 * (timeout, not found, permission) that don't need an LLM call. Only novel or
 * ambiguous errors trigger an LLM call. LLM calls are bounded (200 tokens,
 * 10s timeout) to control cost.
 */
import type { LLMProvider } from './types';
import type { ErrorClass } from './llmRetry';
export interface ReflexionContext {
    /** Original user goal this action is part of. */
    goal: string;
    /** Human-readable description of what was attempted (e.g., tool name + args). */
    attemptedAction: string;
    /** The result/output that was returned before the error (if any). */
    actionResult: string;
    /** The error message. */
    error: string;
    /** Classified error class. */
    errorClass: ErrorClass;
    /** Which retry attempt this is (1-indexed). */
    attemptNumber: number;
    /** Previous reflexions for this action (so the next attempt avoids repeating them). */
    previousReflexions?: ReadonlyArray<Reflexion>;
}
export interface Reflexion {
    /** One sentence: what specifically went wrong. */
    whatFailed: string;
    /** One sentence: the likely root cause. */
    whyFailed: string;
    /** One sentence: a concrete, different approach to try next. */
    whatToTryNext: string;
    /** Confidence in this reflexion (0-1). */
    confidence: number;
    /** Whether this came from a heuristic pattern or an LLM call. */
    source: 'heuristic' | 'llm';
    /** Optional raw LLM output for debugging. */
    raw?: string;
}
export interface ReflexionGeneratorOptions {
    /** Max tokens for LLM-generated reflexion. Default: 200. */
    maxReflexionTokens?: number;
    /** Timeout for LLM call in ms. Default: 10000. */
    llmTimeoutMs?: number;
    /** When true, always use heuristic (skip LLM). */
    heuristicOnly?: boolean;
    /** When true, always use LLM (skip heuristic). */
    llmOnly?: boolean;
}
/**
 * Generates structured reflexions for failed actions.
 *
 * Always returns a usable reflexion — even when no LLM is available and no
 * pattern matches, a generic low-confidence reflexion is returned.
 */
export declare class ReflexionGenerator {
    readonly stats: {
        heuristicHits: number;
        llmCalls: number;
        llmFailures: number;
        genericFallbacks: number;
    };
    private readonly llmProvider;
    private readonly options;
    constructor(llmProvider?: LLMProvider, options?: ReflexionGeneratorOptions);
    /**
     * Generate a reflexion for the given context. Always returns a usable
     * reflexion (never throws). On error, falls back to generic heuristic.
     */
    generate(ctx: ReflexionContext): Promise<Reflexion>;
    private tryHeuristic;
    private generateWithLLM;
    private buildPrompt;
    private callLLMWithTimeout;
    private parseReflexion;
    /**
     * Format a reflexion for inclusion in an error message that will be shown
     * to the LLM in the next attempt's context.
     */
    static formatForContext(ctx: ReflexionContext, reflexion: Reflexion): string;
}
//# sourceMappingURL=reflexionGenerator.d.ts.map