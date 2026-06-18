/**
 * Context Compactor — 4-layer progressive compaction with semantic awareness.
 *
 * Upgraded from Claude Code's approach with:
 * 1. CJK-aware token estimation (TokenGovernor.estimateTokens)
 * 2. Governor-integrated thresholds (tighter under budget pressure)
 * 3. Double-compaction prevention (mark summarized messages)
 * 4. Token-aware retention in layer4 (keep by token budget, not message count)
 * 5. Semantic importance scoring for message preservation
 * 6. Adaptive compaction: task-type-aware profiles + message composition analysis
 *
 * Adaptive compaction adjusts trigger thresholds, retention, and summary verbosity
 * per task type (code, search, analysis, structured, general) plus automatic
 * adjustment based on message composition (tool density, error density, code blocks).
 */
import type { LLMMessage, LLMProvider } from './types';
import { CPUWorkerPool } from './cpuWorkerPool';
export interface FailureCorrelationRecord {
    runId: string;
    timestamp: number;
    failureSignal?: string;
    messageFingerprints: Set<string>;
}
export declare class FailureCorrelationTracker {
    private records;
    private globalFingerprints;
    private readonly maxRecords;
    private fingerprint;
    record(runId: string, messages: LLMMessage[], failureSignal?: string): void;
    isCorrelated(msg: LLMMessage): boolean;
    getRunRecord(runId: string): FailureCorrelationRecord | undefined;
    reset(): void;
}
export type CompactLayer = 1 | 2 | 3 | 4 | 5;
export type CompactTaskType = 'code' | 'search' | 'analysis' | 'structured' | 'general';
export type CollapseVerbosity = 'detail' | 'balanced' | 'aggressive';
export interface CompactConfig {
    maxContextTokens: number;
    layer1Trigger: number;
    layer2Trigger: number;
    layer3Trigger: number;
    layer4Trigger: number;
    keepRecentTurns: number;
    maxToolOutputChars: number;
    /** Enable governor-aware threshold adjustment (default: true) */
    governorAware: boolean;
}
export interface CompactAction {
    layer: CompactLayer;
    droppedCount: number;
    tokensSaved: number;
    summary?: string;
    description: string;
    taskTypeApplied?: CompactTaskType | null;
    compositionApplied?: {
        toolDensity: number;
        errorDensity: number;
    };
    /** For Layer 5: the rebuild result details */
    rebuildResult?: {
        sections: Array<{
            name: string;
            cap: number;
            used: number;
        }>;
        rebuildCount: number;
        totalTokens: number;
    };
}
export interface AdaptiveProfile {
    layerTriggers: {
        layer1: number;
        layer2: number;
        layer3: number;
        layer4: number;
    };
    keepRecentTurns: number;
    maxToolOutputChars: number;
    importanceConfig: {
        errorBonus: number;
        decisionBonus: number;
        userInstructionBonus: number;
        recencyBonus: number;
        compactedPenalty: number;
    };
    collapseVerbosity: CollapseVerbosity;
}
export interface CompositionScore {
    toolDensity: number;
    errorDensity: number;
    messageCount: number;
    codeBlockRatio: number;
}
export declare class ContextCompactor {
    private config;
    private failureTracker;
    /** Counts how many times compaction has been applied to current messages */
    private compactionCount;
    /** Tracks whether the last compaction was layer 4 (emergency) */
    private lastWasEmergency;
    constructor(config?: Partial<CompactConfig>, failureTracker?: FailureCorrelationTracker);
    /**
     * Record that the current messages correlated with a verification failure.
     * Future compactions will deprioritize these messages.
     */
    recordFailureCorrelation(runId: string, messages: LLMMessage[], failureSignal?: string): void;
    /** Access the failure tracker (for testing/inspection). */
    getFailureTracker(): FailureCorrelationTracker;
    getUsage(messages: LLMMessage[]): {
        total: number;
        pct: number;
    };
    needsCompaction(messages: LLMMessage[], taskType?: CompactTaskType): CompactLayer | null;
    /**
     * Check if rebuild (Layer 5) should be triggered for a given run.
     * Public for use by agentRuntime to decide whether to invoke rebuild.
     */
    needsRebuild(runId: string): boolean;
    compact(messages: LLMMessage[], provider?: LLMProvider, taskType?: CompactTaskType): {
        messages: LLMMessage[];
        action: CompactAction;
    };
    /**
     * Layer 5: Rebuild — completely reset the context window and reconstruct
     * from persistent state (checkpoint.md + ThreeLayerMemory).
     *
     * This is different from Layers 1-4: instead of compressing existing messages,
     * we DISCARD all history and build a fresh prompt from structured records.
     *
     * @returns The rebuilt messages and action metadata
     */
    rebuild(runId: string, goal: string, phase: string, stepNumber: number, systemPrompt: LLMMessage[], recentUserMessages: LLMMessage[], tokenUsage: {
        totalTokens: number;
        budgetHardCap: number;
    }): Promise<{
        messages: LLMMessage[];
        action: CompactAction;
    }>;
    /** Reset compaction tracking (e.g., after rebuild or new run). */
    resetCompactionTracking(): void;
    /** Get the current compaction count (for diagnostics). */
    getCompactionCount(): number;
    /**
     * Async compaction with LLM-based summarization for layer3/4.
     * Uses the LLM to summarize conversation turns when provider is available,
     * producing higher-quality compression than rule-based extraction.
     *
     * Evidence:
     * - AutoCompressor (Google, 2023): LLM summarization preserves 95% info, reduces tokens 60-80%
     * - LLMLingua (Microsoft, 2023): prompt compression reduces tokens 2-5x with <5% quality loss
     * - Cost tradeoff: summarization costs ~500-1000 tokens but saves 5000-20000 tokens (8-20x ROI)
     */
    compactAsync(messages: LLMMessage[], provider?: LLMProvider, taskType?: CompactTaskType): Promise<{
        messages: LLMMessage[];
        action: CompactAction;
    }>;
    /**
     * CPU-offloaded compaction for layer3/4 — delegates scoring + summary building to worker_threads.
     * Falls back to sync path if worker pool is unavailable or layer is 1/2 (fast enough on main thread).
     */
    compactWithWorkerOffload(messages: LLMMessage[], workerPool: CPUWorkerPool, provider?: LLMProvider, taskType?: CompactTaskType): Promise<{
        messages: LLMMessage[];
        action: CompactAction;
    }>;
    private layerWithWorkerOffload;
    private extractImportantMessagesWorker;
    private buildSummaryWorker;
    /**
     * Compute the effective adaptive profile given task type and messages.
     * Public for testing.
     */
    getEffectiveProfile(taskType?: CompactTaskType, messages?: LLMMessage[]): AdaptiveProfile;
    /** Public for testing */
    getCurrentTaskTypeProfile(taskType: CompactTaskType): AdaptiveProfile;
    /**
     * Analyze message composition. Public for testing.
     */
    analyzeComposition(messages: LLMMessage[]): CompositionScore;
    /**
     * Get provider-specific context window limit.
     * Research: Anthropic 200k, OpenAI 128k, Gemini 1M, smaller models 32k.
     * Uses provider.maxContextTokens if available, otherwise infers from model ID.
     */
    private getProviderContextLimit;
    private layer1Snip;
    private layer2Microcompact;
    private layer3CollapseAsync;
    private layer3Collapse;
    private layer4Autocompact;
    /**
     * Extract important messages from collapse targets.
     * These are preserved alongside the summary to prevent information loss.
     */
    private extractImportantMessages;
    private selectTopKByCost;
    private bubbleUp;
    private bubbleDown;
    private adjustThresholds;
    private buildStructuredSummary;
    /**
     * Intelligent truncation: preserve error lines, key-value pairs, and structural elements.
     */
    private intelligentTruncate;
    private truncateSmall;
    private truncateLarge;
    private countNewlinesFast;
    /**
     * LLM-based prompt compression: use the LLM to summarize conversation turns.
     *
     * Evidence:
     * - AutoCompressor (Google, 2023): LLM-based summarization preserves 95% of information
     *   while reducing tokens by 60-80%
     * - LLMLingua (Microsoft, 2023): prompt compression via summarization reduces tokens by 2-5x
     *   with <5% quality loss on QA tasks
     * - Cost tradeoff: summarization costs ~500-1000 tokens but saves 5000-20000 tokens
     *   Net savings: 4000-19000 tokens per compression (8-20x ROI)
     *
     * @param turns - The conversation turns to summarize
     * @param provider - The LLM provider to use for summarization
     * @param maxSummaryTokens - Maximum tokens for the summary (default: 500)
     * @returns Summarized text, or null if summarization fails
     */
    llmSummarize(turns: LLMMessage[][], provider: LLMProvider, maxSummaryTokens?: number): Promise<string | null>;
}
//# sourceMappingURL=contextCompactor.d.ts.map