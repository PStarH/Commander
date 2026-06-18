/**
 * Checkpoint Manager — save and restore conversation state.
 *
 * Inspired by oh-my-pi's checkpoint/rewind tools. Allows the agent to:
 * - Save a checkpoint of the current conversation state
 * - Rewind to a previous checkpoint (prune exploratory context)
 * - Collapse a checkpoint into a concise report
 *
 * This is critical for long coding sessions where the model may need to
 * backtrack after trying an approach that didn't work.
 */

import type { LLMMessage } from './types';

// ============================================================================
// Types
// ============================================================================

export interface Checkpoint {
  /** Unique checkpoint ID */
  id: string;
  /** Human-readable label */
  label: string;
  /** Timestamp */
  timestamp: number;
  /** Messages at checkpoint time */
  messages: LLMMessage[];
  /** Token count at checkpoint */
  tokenCount: number;
  /** Step number at checkpoint */
  stepNumber: number;
  /** Files read at checkpoint (for hashline context) */
  filesRead: string[];
  /** Files modified at checkpoint */
  filesModified: string[];
}

export interface CheckpointSummary {
  id: string;
  label: string;
  timestamp: number;
  stepNumber: number;
  messageCount: number;
  tokenCount: number;
  filesRead: string[];
  filesModified: string[];
}

// ============================================================================
// Checkpoint Manager
// ============================================================================

export class CheckpointManager {
  private checkpoints: Checkpoint[] = [];
  private maxCheckpoints: number;

  constructor(maxCheckpoints: number = 20) {
    this.maxCheckpoints = maxCheckpoints;
  }

  /**
   * Save a checkpoint of the current conversation state.
   */
  save(
    label: string,
    messages: LLMMessage[],
    stepNumber: number,
    filesRead: string[] = [],
    filesModified: string[] = [],
  ): Checkpoint {
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tokenCount = this.estimateTokens(messages);

    const checkpoint: Checkpoint = {
      id,
      label,
      timestamp: Date.now(),
      messages: [...messages], // Deep copy
      tokenCount,
      stepNumber,
      filesRead: [...filesRead],
      filesModified: [...filesModified],
    };

    this.checkpoints.push(checkpoint);

    // Trim old checkpoints if over limit
    while (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }

    return checkpoint;
  }

  /**
   * Get a checkpoint by ID.
   */
  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find((cp) => cp.id === id);
  }

  /**
   * Get the most recent checkpoint.
   */
  getLatest(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  /**
   * List all checkpoints (summaries only, no message data).
   */
  list(): CheckpointSummary[] {
    return this.checkpoints.map((cp) => ({
      id: cp.id,
      label: cp.label,
      timestamp: cp.timestamp,
      stepNumber: cp.stepNumber,
      messageCount: cp.messages.length,
      tokenCount: cp.tokenCount,
      filesRead: cp.filesRead,
      filesModified: cp.filesModified,
    }));
  }

  /**
   * Rewind to a checkpoint — return the messages to restore.
   * This effectively prunes all messages after the checkpoint.
   */
  rewind(id: string): LLMMessage[] | null {
    const checkpoint = this.checkpoints.find((cp) => cp.id === id);
    if (!checkpoint) return null;

    // Remove all checkpoints after this one
    const idx = this.checkpoints.indexOf(checkpoint);
    this.checkpoints = this.checkpoints.slice(0, idx + 1);

    return [...checkpoint.messages];
  }

  /**
   * Collapse a checkpoint into a concise summary.
   * Returns a system message that summarizes what happened since the checkpoint.
   */
  collapse(id: string): string | null {
    const checkpoint = this.checkpoints.find((cp) => cp.id === id);
    if (!checkpoint) return null;

    const parts: string[] = [
      `## Checkpoint: ${checkpoint.label}`,
      `Saved at step ${checkpoint.stepNumber}`,
      '',
    ];

    if (checkpoint.filesRead.length > 0) {
      parts.push(`Files read: ${checkpoint.filesRead.join(', ')}`);
    }
    if (checkpoint.filesModified.length > 0) {
      parts.push(`Files modified: ${checkpoint.filesModified.join(', ')}`);
    }

    // Extract key decisions and findings from messages
    const decisions: string[] = [];
    const findings: string[] = [];

    for (const msg of checkpoint.messages) {
      if (msg.role === 'assistant' && msg.content) {
        // Extract decision patterns
        const decisionMatch = msg.content.match(/(?:I will|Let me|Going to|Plan to) .{10,100}/i);
        if (decisionMatch) decisions.push(decisionMatch[0].slice(0, 120));
      }
      if (msg.role === 'tool' && msg.content) {
        const lines = msg.content.split('\n');
        const finding = lines.find((l) => l.trim().length > 20 && l.trim().length < 150);
        if (finding) findings.push(finding.trim().slice(0, 100));
      }
    }

    if (decisions.length > 0) {
      parts.push(`\nKey decisions: ${decisions.slice(0, 3).join('; ')}`);
    }
    if (findings.length > 0) {
      parts.push(`\nKey findings: ${findings.slice(0, 3).join('; ')}`);
    }

    return parts.join('\n');
  }

  /**
   * Clear all checkpoints.
   */
  clear(): void {
    this.checkpoints = [];
  }

  /**
   * Get checkpoint count.
   */
  get size(): number {
    return this.checkpoints.length;
  }

  // ── Internal ──

  private estimateTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      total += Math.ceil(content.length / 4); // rough estimate
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          total += Math.ceil((tc.function.name.length + tc.function.arguments.length) / 4);
        }
      }
    }
    return total;
  }
}

// ============================================================================
// Global singleton
// ============================================================================

let globalCheckpointManager: CheckpointManager | null = null;

export function getCheckpointManager(): CheckpointManager {
  if (!globalCheckpointManager) {
    globalCheckpointManager = new CheckpointManager();
  }
  return globalCheckpointManager;
}

export function resetCheckpointManager(): void {
  globalCheckpointManager = null;
}
