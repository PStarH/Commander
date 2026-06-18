/**
 * RebuildPrompt — MiMo-inspired Layer 5: Context Reconstruction.
 *
 * When progressive compaction (Layers 1-4) can no longer keep the context
 * under budget, this module performs a full context window reset and
 * reconstructs a fresh prompt from structured, persistent storage.
 *
 * Core insight from MiMo Code:
 * - Layers 1-4 are summarization — they KEEP history, just compressed
 * - Layer 5 is RECONSTRUCTION — it discards all history and rebuilds
 * - The model sees a fresh, clean context; the harness preserves continuity
 *
 * Injection order (MiMo-aligned):
 * 1. System Prompt (original, always preserved)
 * 2. Task List / Goal
 * 3. Session State (from checkpoint.md via CheckpointWriter)
 * 4. Recent User Messages (verbatim last ~3 exchanges)
 * 5. Project Memory (from ThreeLayerMemory — embedded search)
 * 6. Next Step directive
 *
 * Each section has its own token budget. Total cap: ~65K tokens
 * (leaves 63K for the model to respond within a 128K window).
 */
import type { LLMMessage } from './types';
export interface RebuildParams {
    /** Run identifier for loading the checkpoint */
    runId: string;
    /** The original goal/task description */
    goal: string;
    /** Current phase (deliberation, execution, synthesis, etc.) */
    phase: string;
    /** Current step number */
    stepNumber: number;
    /** Original system prompt messages (always preserved) */
    systemPrompt: LLMMessage[];
    /** Recent user messages to carry forward verbatim */
    recentUserMessages: LLMMessage[];
    /** Token usage stats for the current run */
    tokenUsage: {
        totalTokens: number;
        budgetHardCap: number;
    };
    /** Optional: path to checkpoint file (auto-detected if not provided) */
    checkpointPath?: string;
}
export interface RebuildSection {
    name: string;
    cap: number;
    used: number;
    content: string;
}
export interface RebuildResult {
    messages: LLMMessage[];
    sections: RebuildSection[];
    totalTokens: number;
    budget: number;
    description: string;
}
export declare class RebuildPrompt {
    private rebuildCount;
    private readonly maxTrackedRuns;
    /**
     * Check if a rebuild is warranted.
     * External callers (e.g., CLI diagnostics) can use this for informational purposes.
     * The primary trigger path is via ContextCompactor.needsCompaction() → layer 5.
     */
    needsRebuild(runId: string, currentTokens: number, maxContextTokens: number, compactionCount: number): boolean;
    /**
     * Perform a context rebuild.
     *
     * Constructs a fresh set of messages by reading from:
     * 1. System prompt (preserved verbatim from original)
     * 2. Checkpoint.md (from CheckpointWriter on disk)
     * 3. ThreeLayerMemory (episodic + long-term search)
     * 4. Recent user messages
     *
     * The original conversation history is DISCARDED.
     * Only structured state is carried forward.
     */
    rebuild(params: RebuildParams): Promise<RebuildResult>;
    /**
     * Reset rebuild counter for a run (for tests, and after run completion).
     * Call this from the orchestrator's finally block to prevent unbounded Map growth.
     */
    resetRun(runId: string): void;
    /** Prune old run entries to prevent unbounded growth. */
    private pruneIfNeeded;
    private buildSystemSection;
    private buildTaskSection;
    private buildSessionSection;
    private buildRecentSection;
    private buildMemorySection;
    private buildNextStepSection;
}
/**
 * Check if a message was produced by the rebuild prompt.
 */
export declare function isRebuilt(msg: LLMMessage): boolean;
export declare function getRebuildPrompt(): RebuildPrompt;
export declare function resetRebuildPrompt(): void;
//# sourceMappingURL=rebuildPrompt.d.ts.map