/**
 * PASTE-style Speculative Execution
 *
 * Research finding (arXiv 2603.18897): Pattern-aware speculative execution
 * achieves 48.5% reduction in task completion time. Agents exhibit stable
 * control flows — the same tool sequences recur across tasks.
 *
 * During LLM thinking/processing time, we pre-execute the most likely
 * next tool calls based on observed patterns. If the model actually makes
 * those calls, results are already available (zero-wait). Wrong predictions
 * are discarded at no cost (read-only tools only).
 *
 * Safety: Only READ-ONLY tools are speculatively executed.
 * State-mutating tools (write, edit, shell, git) are NEVER speculatively
 * executed.
 */
/**
 * A tracked tool-call sequence pattern.
 */
interface ToolPattern {
    sequence: string[];
    frequency: number;
    lastSeen: number;
    confidence: number;
}
/**
 * Pattern tracker — records tool call sequences and identifies
 * recurring patterns.
 */
export declare class PatternTracker {
    private patterns;
    private recentSequence;
    private observationCount;
    /**
     * Record an observed tool call sequence.
     */
    recordSequence(toolNames: string[]): void;
    /**
     * Given a partial sequence, predict the most likely next tool(s).
     * Returns predictions sorted by confidence.
     */
    predictNext(partialSequence: string[]): Array<{
        toolName: string;
        confidence: number;
    }>;
    private extractNGrams;
    /**
     * Get the most common patterns for debugging/analysis.
     */
    getTopPatterns(n: number): ToolPattern[];
    private prunePatterns;
}
export declare function getPatternTracker(): PatternTracker;
export declare function resetPatternTracker(): void;
/**
 * Check if a tool is safe to execute speculatively.
 */
export declare function isSpeculativelySafe(toolName: string): boolean;
/**
 * Create a speculative execution plan.
 * Returns predicted next tool calls that should be pre-executed.
 */
export declare function planSpeculativeExecution(patternTracker: PatternTracker, recentToolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
}>, availableTools: string[]): Array<{
    name: string;
    arguments: Record<string, unknown>;
    confidence: number;
}>;
export {};
//# sourceMappingURL=speculativeExecutor.d.ts.map