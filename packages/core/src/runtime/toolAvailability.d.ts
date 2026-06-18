/**
 * Tool Availability — Boolean Expression System
 *
 * Surpasses OpenClaw's availability expressions by supporting:
 * - Boolean logic: allOf, anyOf, not
 * - Context predicates: budget phase, task type, step number, tool history
 * - Composable expressions: nest conditions arbitrarily
 * - Zero-cost evaluation: pure predicate functions, no LLM calls
 *
 * Used to dynamically filter which tools are available at each step,
 * reducing prompt size and preventing the model from calling tools
 * that aren't appropriate for the current context.
 */
/** Context available for predicate evaluation */
export interface AvailabilityContext {
    /** Current step number (0-indexed) */
    stepNumber: number;
    /** Total steps allowed */
    maxSteps: number;
    /** Token budget phase */
    budgetPhase: 'relaxed' | 'moderate' | 'tight' | 'critical';
    /** Remaining tokens */
    remainingTokens: number;
    /** Detected task type */
    taskType: string;
    /** Tools already used this run */
    toolsUsed: string[];
    /** Tools that errored this run */
    toolsErrored: string[];
    /** Agent ID */
    agentId: string;
    /** Run ID */
    runId: string;
}
/** A predicate that evaluates to true/false given context */
export type AvailabilityPredicate = (ctx: AvailabilityContext) => boolean;
/** An availability expression: either a predicate or a boolean combinator */
export type AvailabilityExpression = {
    type: 'predicate';
    predicate: AvailabilityPredicate;
    label?: string;
} | {
    type: 'allOf';
    children: AvailabilityExpression[];
} | {
    type: 'anyOf';
    children: AvailabilityExpression[];
} | {
    type: 'not';
    child: AvailabilityExpression;
} | {
    type: 'always';
} | {
    type: 'never';
};
export interface ToolAvailabilityRule {
    /** Tool name or pattern (supports * wildcard) */
    toolPattern: string;
    /** Availability expression */
    when: AvailabilityExpression;
    /** Priority (higher = checked first, allows override) */
    priority: number;
    /** Human-readable reason (for debugging/tracing) */
    reason?: string;
}
/** Tool is available only in early steps */
export declare function earlySteps(maxStep: number): AvailabilityExpression;
/** Tool is available only when budget is relaxed */
export declare function budgetRelaxed(): AvailabilityExpression;
/** Tool is available when budget is not critical */
export declare function budgetNotCritical(): AvailabilityExpression;
/** Tool is available for specific task types */
export declare function taskType(...types: string[]): AvailabilityExpression;
/** Tool is available only if not already used */
export declare function notYetUsed(): AvailabilityExpression;
/** Tool is available only if another tool was used first */
export declare function requiresTool(toolName: string): AvailabilityExpression;
/** Tool is disabled if it has errored too many times */
export declare function maxErrors(maxCount: number): AvailabilityExpression;
/** All children must be true */
export declare function allOf(...children: AvailabilityExpression[]): AvailabilityExpression;
/** At least one child must be true */
export declare function anyOf(...children: AvailabilityExpression[]): AvailabilityExpression;
/** Negate a child expression */
export declare function not(child: AvailabilityExpression): AvailabilityExpression;
/** Always available */
export declare function always(): AvailabilityExpression;
/** Never available */
export declare function never(): AvailabilityExpression;
/**
 * Evaluate an availability expression against a context.
 */
export declare function evaluate(expr: AvailabilityExpression, ctx: AvailabilityContext): boolean;
export declare class ToolAvailabilityManager {
    private rules;
    /**
     * Add an availability rule.
     * Uses insertion sort (O(N)) instead of full sort (O(N log N)).
     */
    addRule(rule: ToolAvailabilityRule): void;
    /**
     * Add multiple rules at once.
     * Sorts once after all inserts instead of per-insert.
     */
    addRules(rules: ToolAvailabilityRule[]): void;
    /**
     * Filter a list of tool names based on availability rules.
     * Returns only tools that pass all matching rules.
     */
    filterTools(availableTools: string[], ctx: AvailabilityContext): string[];
    /**
     * Check if a specific tool is available.
     */
    isAvailable(toolName: string, ctx: AvailabilityContext): boolean;
    /**
     * Get availability status for all tools (for debugging/tracing).
     */
    getStatus(availableTools: string[], ctx: AvailabilityContext): Array<{
        tool: string;
        available: boolean;
        reason?: string;
    }>;
    /**
     * Clear all rules.
     */
    clearRules(): void;
    /**
     * Get rule count.
     */
    getRuleCount(): number;
    /**
     * Match tool name against pattern. Supports * wildcard.
     */
    private matchesPattern;
}
/**
 * Default availability rules that apply sensible defaults.
 * Users can override or extend these.
 */
export declare function createDefaultRules(): ToolAvailabilityRule[];
//# sourceMappingURL=toolAvailability.d.ts.map