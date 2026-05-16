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

const DEFAULT_CONFIG: ContextWindowConfig = {
  maxContextTokens: 128000,
  triggerThreshold: 0.75,
  keepRecentCount: 10,
  enableSummarization: false,
  messageOverheadTokens: 50,
};

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
 * Roughly estimate the token count of a message.
 * Uses character count / 4 as a heuristic (4 chars ≈ 1 token for most models).
 */
function estimateMessageTokens(msg: LLMMessage): number {
  let total = msg.content.length / 4;
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += tc.function.name.length / 4;
      total += tc.function.arguments.length / 4;
    }
  }
  if (msg.reasoning_content) {
    total += msg.reasoning_content.length / 4;
  }
  // Round up and add overhead
  return Math.ceil(total) + DEFAULT_CONFIG.messageOverheadTokens;
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateTotalTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export class ContextWindowManager {
  private config: ContextWindowConfig;

  constructor(config?: Partial<ContextWindowConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): ContextWindowConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<ContextWindowConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Apply context window management to a message array.
   * Returns the trimmed messages plus metadata about what was done.
   */
  apply(
    messages: LLMMessage[],
    currentTokens?: TokenUsage,
  ): { messages: LLMMessage[]; action: WindowAction } {
    const estimatedTokens = currentTokens
      ? currentTokens.totalTokens
      : estimateTotalTokens(messages);

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
    const systemMessages: LLMMessage[] = [];
    const nonSystemMessages: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
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
    const tokensSaved = estimateTotalTokens(dropped);

    // Generate summary if enabled
    let summary: string | undefined;
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
  private summarizeDroppedMessages(dropped: LLMMessage[]): string {
    const toolCalls: string[] = [];
    const errors: string[] = [];
    const keyFacts: string[] = [];

    for (const msg of dropped) {
      // Extract tool call info
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name;
          if (name) toolCalls.push(name);
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
        if (snippet.length > 20) keyFacts.push(snippet);
      }
    }

    const parts: string[] = [];
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
  remainingCapacity(messages: LLMMessage[], maxContextOverride?: number): number {
    const max = maxContextOverride ?? this.config.maxContextTokens;
    const used = estimateTotalTokens(messages);
    return Math.max(0, max - used);
  }

  /**
   * Check if the context window needs trimming.
   */
  needsTrimming(messages: LLMMessage[]): boolean {
    const estimated = estimateTotalTokens(messages);
    return estimated >= this.config.maxContextTokens * this.config.triggerThreshold;
  }
}