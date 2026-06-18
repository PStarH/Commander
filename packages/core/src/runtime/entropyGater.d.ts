/**
 * Entropy-based Tool Gating
 *
 * Research finding (arXiv 2602.02050): High-quality tool calls reduce model
 * entropy. By detecting when the model is already confident (low entropy),
 * we can skip unnecessary tool calls, achieving 72% reduction in tool calls.
 *
 * The gater analyzes LLM responses for "confidence signals":
 * - Response is self-contained (not asking for more info)
 * - Response contains definitive statements (no hedging)
 * - Model chose NOT to call tools despite having them available
 *
 * These signals indicate the model is confident enough to answer directly.
 */
/**
 * Signals that the model is confident and tools may be unnecessary.
 * Returns true when the response suggests the model can answer directly.
 */
export declare function isConfidentResponse(response: {
    content: string;
    toolCalls?: Array<{
        name: string;
    }>;
    finishReason?: string;
}): boolean;
/**
 * Estimate if a set of tool calls is worth executing, or if the
 * information gain would be low. Based on tool type and past results.
 */
export declare function hasInformationGain(toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
}>, recentResults: Array<{
    name: string;
    output: string;
    error?: string;
}>): boolean;
//# sourceMappingURL=entropyGater.d.ts.map