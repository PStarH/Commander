import type { LLMMessage, LLMProvider } from './types';
import { estimateTotalTokens } from './contextWindow';

// 4-layer compaction inspired by Claude Code's pipeline:
// Layer 1: Snip — remove oldest non-essential tool results
// Layer 2: Microcompact — trim individual verbose outputs
// Layer 3: Collapse — replace middle turns with summary
// Layer 4: Autocompact — full conversation summarization

export type CompactLayer = 1 | 2 | 3 | 4;

export interface CompactConfig {
  maxContextTokens: number;
  layer1Trigger: number;  // % full to trigger layer 1 (default: 0.60)
  layer2Trigger: number;  // % full to trigger layer 2 (default: 0.70)
  layer3Trigger: number;  // % full to trigger layer 3 (default: 0.82)
  layer4Trigger: number;  // % full to trigger layer 4 (default: 0.92)
  keepRecentTurns: number;  // turns to preserve in layers 1-3
  maxToolOutputChars: number;  // max chars per tool output after microcompact
}

const DEFAULT_CONFIG: CompactConfig = {
  maxContextTokens: 128000,
  layer1Trigger: 0.60,
  layer2Trigger: 0.70,
  layer3Trigger: 0.82,
  layer4Trigger: 0.92,
  keepRecentTurns: 3,
  maxToolOutputChars: 500,
};

export interface CompactAction {
  layer: CompactLayer;
  droppedCount: number;
  tokensSaved: number;
  summary?: string;
  description: string;
}

export class ContextCompactor {
  private config: CompactConfig;

  constructor(config?: Partial<CompactConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getUsage(messages: LLMMessage[]): { total: number; pct: number } {
    const total = estimateTotalTokens(messages);
    return { total, pct: total / this.config.maxContextTokens };
  }

  needsCompaction(messages: LLMMessage[]): CompactLayer | null {
    const { pct } = this.getUsage(messages);
    if (pct >= this.config.layer4Trigger) return 4;
    if (pct >= this.config.layer3Trigger) return 3;
    if (pct >= this.config.layer2Trigger) return 2;
    if (pct >= this.config.layer1Trigger) return 1;
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

  // Layer 1: Remove oldest tool results beyond keepRecentTurns
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

    const before = estimateTotalTokens(messages);
    const result = [...system, ...kept.flat()];
    const after = estimateTotalTokens(result);

    return {
      messages: result,
      action: { layer: 1, droppedCount: dropped, tokensSaved: before - after, description: `Layer 1 snip: removed ${dropped} oldest turn(s)` },
    };
  }

  // Layer 2: Trim verbose tool outputs
  private layer2Microcompact(messages: LLMMessage[]): { messages: LLMMessage[]; action: CompactAction } {
    const before = estimateTotalTokens(messages);
    let trimmedCount = 0;

    const result = messages.map(msg => {
      if (msg.role === 'tool' && msg.content.length > this.config.maxToolOutputChars) {
        trimmedCount++;
        const head = msg.content.slice(0, this.config.maxToolOutputChars);
        return { ...msg, content: `${head}\n...[+${msg.content.length - this.config.maxToolOutputChars} more chars trimmed]` };
      }
      return msg;
    });

    const after = estimateTotalTokens(result);
    return {
      messages: result,
      action: { layer: 2, droppedCount: trimmedCount, tokensSaved: before - after, description: `Layer 2 microcompact: trimmed ${trimmedCount} tool outputs` },
    };
  }

  // Layer 3: Collapse middle turns into structured summary
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

    const summary = this.buildStructuredSummary(collapseTargets, provider);
    const summaryMsg: LLMMessage = { role: 'system', content: `[Compacted summary of ${collapseTargets.length} earlier turns:\n${summary}]` };

    const before = estimateTotalTokens(messages);
    const result = [...system, summaryMsg, ...recent.flat()];
    const after = estimateTotalTokens(result);

    return {
      messages: result,
      action: { layer: 3, droppedCount: collapseTargets.length, tokensSaved: before - after, summary, description: `Layer 3 collapse: compressed ${collapseTargets.length} turns into summary` },
    };
  }

  // Layer 4: Emergency full conversation summary
  private layer4Autocompact(messages: LLMMessage[], provider?: LLMProvider): { messages: LLMMessage[]; action: CompactAction } {
    const system: LLMMessage[] = messages.filter(m => m.role === 'system');
    const nonSystem: LLMMessage[] = messages.filter(m => m.role !== 'system');

    const summary = this.buildStructuredSummary([nonSystem], provider);
    const summaryMsg: LLMMessage = { role: 'system', content: `[Emergency compact: full conversation summary\n${summary}]` };

    const before = estimateTotalTokens(messages);
    const keepRecent = nonSystem.slice(-20);
    const result = [...system, summaryMsg, ...keepRecent];
    const after = estimateTotalTokens(result);

    return {
      messages: result,
      action: { layer: 4, droppedCount: nonSystem.length - keepRecent.length, tokensSaved: before - after, summary, description: `Layer 4 autocompact: emergency full summary` },
    };
  }

  private buildStructuredSummary(turns: LLMMessage[][], _provider?: LLMProvider): string {
    const toolCalls = new Set<string>();
    const errors: string[] = [];
    const decisions: string[] = [];
    const files: string[] = [];
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
          if (c.startsWith('error:') || c.startsWith('tool_error')) {
            errors.push(c.split('\n')[0].slice(0, 120));
          }
        }
        if (msg.role === 'assistant' && !msg.tool_calls) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          const decision = text.match(/(?:I will|Let me|Going to|Plan to) .*?[.!\n]/i);
          if (decision) decisions.push(decision[0].slice(0, 100));
        }
      }
    }

    const parts: string[] = ['## Progress'];
    if (userGoals) parts.push(`Goal: ${userGoals}`);
    if (toolCalls.size > 0) parts.push(`Tools: ${[...toolCalls].join(', ')}`);
    if (files.length > 0) parts.push(`Files: ${[...new Set(files)].join(', ')}`);
    if (decisions.length > 0) parts.push(`\n## Key Decisions\n${decisions.join('\n')}`);
    if (errors.length > 0) parts.push(`\n## Issues\n${errors.slice(0, 5).join('\n')}`);

    return parts.join('\n') || `${turns.length} turn(s) compacted`;
  }
}
