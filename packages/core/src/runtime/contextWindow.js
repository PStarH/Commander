"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextWindowManager = void 0;
exports.estimateTotalTokens = estimateTotalTokens;
const DEFAULT_CONFIG = {
    maxContextTokens: 128000,
    triggerThreshold: 0.75,
    keepRecentCount: 10,
    enableSummarization: false,
    messageOverheadTokens: 50,
};
/**
 * Estimate the token count of a message.
 * Uses CJK-aware estimation: CJK chars tokenize at ~1.5 tokens/char,
 * Latin chars at ~0.25 tokens/char (4 chars per token).
 */
function estimateMessageTokens(msg, overheadTokens) {
    const estimate = (text) => {
        var _a;
        const cjkCount = ((_a = text.match(/[一-鿿㐀-䶿]/g)) !== null && _a !== void 0 ? _a : []).length;
        return Math.ceil((text.length - cjkCount) / 4 + cjkCount / 1.5);
    };
    let total = estimate(msg.content);
    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            total += estimate(tc.function.name);
            total += estimate(tc.function.arguments);
        }
    }
    if (msg.reasoning_content) {
        total += estimate(msg.reasoning_content);
    }
    // Round up and add overhead
    return Math.ceil(total) + (overheadTokens !== null && overheadTokens !== void 0 ? overheadTokens : DEFAULT_CONFIG.messageOverheadTokens);
}
/**
 * Estimate total tokens for an array of messages.
 */
function estimateTotalTokens(messages, overheadTokens) {
    return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg, overheadTokens), 0);
}
class ContextWindowManager {
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    getConfig() {
        return { ...this.config };
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }
    /**
     * Apply context window management to a message array.
     * Returns the trimmed messages plus metadata about what was done.
     */
    apply(messages, currentTokens) {
        const estimatedTokens = currentTokens
            ? currentTokens.totalTokens
            : estimateTotalTokens(messages, this.config.messageOverheadTokens);
        const maxTokens = this.config.maxContextTokens;
        const thresholdTokens = Math.floor(maxTokens * this.config.triggerThreshold);
        // No action needed if below threshold
        if (estimatedTokens < thresholdTokens) {
            return {
                messages,
                action: { applied: false, droppedCount: 0, tokensSaved: 0 },
            };
        }
        // Find system messages — always keep them
        const systemMessages = [];
        const nonSystemMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                systemMessages.push(msg);
            }
            else {
                nonSystemMessages.push(msg);
            }
        }
        const keepCount = this.config.keepRecentCount;
        // If we have fewer non-system messages than keepRecentCount, no action
        if (nonSystemMessages.length <= keepCount) {
            return {
                messages,
                action: { applied: false, droppedCount: 0, tokensSaved: 0 },
            };
        }
        // Split non-system messages: older ones to drop, recent ones to keep
        const dropCount = nonSystemMessages.length - keepCount;
        const dropped = nonSystemMessages.slice(0, dropCount);
        const kept = nonSystemMessages.slice(dropCount);
        // Calculate tokens saved
        const tokensSaved = estimateTotalTokens(dropped, this.config.messageOverheadTokens);
        // Generate summary if enabled
        let summary;
        if (this.config.enableSummarization && dropped.length > 0) {
            summary = this.summarizeDroppedMessages(dropped);
            // Inject summary as a system message to preserve key context
            if (summary) {
                systemMessages.push({
                    role: 'system',
                    content: `[Context summary of earlier conversation (${dropped.length} messages dropped to fit context window):\n${summary}]`,
                });
            }
        }
        const result = [...systemMessages, ...kept];
        return {
            messages: result,
            action: {
                applied: true,
                droppedCount: dropCount,
                tokensSaved,
                summary,
            },
        };
    }
    /**
     * Generate a simple summary of dropped messages.
     * Extracts tool call names, error patterns, and key content fragments.
     */
    summarizeDroppedMessages(dropped) {
        var _a;
        const toolCalls = [];
        const errors = [];
        const keyFacts = [];
        for (const msg of dropped) {
            // Extract tool call info
            if (msg.role === 'assistant' && msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const name = (_a = tc.function) === null || _a === void 0 ? void 0 : _a.name;
                    if (name)
                        toolCalls.push(name);
                }
            }
            // Extract error patterns
            if (msg.role === 'tool') {
                const isError = msg.content.startsWith('error:') || msg.content.startsWith('tool_error');
                if (isError) {
                    const errLine = msg.content.split('\n')[0].slice(0, 100);
                    errors.push(errLine);
                }
            }
            // Extract first 80 chars of user/assistant responses as key facts
            if (msg.role === 'user' || (msg.role === 'assistant' && !msg.tool_calls)) {
                const snippet = msg.content.replace(/\n/g, ' ').trim().slice(0, 80);
                if (snippet.length > 20)
                    keyFacts.push(snippet);
            }
        }
        const parts = [];
        if (toolCalls.length > 0) {
            const unique = [...new Set(toolCalls)];
            parts.push(`Tools used: ${unique.join(', ')}.`);
        }
        if (errors.length > 0) {
            parts.push(`Errors encountered:\n${errors.join('\n')}`);
        }
        if (keyFacts.length > 0 && parts.length < 3) {
            parts.push(`Key points: ${keyFacts.slice(0, 5).join('; ')}`);
        }
        return parts.join('\n') || `${dropped.length} earlier messages (summarized)`;
    }
    /**
     * Estimate how many more tokens can fit in the context window.
     */
    remainingCapacity(messages, maxContextOverride) {
        const max = maxContextOverride !== null && maxContextOverride !== void 0 ? maxContextOverride : this.config.maxContextTokens;
        const used = estimateTotalTokens(messages, this.config.messageOverheadTokens);
        return Math.max(0, max - used);
    }
    /**
     * Check if the context window needs trimming.
     */
    needsTrimming(messages) {
        const estimated = estimateTotalTokens(messages, this.config.messageOverheadTokens);
        return estimated >= this.config.maxContextTokens * this.config.triggerThreshold;
    }
}
exports.ContextWindowManager = ContextWindowManager;
