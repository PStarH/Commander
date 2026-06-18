/**
 * CheckpointWriter — MiMo-inspired independent checkpoint sub-agent.
 *
 * Core insight from MiMo Code: the agent is NOT the LLM — it's the harness.
 * Memory management must happen OUTSIDE the main agent's attention, using a
 * dedicated sub-agent that runs at strategic token-budget thresholds.
 *
 * This writer:
 * 1. Triggers at 20%, 45%, 70% of the hard token cap (not emergency thresholds)
 * 2. Runs as a fire-and-forget LLM call, not consuming main agent context
 * 3. Produces a structured checkpoint.md that feeds the Rebuild Prompt mechanism
 * 4. Writes to .commander/memory/checkpoints/{runId}.md with version tracking
 *
 * Key difference from existing StateCheckpointer:
 * - StateCheckpointer: saves raw execution state for crash recovery (in-band)
 * - CheckpointWriter: produces human/LLM-readable progress document (out-of-band)
 */
import type { LLMProvider } from './types';
export interface CheckpointWriterConfig {
    /** Trigger points as percentage of the hard token cap */
    triggerPoints: number[];
    /** Minimum interval between checkpoints in ms */
    minIntervalMs: number;
    /** Max tokens for the writer LLM call */
    writerTokenBudget: number;
    /** Base directory for checkpoint files */
    storageDir?: string;
}
export interface CheckpointTrigger {
    /** Which trigger point fired (20, 45, 70, or 100 for terminal) */
    percent: number;
    /** Total tokens used so far */
    tokensUsed: number;
    /** Hard cap tokens */
    tokensHardCap: number;
    /** Percentage of budget used */
    ratio: number;
}
export interface CheckpointDocument {
    /** Run identifier */
    runId: string;
    /** Monotonic version number within this run */
    version: number;
    /** ISO timestamp */
    timestamp: string;
    /** Which trigger point fired */
    triggerPercent: number;
    goal: string;
    phase: string;
    stepNumber: number;
    completedSubtasks: Array<{
        id: string;
        goal: string;
        result: string;
        tokensUsed: number;
        durationMs: number;
    }>;
    pendingSubtasks: Array<{
        id: string;
        goal: string;
        estimatedTokens: number;
    }>;
    failedSubtasks: Array<{
        id: string;
        goal: string;
        error: string;
    }>;
    keyDecisions: string[];
    filesRead: string[];
    filesModified: string[];
    errors: Array<{
        nodeId: string;
        message: string;
        recovered: boolean;
    }>;
    tokensUsed: number;
    tokensRemaining: number;
    budgetHardCap: number;
    nextAction: string;
    recentMessages: Array<{
        role: string;
        content: string;
    }>;
}
export interface CheckpointResult {
    runId: string;
    version: number;
    filePath: string;
    triggerPercent: number;
    tokensUsed: number;
    tokensRemaining: number;
    completedCount: number;
    pendingCount: number;
    failedCount: number;
    durationMs: number;
}
export declare class CheckpointWriter {
    private config;
    /** Tracks which trigger points have already fired per runId */
    private firedTriggers;
    /** Tracks last checkpoint time per runId (min interval enforcement) */
    private lastCheckpointTime;
    /** Version counter per runId */
    private versionCounter;
    constructor(config?: Partial<CheckpointWriterConfig>);
    /**
     * Check if a checkpoint should be written at this point.
     * Returns the trigger that fired, or null if no trigger should fire.
     */
    shouldTrigger(runId: string, tokensUsed: number, tokensHardCap: number): CheckpointTrigger | null;
    /**
     * Force a checkpoint regardless of trigger points.
     * Useful for manual CLI invocation or pre-shutdown.
     */
    forceTrigger(runId: string): CheckpointTrigger;
    /**
     * Write a checkpoint document for the given run.
     *
     * @param params - The data needed to build the checkpoint
     * @param provider - LLM provider for generating the structured checkpoint
     *                   (if null, uses a rule-based fallback)
     */
    writeCheckpoint(params: {
        runId: string;
        goal: string;
        phase: string;
        stepNumber: number;
        completedSubtasks: CheckpointDocument['completedSubtasks'];
        pendingSubtasks: CheckpointDocument['pendingSubtasks'];
        failedSubtasks: CheckpointDocument['failedSubtasks'];
        keyDecisions: string[];
        filesRead: string[];
        filesModified: string[];
        errors: CheckpointDocument['errors'];
        tokensUsed: number;
        tokensHardCap: number;
        recentMessages: CheckpointDocument['recentMessages'];
        trigger: CheckpointTrigger;
    }, provider?: LLMProvider): Promise<CheckpointResult>;
    private persist;
    /**
     * Convert checkpoint document to Markdown (checkpoint.md format).
     */
    private toMarkdown;
    /**
     * Use a lightweight LLM call to enrich the checkpoint with:
     * - A concise next-action recommendation
     * - Extracted key decisions the rule-based approach may miss
     */
    private enrichWithLLM;
    /**
     * Load a checkpoint document from disk.
     */
    loadCheckpoint(runId: string): CheckpointDocument | null;
    /**
     * List all checkpoint files on disk.
     */
    listCheckpoints(): Array<{
        runId: string;
        filePath: string;
        size: number;
        modifiedAt: string;
    }>;
    /**
     * Delete all checkpoints for a run.
     */
    deleteCheckpoints(runId: string): void;
    /**
     * Reset all writer state (for tests).
     */
    reset(): void;
    /**
     * Parse summary metadata from the checkpoint markdown.
     * This is a lightweight extractor for listing mode — it reads the
     * metadata header block (first ~15 lines) to avoid full O(n²) I/O.
     * The markdown now includes a metadata line with counts/budget/next-action.
     */
    private parseMarkdown;
}
export declare function getCheckpointWriter(): CheckpointWriter;
export declare function resetCheckpointWriter(): void;
//# sourceMappingURL=checkpointWriter.d.ts.map