/**
 * Sliding Window Orchestrator — sliding window + ThreeLayerMemory retrieval.
 *
 * Solves the "Context Rot" problem for long-running agents:
 *   1. Bounded active context: drops oldest turns after configurable window size
 *   2. Periodic solidification: stores dropped turns in episodic memory (no data loss)
 *   3. Warm-start retrieval: before each LLM call, injects relevant past memories
 *
 * Research backing:
 * - "Context Rot" (Chroma, 2025): performance degrades with sequence length due to
 *   information density dilution; bounded windows retain per-step accuracy
 * - "Generative Agents" (Park et al., 2023): episodic memory + retrieval augments
 *   LLM context without ballooning the active window
 * - "MemGPT" (Packer et al., 2023): fixed-size context window with external memory
 *   achieves 10x longer coherent sessions than pure sliding window
 *
 * Dependencies: ThreeLayerMemory (for storage), ContextCompactor (for summaries).
 * Wired into AgentRuntime after each tool loop iteration.
 */
import type { LLMMessage } from './types';
export interface SlidingWindowConfig {
    /** Enable sliding window management (default: true) */
    enabled: boolean;
    /** Maximum number of turns (user+assistant+tool groups) to keep in active context (default: 15) */
    maxTurnsInWindow: number;
    /** Solidify to memory every N tool-loop iterations (default: 5) */
    solidifyEveryNTurns: number;
    /** Number of memory entries to retrieve before each LLM call (default: 3) */
    contextRetrievalTopK: number;
    /** Inject retrieved memory summaries as system messages before LLM calls (default: true) */
    injectRetrievedContext: boolean;
    /** Minimum importance threshold for retrieved memories (default: 0.4) */
    retrievalImportanceThreshold: number;
    /** Max chars per memory entry in injected context (default: 400) */
    maxMemoryEntryChars: number;
    /** Max total chars for injected memory block (default: 2000) */
    maxMemoryBlockChars: number;
}
export interface SolidifyAction {
    /** Number of turns solidified */
    turnsSolidified: number;
    /** Number of memory entries written */
    entriesWritten: number;
    /** Estimated tokens freed from active context */
    tokensFreed: number;
    /** Summary of what was solidified */
    summary: string;
}
export interface WindowAction {
    /** Whether windowing was applied */
    applied: boolean;
    /** Number of turns dropped (would be solidified first) */
    turnsDropped: number;
    /** Number of non-system messages dropped */
    messagesDropped: number;
    /** Estimated tokens freed */
    tokensFreed: number;
}
export interface RetrievalAction {
    /** Number of memory entries retrieved */
    entriesRetrieved: number;
    /** Injected context text (empty if none) */
    injectedContext: string;
    /** Estimated tokens of injected context */
    injectedTokens: number;
}
/**
 * SlidingWindowOrchestrator manages the Agent's active context window.
 *
 * It works alongside (not replacing) the existing ContextCompactor:
 * - ContextCompactor: compresses within the window (trimming tool outputs, compacting messages)
 * - SlidingWindowOrchestrator: enforces the window boundary (dropping old turns to memory)
 *
 * The two are complementary — the compactor handles fine-grained compression inside
 * the window, while this module handles coarse-grained window sliding + memory retrieval.
 */
export declare class SlidingWindowOrchestrator {
    private config;
    /** Turn counter for the current execution session */
    private turnCount;
    /** Last turn index that was solidified */
    private lastSolidifyIndex;
    /** Messages dropped from window (tracked for diagnostics) */
    private totalDroppedMessages;
    private totalSolidifiedTurns;
    constructor(config?: Partial<SlidingWindowConfig>);
    getConfig(): SlidingWindowConfig;
    updateConfig(config: Partial<SlidingWindowConfig>): void;
    /** Reset session counters (call at start of each execute()) */
    resetSession(): void;
    getStats(): {
        turnCount: number;
        totalDropped: number;
        totalSolidified: number;
    };
    /**
     * Check whether we should solidify completed turns to memory.
     */
    shouldSolidify(): boolean;
    /**
     * Solidify completed turns into ThreeLayerMemory.
     *
     * Takes turns between the last solidify point and current turn,
     * builds a structured summary, and stores it as an episodic memory entry.
     * Optional tag inference from the messages.
     *
     * @param messages - The full message array (needed to extract turns to solidify)
     * @param memory - The ThreeLayerMemory instance to write to
     * @param goal - The original goal for context tagging
     * @param runId - Run ID for traceability
     * @returns SolidifyAction with stats
     */
    solidifyCompletedTurns(messages: LLMMessage[], memory: import('../threeLayerMemory').ThreeLayerMemory, goal: string, runId: string): Promise<SolidifyAction>;
    /**
     * Apply sliding window to messages array.
     *
     * Drops the oldest turns that fall outside maxTurnsInWindow,
     * injecting a compact memory-reference placeholder for context continuity.
     *
     * @param messages - Current message array (will be modified in place)
     * @returns WindowAction with stats
     */
    applyWindow(messages: LLMMessage[]): WindowAction;
    /**
     * Retrieve relevant context from ThreeLayerMemory before an LLM call.
     *
     * Searches memory using goal keywords and recent tool activity,
     * returns a formatted context string to inject as a system message.
     *
     * @param memory - ThreeLayerMemory instance
     * @param goal - The original goal
     * @param messages - Current messages (for extracting recent context keywords)
     * @returns RetrievalAction with the context block (or empty if nothing found)
     */
    retrieveContext(memory: import('../threeLayerMemory').ThreeLayerMemory, goal: string, messages: LLMMessage[]): RetrievalAction;
    /** Increment turn counter (call at each tool loop iteration) */
    incrementTurn(): void;
    /**
     * Parse messages into turns — groups user+assistant+tool messages into turns.
     * A turn starts with a user message or the first non-system message.
     */
    private parseTurns;
    /** Extract recent tool names from the last N messages */
    private extractRecentToolNames;
    /** Infer tags from turns and goal for memory storage */
    private inferTags;
}
//# sourceMappingURL=slidingWindowOrchestrator.d.ts.map