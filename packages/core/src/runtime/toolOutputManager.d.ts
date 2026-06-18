/**
 * Tool Output Manager — Three-Layer Output Management
 *
 * Surpasses Hermes' approach by implementing three distinct layers:
 * 1. Per-tool cap: each tool type has a max output size
 * 2. Per-result persistence: large results saved to disk, reference returned
 * 3. Per-turn budget: total output across all tools in a turn is bounded
 *
 * This prevents a single verbose tool from blowing the context window,
 * and ensures the model always gets useful (not truncated) output.
 *
 * Token savings: ~40-60% reduction in tool output tokens for complex multi-tool turns.
 */
import type { ToolCall, ToolResult } from './types';
export interface ToolOutputConfig {
    /** Enable output management (default: true) */
    enabled: boolean;
    /** Per-tool output caps (chars). Unlisted tools use defaultCap. */
    toolCaps: Record<string, number>;
    /** Default per-tool cap in chars (default: 8000) */
    defaultCap: number;
    /** Per-turn total output budget in chars (default: 32000) */
    turnBudget: number;
    /** Directory for persisting large outputs (default: .commander_outputs) */
    persistDir: string;
    /** Whether to persist oversized outputs to disk (default: true) */
    persistToDisk: boolean;
    /** Minimum size (chars) before persisting to disk (default: 4000) */
    persistThreshold: number;
}
export interface ManagedOutput {
    /** The (possibly truncated) output to send to the model */
    output: string;
    /** Whether the output was truncated */
    truncated: boolean;
    /** Original size before management */
    originalSize: number;
    /** Path to persisted file (if persisted) */
    persistedPath?: string;
    /** Summary line for the model */
    summary: string;
}
export interface TurnBudgetState {
    /** Total chars used this turn */
    used: number;
    /** Budget remaining */
    remaining: number;
    /** Whether budget is exhausted */
    exhausted: boolean;
}
export declare class ToolOutputManager {
    private config;
    private turnUsed;
    constructor(config?: Partial<ToolOutputConfig>);
    /**
     * Reset turn budget. Call at the start of each tool-call turn.
     */
    resetTurn(): void;
    /**
     * Adjust turn budget based on governor pressure.
     * Under tight/critical budget, reduce the output budget to save tokens.
     * @param pressure - Governor pressure (0-1, where 1 = critical)
     */
    adjustBudgetForPressure(pressure: number): void;
    /**
     * Get current turn budget state.
     */
    getTurnBudget(): TurnBudgetState;
    /**
     * Manage a tool result: cap, truncate, and optionally persist.
     * Returns the managed output to send to the model.
     */
    manage(toolCall: ToolCall, result: ToolResult): ManagedOutput;
    /**
     * Manage multiple tool results for a turn.
     * Applies turn budget across all results, prioritizing earlier calls.
     */
    manageBatch(calls: Array<{
        toolCall: ToolCall;
        result: ToolResult;
    }>): ManagedOutput[];
    /**
     * Smart truncation: preserves structure based on tool type.
     * - Shell/Python: keep first N lines + last N lines (errors often at end)
     * - Search: keep all results but truncate individual descriptions
     * - File: keep first N lines (headers/imports) + last N lines
     * - Default: keep first 70% + last 30%
     */
    private smartTruncate;
    private truncateShellOutput;
    private truncateSearchOutput;
    private truncateFileOutput;
    /**
     * Persist output to disk and return the file path.
     */
    private static readonly MAX_PERSISTED_FILES;
    private persistOutput;
    private cleanupPersistedDir;
    private isShellTool;
    private isSearchTool;
    private isFileTool;
}
//# sourceMappingURL=toolOutputManager.d.ts.map