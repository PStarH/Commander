/**
 * Semantic Compaction Layer 3 — LLM-based tool output compression.
 *
 * Research: AutoCompressor (Google, 2023) and LLMLingua (Microsoft, 2023)
 * demonstrate that LLM-based summarization preserves 95% of information
 * while reducing tokens by 60-80%. Cost tradeoff: compression costs
 * ~200-500 tokens but saves 2000-8000 tokens (8-16x ROI).
 *
 * This module provides per-tool-output semantic compaction — before tool
 * results enter the conversation context, large outputs are compressed
 * using a lightweight LLM call. Unlike the context compactor's layer3
 * (which collapses entire turns), this compacts individual tool outputs
 * at the point of insertion, preventing context bloat from the start.
 *
 * Wire-in point: agentRuntime.ts tool loop, before request.messages.push.
 */

import type { LLMProvider } from './types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface SemanticCompactionConfig {
  /** Enable semantic compaction (default: true) */
  enabled: boolean;
  /** Minimum output length in chars to trigger compaction (default: 2000) */
  minOutputChars: number;
  /** Maximum summary tokens to request from the LLM (default: 300) */
  maxSummaryTokens: number;
  /** Skip compaction when budget remaining is below this (default: 5000) */
  minBudgetForCompaction: number;
  /** Tools to NEVER compact (keep full output), e.g., 'git' for commit hashes */
  excludeTools: string[];
  /** When non-empty, restricts compaction to only these tools (whitelist mode) */
  includeTools: string[];
}

export interface CompactionResult {
  /** The compacted output (or original if compaction was skipped) */
  content: string;
  /** Whether compaction was attempted */
  compacted: boolean;
  /** Original character count */
  originalChars: number;
  /** Compacted character count */
  compactedChars: number;
  /** Estimated token savings */
  tokensSaved: number;
  /** Tokens used by the compaction LLM call itself */
  compactionTokensUsed: number;
  /** Duration in ms */
  durationMs: number;
}

const DEFAULT_CONFIG: SemanticCompactionConfig = {
  enabled: true,
  minOutputChars: 2000,
  maxSummaryTokens: 300,
  minBudgetForCompaction: 5000,
  excludeTools: ['git', 'memory_store', 'memory_recall', 'memory_list'],
  includeTools: [],
};

// ============================================================================
// Prompt templates by tool type
// ============================================================================

const SUMMARIZE_PROMPTS: Record<string, string> = {
  file_read:
    'Summarize this file content preserving: function/class signatures, key constants, imports, and the overall structure. Drop implementation details when the signature is self-explanatory.',
  code_search:
    'Summarize these search results preserving: file paths, line numbers, match snippets, and the count of results. Drop redundant or near-identical results.',
  web_search:
    'Summarize these web search results preserving: titles, URLs, key facts, and dates. Drop boilerplate and ads.',
  web_fetch:
    'Summarize this web page content preserving: main points, key data, and relevant links. Drop navigation, ads, and boilerplate.',
  shell_execute:
    'Summarize this command output preserving: exit code, key results, file paths, and error lines. Drop verbose logs and progress bars.',
  python_execute:
    'Summarize this Python output preserving: return value, printed output, errors, and key data structures.',
  file_list:
    'Summarize this directory listing preserving: directory structure, file counts, and notable file names. Group similar files.',
  file_search:
    'Summarize these file search results preserving: file paths, match counts, and the most relevant matches.',
  default:
    'Summarize this tool output concisely, preserving all factual information, key values, error messages, and results. Drop verbose formatting, repeated text, and boilerplate.',
};

// ============================================================================
// Semantic Tool Compactor
// ============================================================================

export class SemanticToolCompactor {
  private config: SemanticCompactionConfig;

  constructor(config?: Partial<SemanticCompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): SemanticCompactionConfig {
    return { ...this.config };
  }

  /**
   * Check whether this tool output should be compacted.
   */
  shouldCompact(content: string, toolName: string, budgetRemaining?: number): boolean {
    if (!this.config.enabled) return false;
    if (content.length < this.config.minOutputChars) return false;
    if (this.config.excludeTools.includes(toolName)) return false;
    if (this.config.includeTools.length > 0 && !this.config.includeTools.includes(toolName))
      return false;
    if (budgetRemaining !== undefined && budgetRemaining < this.config.minBudgetForCompaction)
      return false;
    return true;
  }

  /**
   * Compact a tool output using LLM summarization.
   * Falls back to original content if the LLM call fails or times out.
   *
   * @returns CompactionResult with the (possibly compacted) content and metrics
   */
  async compact(
    content: string,
    toolName: string,
    provider: LLMProvider,
    budgetRemaining?: number,
  ): Promise<CompactionResult> {
    const startMs = Date.now();

    if (!this.shouldCompact(content, toolName, budgetRemaining)) {
      return {
        content,
        compacted: false,
        originalChars: content.length,
        compactedChars: content.length,
        tokensSaved: 0,
        compactionTokensUsed: 0,
        durationMs: 0,
      };
    }

    // Truncate input to avoid sending massive content to the LLM
    // Cap at 10x max summary tokens (~3000 tokens ≈ 12000 chars)
    const maxInputChars = this.config.maxSummaryTokens * 40;
    const inputContent =
      content.length > maxInputChars
        ? content.slice(0, maxInputChars) +
          `\n...[truncated: ${content.length - maxInputChars} more chars]`
        : content;

    const prompt = SUMMARIZE_PROMPTS[toolName] ?? SUMMARIZE_PROMPTS.default;

    try {
      const response = await provider.call({
        model: '',
        messages: [
          {
            role: 'system' as const,
            content: `You are a tool output summarizer. ${prompt}`,
          },
          {
            role: 'user' as const,
            content: `Summarize this ${toolName} output in ${this.config.maxSummaryTokens} tokens or less:\n\n${inputContent}`,
          },
        ],
        maxTokens: this.config.maxSummaryTokens,
        temperature: 0,
      });

      if (response && response.content && response.content.length > 0) {
        const result: CompactionResult = {
          content: `[Compacted ${toolName} output: ${response.content}]`,
          compacted: true,
          originalChars: content.length,
          compactedChars: response.content.length,
          tokensSaved: Math.max(0, Math.ceil((content.length - response.content.length) / 4)),
          compactionTokensUsed: response.usage?.totalTokens ?? 0,
          durationMs: Date.now() - startMs,
        };
        return result;
      }
    } catch (err) {
      getGlobalLogger().debug(
        'SemanticToolCompactor',
        'LLM compaction failed, falling back to original',
        {
          toolName,
          error: (err as Error).message?.slice(0, 200),
        },
      );
    }

    // Fallback: return original content
    return {
      content,
      compacted: false,
      originalChars: content.length,
      compactedChars: content.length,
      tokensSaved: 0,
      compactionTokensUsed: 0,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Estimate token savings if we were to compact this output.
   * Used for pre-compaction decisions.
   */
  estimateSavings(content: string): { charsSaved: number; estimatedTokensSaved: number } {
    const estimatedCompressedLength = Math.min(
      this.config.maxSummaryTokens * 4,
      Math.ceil(content.length * 0.3),
    );
    return {
      charsSaved: content.length - estimatedCompressedLength,
      estimatedTokensSaved: Math.max(
        0,
        Math.ceil((content.length - estimatedCompressedLength) / 4),
      ),
    };
  }
}
