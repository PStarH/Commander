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

import { reportSilentFailure } from '../silentFailureReporter';
import type { LLMMessage } from './types';
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

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

const DEFAULT_CONFIG: SlidingWindowConfig = {
  enabled: true,
  maxTurnsInWindow: 15,
  solidifyEveryNTurns: 5,
  contextRetrievalTopK: 3,
  injectRetrievedContext: true,
  retrievalImportanceThreshold: 0.4,
  maxMemoryEntryChars: 400,
  maxMemoryBlockChars: 2000,
};

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

// ============================================================================
// Token estimator (shared with ContextCompactor/ContextWindowManager)
// ============================================================================

function estimateTokenCount(text: string): number {
  const cjkCount = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  return Math.ceil((text.length - cjkCount) / 4 + cjkCount / 1.5);
}

function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokenCount(msg.content) + 10;
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokenCount(tc.function.name) + estimateTokenCount(tc.function.arguments);
      }
    }
    if (msg.reasoning_content) {
      total += estimateTokenCount(msg.reasoning_content);
    }
  }
  return total;
}

// ============================================================================
// Structured summary builder (lightweight, no LLM call)
// ============================================================================

function buildSolidifySummary(turns: LLMMessage[][]): string {
  const toolsUsed = new Set<string>();
  const errors: string[] = [];
  const keyActions: string[] = [];
  const filesTouched: string[] = [];
  let goalSnippet = '';

  for (const turn of turns) {
    for (const msg of turn) {
      if (msg.role === 'user' && !goalSnippet) {
        goalSnippet = msg.content
          .replace(/[\n\r]/g, ' ')
          .trim()
          .slice(0, 150);
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolsUsed.add(tc.function.name);
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) filesTouched.push(args.path);
            if (args.file_path) filesTouched.push(args.file_path);
          } catch (err) {
            reportSilentFailure(err, 'slidingWindowOrchestrator:141');
            /* skip unparseable args */
          }
        }
      }
      if (msg.role === 'tool') {
        const c = msg.content;
        if (c.startsWith('error:') || c.startsWith('tool_error') || c.startsWith('ERROR')) {
          const errLine = c.split('\n')[0].slice(0, 100);
          if (!errors.includes(errLine)) errors.push(errLine);
        }
        // Extract key findings from numeric output
        if (/\d+/.test(c) && c.length > 50 && c.length < 300) {
          keyActions.push(c.trim().slice(0, 120));
        }
      }
    }
  }

  const parts: string[] = [];
  if (goalSnippet) parts.push(`Goal fragment: ${goalSnippet}`);
  if (toolsUsed.size > 0) parts.push(`Tools: ${[...toolsUsed].slice(0, 10).join(', ')}`);
  if (filesTouched.length > 0)
    parts.push(`Files: ${[...new Set(filesTouched)].slice(0, 8).join(', ')}`);
  if (keyActions.length > 0) parts.push(`Key actions: ${keyActions.slice(0, 3).join(' | ')}`);
  if (errors.length > 0) parts.push(`Issues: ${errors.slice(0, 3).join(' | ')}`);

  return parts.length > 0 ? parts.join('\n') : `${turns.length} turn(s) completed`;
}

// ============================================================================
// Sliding Window Orchestrator
// ============================================================================

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
export class SlidingWindowOrchestrator {
  private config: SlidingWindowConfig;
  /** Turn counter for the current execution session */
  private turnCount = 0;
  /** Last turn index that was solidified */
  private lastSolidifyIndex = 0;
  /** Messages dropped from window (tracked for diagnostics) */
  private totalDroppedMessages = 0;
  private totalSolidifiedTurns = 0;

  constructor(config?: Partial<SlidingWindowConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): SlidingWindowConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<SlidingWindowConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Reset session counters (call at start of each execute()) */
  resetSession(): void {
    this.turnCount = 0;
    this.lastSolidifyIndex = 0;
    this.totalDroppedMessages = 0;
    this.totalSolidifiedTurns = 0;
  }

  getStats(): { turnCount: number; totalDropped: number; totalSolidified: number } {
    return {
      turnCount: this.turnCount,
      totalDropped: this.totalDroppedMessages,
      totalSolidified: this.totalSolidifiedTurns,
    };
  }

  /**
   * Check whether we should solidify completed turns to memory.
   */
  shouldSolidify(): boolean {
    if (!this.config.enabled) return false;
    const turnsSinceLastSolidify = this.turnCount - this.lastSolidifyIndex;
    return turnsSinceLastSolidify >= this.config.solidifyEveryNTurns;
  }

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
  async solidifyCompletedTurns(
    messages: LLMMessage[],
    memory: import('../threeLayerMemory').ThreeLayerMemory,
    goal: string,
    runId: string,
  ): Promise<SolidifyAction> {
    if (!this.config.enabled || !this.shouldSolidify()) {
      return { turnsSolidified: 0, entriesWritten: 0, tokensFreed: 0, summary: 'skipped' };
    }

    // Parse messages into turns (user → assistant+tool groups)
    const turns = this.parseTurns(messages);
    const totalTurns = turns.length;

    // We want to solidify turns that are before the window boundary.
    // The window boundary is maxTurnsInWindow from the end.
    const turnsToKeep = Math.max(1, this.config.maxTurnsInWindow);
    const solidifyTargetCount = Math.max(0, totalTurns - turnsToKeep);

    if (solidifyTargetCount === 0) {
      return {
        turnsSolidified: 0,
        entriesWritten: 0,
        tokensFreed: 0,
        summary: 'no turns outside window',
      };
    }

    // Only solidify turns that haven't been solidified yet.
    // We skip the last solidifyTargetCount turns (these stay in window).
    // But among the earlier turns, we only solidify those since lastSolidifyIndex.
    const solidifyStart = this.lastSolidifyIndex;
    const solidifyEnd = Math.max(0, totalTurns - turnsToKeep);

    if (solidifyEnd <= solidifyStart) {
      return {
        turnsSolidified: 0,
        entriesWritten: 0,
        tokensFreed: 0,
        summary: `already solidified up to ${solidifyStart}`,
      };
    }

    const solidifyTurns = turns.slice(solidifyStart, solidifyEnd);

    if (solidifyTurns.length === 0) {
      return {
        turnsSolidified: 0,
        entriesWritten: 0,
        tokensFreed: 0,
        summary: 'no new turns to solidify',
      };
    }

    // Build summary and extract tags
    const summary = buildSolidifySummary(solidifyTurns);
    const tags = this.inferTags(solidifyTurns, goal);
    const estimatedTokens = estimateMessagesTokens(solidifyTurns.flat());

    // Store as episodic memory
    try {
      memory.add(
        `[Session checkpoint] ${summary}`,
        'episodic',
        `run:${runId}|turns:${solidifyTurns.length}|tokens:${estimatedTokens}`,
        0.65 + Math.min(0.15, solidifyTurns.length * 0.02), // higher importance for more turns
        tags,
        {
          runId,
          turnsSolidified: solidifyTurns.length,
          estimatedTokens,
          turnRange: `${solidifyStart}-${solidifyEnd}`,
          goal: goal.slice(0, 500),
          source: 'sliding_window_solidify',
        },
      );
    } catch (e) {
      getGlobalLogger().warn('SlidingWindowOrchestrator', 'Failed to solidify turns to memory', {
        error: (e as Error)?.message,
        turnCount: solidifyTurns.length,
      });
      return {
        turnsSolidified: 0,
        entriesWritten: 0,
        tokensFreed: 0,
        summary: 'memory_write_failed',
      };
    }

    this.lastSolidifyIndex = solidifyEnd;
    this.totalSolidifiedTurns += solidifyTurns.length;

    getGlobalLogger().debug('SlidingWindowOrchestrator', 'Solidified turns to episodic memory', {
      count: solidifyTurns.length,
      tokens: estimatedTokens,
      tags,
    });

    return {
      turnsSolidified: solidifyTurns.length,
      entriesWritten: 1,
      tokensFreed: estimatedTokens,
      summary,
    };
  }

  /**
   * Apply sliding window to messages array.
   *
   * Drops the oldest turns that fall outside maxTurnsInWindow,
   * injecting a compact memory-reference placeholder for context continuity.
   *
   * @param messages - Current message array (will be modified in place)
   * @returns WindowAction with stats
   */
  applyWindow(messages: LLMMessage[]): WindowAction {
    if (!this.config.enabled) {
      return { applied: false, turnsDropped: 0, messagesDropped: 0, tokensFreed: 0 };
    }

    const turns = this.parseTurns(messages);
    const totalTurns = turns.length;
    const maxTurns = this.config.maxTurnsInWindow;

    if (totalTurns <= maxTurns) {
      return { applied: false, turnsDropped: 0, messagesDropped: 0, tokensFreed: 0 };
    }

    const turnsToKeep = maxTurns;
    const turnsToDrop = turns.slice(0, totalTurns - turnsToKeep);
    const turnsRetained = turns.slice(totalTurns - turnsToKeep);

    // Calculate how many messages we're dropping
    const droppedMessages = turnsToDrop.flat();
    const tokensFreed = estimateMessagesTokens(droppedMessages);

    // Build the new message array: system messages + kept messages
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const keptMessages = turnsRetained.flat();

    // Clear and rebuild messages
    messages.length = 0;
    messages.push(...systemMsgs, ...keptMessages);

    this.totalDroppedMessages += droppedMessages.length;

    getGlobalLogger().debug('SlidingWindowOrchestrator', 'Applied sliding window', {
      totalTurns,
      droppedTurns: turnsToDrop.length,
      droppedMessages: droppedMessages.length,
      tokensFreed,
      retainedTurns: turnsRetained.length,
    });

    return {
      applied: true,
      turnsDropped: turnsToDrop.length,
      messagesDropped: droppedMessages.length,
      tokensFreed,
    };
  }

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
  retrieveContext(
    memory: import('../threeLayerMemory').ThreeLayerMemory,
    goal: string,
    messages: LLMMessage[],
  ): RetrievalAction {
    if (!this.config.enabled || !this.config.injectRetrievedContext) {
      return { entriesRetrieved: 0, injectedContext: '', injectedTokens: 0 };
    }

    // Extract keywords from goal + recent tool calls
    const goalKeywords = goal
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 6);

    // Also extract recent tool names for context relevance
    const recentTools = this.extractRecentToolNames(messages, 5);
    const allKeywords = [...new Set([...goalKeywords, ...recentTools])];

    if (allKeywords.length === 0) {
      return { entriesRetrieved: 0, injectedContext: '', injectedTokens: 0 };
    }

    try {
      const memories = memory.searchRelated(
        allKeywords.join(' '),
        this.config.contextRetrievalTopK * 2,
      );

      if (memories.length === 0) {
        return { entriesRetrieved: 0, injectedContext: '', injectedTokens: 0 };
      }

      // Filter by importance and recency, take top K
      const filtered = memories
        .filter((m) => m.importance >= this.config.retrievalImportanceThreshold)
        .slice(0, this.config.contextRetrievalTopK);

      if (filtered.length === 0) {
        return { entriesRetrieved: 0, injectedContext: '', injectedTokens: 0 };
      }

      // Build formatted context block
      const parts: string[] = [];
      let totalChars = 0; // Track chars instead of tokens for simplicity

      for (const mem of filtered) {
        if (totalChars >= this.config.maxMemoryBlockChars) break;

        const content = mem.content.slice(0, this.config.maxMemoryEntryChars);
        const entry = `[${mem.layer}] ${content} (tags: ${mem.tags.slice(0, 4).join(', ')})`;
        const entryChars = entry.length + 1;

        if (totalChars + entryChars > this.config.maxMemoryBlockChars) break;

        parts.push(entry);
        totalChars += entryChars;
      }

      if (parts.length === 0) {
        return { entriesRetrieved: 0, injectedContext: '', injectedTokens: 0 };
      }

      const injectedContext = `## Retrieved Context\n${parts.join('\n')}\n\nConsider these past experiences when continuing the current task.`;
      const injectedTokens = estimateTokenCount(injectedContext);

      return {
        entriesRetrieved: filtered.length,
        injectedContext,
        injectedTokens,
      };
    } catch (e) {
      getGlobalLogger().debug('SlidingWindowOrchestrator', 'Failed to retrieve memory context', {
        error: (e as Error)?.message,
      });
      return { entriesRetrieved: 0, injectedContext: '', injectedTokens: 0 };
    }
  }

  /** Increment turn counter (call at each tool loop iteration) */
  incrementTurn(): void {
    this.turnCount++;
  }

  /**
   * Parse messages into turns — groups user+assistant+tool messages into turns.
   * A turn starts with a user message or the first non-system message.
   */
  private parseTurns(messages: LLMMessage[]): LLMMessage[][] {
    const turns: LLMMessage[][] = [];
    let current: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue; // system messages are always kept separate

      // A new turn starts with a user message or a standalone assistant message
      if (msg.role === 'user' && current.length > 0) {
        turns.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) turns.push(current);

    return turns;
  }

  /** Extract recent tool names from the last N messages */
  private extractRecentToolNames(messages: LLMMessage[], recentCount: number): string[] {
    const toolNames = new Set<string>();
    let count = 0;

    for (let i = messages.length - 1; i >= 0 && count < recentCount; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolNames.add(tc.function.name);
        }
        count++;
      }
    }

    return [...toolNames].filter((n) => n.length > 2);
  }

  /** Infer tags from turns and goal for memory storage */
  private inferTags(turns: LLMMessage[][], goal: string): string[] {
    const tags = new Set<string>();
    tags.add('session_checkpoint');

    // Add goal keywords as tags
    const words = goal
      .split(/\s+/)
      .filter((w) => w.length > 4)
      .slice(0, 5);
    for (const w of words) tags.add(w);

    // Add tool names as tags
    for (const turn of turns) {
      for (const msg of turn) {
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            tags.add(tc.function.name);
          }
        }
      }
    }

    return [...tags].slice(0, 15);
  }
}
