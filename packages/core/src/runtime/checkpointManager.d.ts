/**
 * Checkpoint Manager — save and restore conversation state.
 *
 * Inspired by oh-my-pi's checkpoint/rewind tools. Allows the agent to:
 * - Save a checkpoint of the current conversation state
 * - Rewind to a previous checkpoint (prune exploratory context)
 * - Collapse a checkpoint into a concise report
 *
 * This is critical for long coding sessions where the model may need to
 * backtrack after trying an approach that didn't work.
 */
import type { LLMMessage } from './types';
export interface Checkpoint {
    /** Unique checkpoint ID */
    id: string;
    /** Human-readable label */
    label: string;
    /** Timestamp */
    timestamp: number;
    /** Messages at checkpoint time */
    messages: LLMMessage[];
    /** Token count at checkpoint */
    tokenCount: number;
    /** Step number at checkpoint */
    stepNumber: number;
    /** Files read at checkpoint (for hashline context) */
    filesRead: string[];
    /** Files modified at checkpoint */
    filesModified: string[];
}
export interface CheckpointSummary {
    id: string;
    label: string;
    timestamp: number;
    stepNumber: number;
    messageCount: number;
    tokenCount: number;
    filesRead: string[];
    filesModified: string[];
}
export declare class CheckpointManager {
    private checkpoints;
    private maxCheckpoints;
    constructor(maxCheckpoints?: number);
    /**
     * Save a checkpoint of the current conversation state.
     */
    save(label: string, messages: LLMMessage[], stepNumber: number, filesRead?: string[], filesModified?: string[]): Checkpoint;
    /**
     * Get a checkpoint by ID.
     */
    get(id: string): Checkpoint | undefined;
    /**
     * Get the most recent checkpoint.
     */
    getLatest(): Checkpoint | undefined;
    /**
     * List all checkpoints (summaries only, no message data).
     */
    list(): CheckpointSummary[];
    /**
     * Rewind to a checkpoint — return the messages to restore.
     * This effectively prunes all messages after the checkpoint.
     */
    rewind(id: string): LLMMessage[] | null;
    /**
     * Collapse a checkpoint into a concise summary.
     * Returns a system message that summarizes what happened since the checkpoint.
     */
    collapse(id: string): string | null;
    /**
     * Clear all checkpoints.
     */
    clear(): void;
    /**
     * Get checkpoint count.
     */
    get size(): number;
    private estimateTokens;
}
export declare function getCheckpointManager(): CheckpointManager;
export declare function resetCheckpointManager(): void;
//# sourceMappingURL=checkpointManager.d.ts.map