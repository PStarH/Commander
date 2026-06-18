import type { LLMMessage, TokenUsage } from './types';
/**
 * Context Window Manager
 *
 * Manages LLM conversation context window via two complementary strategies:
 * 1. **Sliding window**: Drops oldest non-system messages when approaching the limit.
 * 2. **Summarization**: Compresses dropped messages into a brief summary that is
 *    injected as a system message to preserve key context.
 *
 * Reference: LangChain context window management, Claude Code's sliding window approach.
 */
export interface ContextWindowConfig {
    /** Maximum context tokens before windowing activates (default: 128000) */
    maxContextTokens: number;
    /** Token threshold (%) that triggers windowing (default: 0.75 = 75% full) */
    triggerThreshold: number;
    /** Number of most recent messages to always keep (default: 10) */
    keepRecentCount: number;
    /** Whether to generate summaries for dropped messages (default: false) */
    enableSummarization: boolean;
    /** Estimated tokens per message overhead (default: 50) */
    messageOverheadTokens: number;
}
export interface WindowAction {
    /** Whether windowing was applied */
    applied: boolean;
    /** Number of messages dropped */
    droppedCount: number;
    /** Estimated tokens saved */
    tokensSaved: number;
    /** Summary of dropped content (if summarization enabled) */
    summary?: string;
}
/**
 * Estimate total tokens for an array of messages.
 */
export declare function estimateTotalTokens(messages: LLMMessage[], overheadTokens?: number): number;
export declare class ContextWindowManager {
    private config;
    constructor(config?: Partial<ContextWindowConfig>);
    getConfig(): ContextWindowConfig;
    updateConfig(config: Partial<ContextWindowConfig>): void;
    /**
     * Apply context window management to a message array.
     * Returns the trimmed messages plus metadata about what was done.
     */
    apply(messages: LLMMessage[], currentTokens?: TokenUsage): {
        messages: LLMMessage[];
        action: WindowAction;
    };
    /**
     * Generate a simple summary of dropped messages.
     * Extracts tool call names, error patterns, and key content fragments.
     */
    private summarizeDroppedMessages;
    /**
     * Estimate how many more tokens can fit in the context window.
     */
    remainingCapacity(messages: LLMMessage[], maxContextOverride?: number): number;
    /**
     * Check if the context window needs trimming.
     */
    needsTrimming(messages: LLMMessage[]): boolean;
}
//# sourceMappingURL=contextWindow.d.ts.map