/**
 * Context Compactor — 4-layer progressive compaction with semantic awareness.
 *
 * Upgraded from Claude Code's approach with:
 * 1. CJK-aware token estimation (TokenGovernor.estimateTokens)
 * 2. Governor-integrated thresholds (tighter under budget pressure)
 * 3. Double-compaction prevention (mark summarized messages)
 * 4. Token-aware retention in layer4 (keep by token budget, not message count)
 * 5. Semantic importance scoring for message preservation
 */

import type { LLMMessage, LLMProvider } from './types';
import { TokenGovernor, getTokenGovernor } from './tokenGovernor';

// ============================================================================
// Types
// ============================================================================

export type CompactLayer = 1 | 2 | 3 | 4;

export interface CompactConfig {
  maxContextTokens: number;
  layer1Trigger: number;  // % full to trigger layer 1 (default: 0.60)
  layer2Trigger: number;  // % full to trigger layer 2 (default: 0.70)
  layer3Trigger: number;  // % full to trigger layer 3 (default: 0.82)
  layer4Trigger: number;  // % full to trigger layer 4 (default: 0.92)
  keepRecentTurns: number;  // turns to preserve in layers 1-3
  maxToolOutputChars: number;  // max chars per tool output after microcompact
  /** Enable governor-aware threshold adjustment (default: true) */
  governorAware: boolean;
}

const DEFAULT_CONFIG: CompactConfig = {
  maxContextTokens: 128000,
  layer1Trigger: 0.60,
  layer2Trigger: 0.70,
  layer3Trigger: 0.82,
  layer4Trigger: 0.92,
  keepRecentTurns: 3,
  maxToolOutputChars: 500,
  governorAware: true,
};

export interface CompactAction {
  layer: CompactLayer;
  droppedCount: number;
  tokensSaved: number;
  summary?: string;
  description: string;
}

// ============================================================================
// Compaction marker — prevents double-compaction
// ============================================================================

const COMPACTED_MARKER = '__COMPACTED__';

function isCompacted(msg: LLMMessage): boolean {
  return typeof msg.content === 'string' && msg.content.startsWith(COMPACTED_MARKER);
}

function markCompacted(content: string): string {
  return `${COMPACTED_MARKER}${content}`;
}

// ============================================================================
// Token estimation — CJK-aware via TokenGovernor
// ============================================================================

function estimateTokens(text: string): number {
  return TokenGovernor.estimateTokens(text);
}

function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 10; // 10 tokens overhead per message
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
      }
    }
    if (msg.reasoning_content) {
      total += estimateTokens(msg.reasoning_content);
    }
  }
  return total;
}

// ============================================================================
// Importance scoring — rank messages by semantic value
// ============================================================================

interface ScoredMessage {
  msg: LLMMessage;
  index: number;
  importance: number; // 0-1
}

function scoreMessageImportance(msg: LLMMessage, index: number, total: number): number {
  let score = 0.5; // baseline

  // System messages are always important
  if (msg.role === 'system') return 1.0;

  // User messages with goals/questions are important
  if (msg.role === 'user') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (content.length > 20) score += 0.2;
    // Questions and instructions
    if (/\?|please|do|write|create|fix|implement|analyze/i.test(content)) score += 0.1;
  }

  // Assistant messages with decisions are important
  if (msg.role === 'assistant') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    // Decision patterns
    if (/I will|I'll|going to|plan to|the answer|in conclusion|therefore/i.test(content)) {
      score += 0.3;
    }
    // Tool calls are somewhat important (they show what was done)
    if (msg.tool_calls && msg.tool_calls.length > 0) score += 0.1;
  }

  // Tool results with errors are very important
  if (msg.role === 'tool') {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (/error|fail|exception|cannot|unable/i.test(content)) {
      score += 0.4;
    }
  }

  // Recency bonus: more recent messages are more important
  const recencyFactor = index / Math.max(total - 1, 1);
  score += recencyFactor * 0.2;

  // Already-compacted messages get lower priority (don't double-compact)
  if (isCompacted(msg)) score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

// ============================================================================
// Context Compactor
// ============================================================================

export class ContextCompactor {
  private config: CompactConfig;

  constructor(config?: Partial<CompactConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getUsage(messages: LLMMessage[]): { total: number; pct: number } {
    const total = estimateMessagesTokens(messages);
    return { total, pct: total / this.config.maxContextTokens };
  }

  needsCompaction(messages: LLMMessage[]): CompactLayer | null {
    const { pct } = this.getUsage(messages);

    // Governor-aware: lower thresholds under pressure
    const adjusted = this.adjustThresholds();

    if (pct >= adjusted.layer4) return 4;
    if (pct >= adjusted.layer3) return 3;
    if (pct >= adjusted.layer2) return 2;
    if (pct >= adjusted.layer1) return 1;
    return null;
  }

  compact(messages: LLMMessage[], provider?: LLMProvider): { messages: LLMMessage[]; action: CompactAction } {
    const layer = this.needsCompaction(messages);
    if (!layer) {
      return { messages, action: { layer: 1, droppedCount: 0, tokensSaved: 0, description: 'No compaction needed' } };
    }
    switch (layer) {
      case 1: return this.layer1Snip(messages);
      case 2: return this.layer2Microcompact(messages);
      case 3: return this.layer3Collapse(messages, provider);
      case 4: return this.layer4Autocompact(messages, provider);
    }
  }

  // Layer 1: Remove oldest turn-pairs, keeping recent turns
  private layer1Snip(messages: LLMMessage[]): { messages: LLMMessage[]; action: CompactAction } {
    const system: LLMMessage[] = [];
    const pairs: LLMMessage[][] = [];
    let current: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') { system.push(msg); continue; }
      if (msg.role === 'user' && current.length > 0) {
        pairs.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) pairs.push(current);

    const keep = Math.max(1, this.config.keepRecentTurns);
    const dropped = Math.max(0, pairs.length - keep);
    const kept = pairs.slice(Math.max(0, pairs.length - keep));

    const before = estimateMessagesTokens(messages);
    const result = [...system, ...kept.flat()];
    const after = estimateMessagesTokens(result);

    return {
      messages: result,
      action: { layer: 1, droppedCount: dropped, tokensSaved: before - after, description: `Layer 1 snip: removed ${dropped} oldest turn(s)` },
    };
  }

  // Layer 2: Trim verbose tool outputs with intelligent preservation
  private layer2Microcompact(messages: LLMMessage[]): { messages: LLMMessage[]; action: CompactAction } {
    const before = estimateMessagesTokens(messages);
    let trimmedCount = 0;

    const result = messages.map(msg => {
      if (msg.role === 'tool' && msg.content.length > this.config.maxToolOutputChars) {
        trimmedCount++;
        const truncated = this.intelligentTruncate(msg.content, this.config.maxToolOutputChars);
        return { ...msg, content: truncated };
      }
      return msg;
    });

    const after = estimateMessagesTokens(result);
    return {
      messages: result,
      action: { layer: 2, droppedCount: trimmedCount, tokensSaved: before - after, description: `Layer 2 microcompact: trimmed ${trimmedCount} tool outputs` },
    };
  }

  // Layer 3: Collapse middle turns into structured summary, preserving important messages
  private layer3Collapse(messages: LLMMessage[], provider?: LLMProvider): { messages: LLMMessage[]; action: CompactAction } {
    const system: LLMMessage[] = [];
    const turns: LLMMessage[][] = [];
    let current: LLMMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') { system.push(msg); continue; }
      if (msg.role === 'user' && current.length > 0) {
        turns.push(current);
        current = [msg];
      } else {
        current.push(msg);
      }
    }
    if (current.length > 0) turns.push(current);

    const keep = Math.max(1, this.config.keepRecentTurns);
    if (turns.length <= keep + 1) {
      return { messages, action: { layer: 3, droppedCount: 0, tokensSaved: 0, description: 'Layer 3 collapse: not enough turns' } };
    }

    const collapseTargets = turns.slice(0, turns.length - keep);
    const recent = turns.slice(turns.length - keep);

    // Extract important messages from collapse targets (don't lose critical info)
    const importantMessages = this.extractImportantMessages(collapseTargets);

    const summary = this.buildStructuredSummary(collapseTargets, provider);
    const summaryMsg: LLMMessage = {
      role: 'system',
      content: markCompacted(`[Compacted summary of ${collapseTargets.length} earlier turns:\n${summary}]`),
    };

    const before = estimateMessagesTokens(messages);
    const result = [...system, summaryMsg, ...importantMessages, ...recent.flat()];
    const after = estimateMessagesTokens(result);

    return {
      messages: result,
      action: { layer: 3, droppedCount: collapseTargets.length, tokensSaved: before - after, summary, description: `Layer 3 collapse: compressed ${collapseTargets.length} turns into summary` },
    };
  }

  // Layer 4: Emergency — keep by token budget, not message count
  private layer4Autocompact(messages: LLMMessage[], provider?: LLMProvider): { messages: LLMMessage[]; action: CompactAction } {
    const system: LLMMessage[] = messages.filter(m => m.role === 'system');
    const nonSystem: LLMMessage[] = messages.filter(m => m.role !== 'system');

    // Token-aware retention: keep messages that fit within 20% of budget
    const retentionBudget = Math.floor(this.config.maxContextTokens * 0.20);
    const kept: LLMMessage[] = [];
    let usedTokens = 0;

    // Keep from the end (most recent first)
    for (let i = nonSystem.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(nonSystem[i].content) + 10;
      if (usedTokens + msgTokens > retentionBudget) break;
      kept.unshift(nonSystem[i]);
      usedTokens += msgTokens;
    }

    const summary = this.buildStructuredSummary([nonSystem], provider);
    const summaryMsg: LLMMessage = {
      role: 'system',
      content: markCompacted(`[Emergency compact: full conversation summary\n${summary}]`),
    };

    const before = estimateMessagesTokens(messages);
    const result = [...system, summaryMsg, ...kept];
    const after = estimateMessagesTokens(result);

    return {
      messages: result,
      action: { layer: 4, droppedCount: nonSystem.length - kept.length, tokensSaved: before - after, summary, description: `Layer 4 autocompact: emergency, kept ${kept.length} messages by token budget` },
    };
  }

  /**
   * Extract important messages from collapse targets.
   * These are preserved alongside the summary to prevent information loss.
   */
  private extractImportantMessages(turns: LLMMessage[][]): LLMMessage[] {
    const allMsgs = turns.flat();
    const scored: ScoredMessage[] = allMsgs.map((msg, i) => ({
      msg,
      index: i,
      importance: scoreMessageImportance(msg, i, allMsgs.length),
    }));

    // Keep messages with importance > 0.7 (errors, decisions, user instructions)
    // Cap at 5 messages to avoid blowing the budget
    return scored
      .filter(s => s.importance > 0.7 && !isCompacted(s.msg))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 5)
      .map(s => s.msg);
  }

  /**
   * Governor-aware threshold adjustment.
   * Under budget pressure, trigger compaction earlier.
   */
  private adjustThresholds(): { layer1: number; layer2: number; layer3: number; layer4: number } {
    if (!this.config.governorAware) {
      return {
        layer1: this.config.layer1Trigger,
        layer2: this.config.layer2Trigger,
        layer3: this.config.layer3Trigger,
        layer4: this.config.layer4Trigger,
      };
    }

    try {
      const governor = getTokenGovernor();
      const phase = governor.getState().phase;

      // Under pressure, lower thresholds to compact earlier
      const shift = phase === 'critical' ? 0.15 : phase === 'tight' ? 0.10 : phase === 'moderate' ? 0.05 : 0;

      return {
        layer1: Math.max(0.3, this.config.layer1Trigger - shift),
        layer2: Math.max(0.4, this.config.layer2Trigger - shift),
        layer3: Math.max(0.55, this.config.layer3Trigger - shift),
        layer4: Math.max(0.7, this.config.layer4Trigger - shift),
      };
    } catch {
      return {
        layer1: this.config.layer1Trigger,
        layer2: this.config.layer2Trigger,
        layer3: this.config.layer3Trigger,
        layer4: this.config.layer4Trigger,
      };
    }
  }

  private buildStructuredSummary(turns: LLMMessage[][], _provider?: LLMProvider): string {
    const toolCalls = new Set<string>();
    const errors: string[] = [];
    const decisions: string[] = [];
    const files: string[] = [];
    const keyFindings: string[] = [];
    let userGoals = '';

    for (const turn of turns) {
      for (const msg of turn) {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (text.length > 20 && text.length < 500) userGoals = text.slice(0, 200);
        }
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            toolCalls.add(tc.function.name);
            try {
              const args = JSON.parse(tc.function.arguments);
              if (args.path) files.push(args.path);
              if (args.file_path) files.push(args.file_path);
            } catch {}
          }
        }
        if (msg.role === 'tool') {
          const c = typeof msg.content === 'string' ? msg.content : '';
          if (c.startsWith('error:') || c.startsWith('tool_error') || c.startsWith('ERROR')) {
            errors.push(c.split('\n')[0].slice(0, 120));
          } else {
            const lines = c.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.length > 20 && trimmed.length < 150) {
                if (/\d/.test(trimmed) || /result|found|output|answer|total|sum|count/i.test(trimmed)) {
                  keyFindings.push(trimmed.slice(0, 100));
                  break;
                }
              }
            }
            if (keyFindings.length === 0) {
              const first = lines.find(l => l.trim().length > 20);
              if (first) keyFindings.push(first.trim().slice(0, 100));
            }
          }
        }
        if (msg.role === 'assistant' && !msg.tool_calls) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          const decisionPatterns = [
            /(?:^|\n)(?:I will|Let me|Going to|Plan to|Need to|I'll|I'm going to) .{10,100}/i,
            /(?:The answer is|The result is|In conclusion|Therefore|Thus|So)[,:]? .{10,100}/i,
            /(?:Found|Discovered|Confirmed|Determined|Calculated) that .{10,100}/i,
            /(?:This means|This suggests|This indicates) .{10,100}/i,
            /(?:The (?:total|sum|count|average|final)) .{10,80}/i,
            /(?:^|\n)\d+[\.\)]\s+.{10,80}/m,
          ];
          for (const pattern of decisionPatterns) {
            const match = text.match(pattern);
            if (match) {
              decisions.push(match[0].replace(/\n/g, ' ').trim().slice(0, 120));
              if (decisions.length >= 3) break;
            }
          }
        }
      }
    }

    const parts: string[] = ['## Progress'];
    if (userGoals) parts.push(`Goal: ${userGoals}`);
    if (toolCalls.size > 0) parts.push(`Tools: ${[...toolCalls].join(', ')}`);
    if (files.length > 0) parts.push(`Files: ${[...new Set(files)].slice(0, 8).join(', ')}`);
    if (decisions.length > 0) parts.push(`\n## Key Decisions\n${decisions.slice(0, 5).join('\n')}`);
    if (keyFindings.length > 0) parts.push(`\n## Findings\n${keyFindings.slice(0, 3).join('\n')}`);
    if (errors.length > 0) parts.push(`\n## Issues\n${errors.slice(0, 3).join('\n')}`);

    return parts.join('\n') || `${turns.length} turn(s) compacted`;
  }

  /**
   * Intelligent truncation: preserve error lines, key-value pairs, and structural elements.
   */
  private intelligentTruncate(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;

    const lines = content.split('\n');
    const lineCount = lines.length;
    const important: string[] = [];
    const rest: string[] = [];

    for (let i = 0; i < lineCount; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (/^(error|warning|fail|exception|traceback|cannot|unable)/i.test(trimmed)) {
        important.push(line);
      } else if (/^["']?\w+["']?\s*[:=]/.test(trimmed) && trimmed.length < 120) {
        important.push(line);
      } else if (i < 2 || i > lineCount - 3) {
        important.push(line);
      } else {
        rest.push(line);
      }
    }

    let result = important.join('\n');
    if (result.length < maxChars * 0.6) {
      for (const line of rest) {
        if (result.length + line.length + 1 > maxChars - 50) break;
        result += '\n' + line;
      }
    }

    if (result.length > maxChars) {
      result = result.slice(0, maxChars);
    }

    return `${result}\n...[+${content.length - result.length} more chars]`;
  }
}
