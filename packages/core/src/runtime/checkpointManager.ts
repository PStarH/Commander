/**
 * Checkpoint Manager — save and restore conversation state.
 *
 * Can optionally be backed by CheckpointStore (SQLite) for crash-safe
 * persistence. When a store is provided, all save/rewind operations
 * are transactionally written to both in-memory and SQLite.
 *
 * Inspired by oh-my-pi's checkpoint/rewind tools.
 */

import type { LLMMessage } from './types';
import {
  CheckpointStore,
  getCheckpointStore,
  type CheckpointSnapshot,
  type CheckpointRecord,
} from './checkpointStore';

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
  private store?: CheckpointStore;
  private runId?: string;

  constructor(maxCheckpoints: number = 20, options?: { store?: CheckpointStore; runId?: string }) {
    this.maxCheckpoints = maxCheckpoints;
    this.store = options?.store;
    this.runId = options?.runId;
  }

  save(
    label: string,
    messages: LLMMessage[],
    stepNumber: number,
    filesRead: string[] = [],
    filesModified: string[] = [],
  ): Checkpoint {
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tokenCount = this.estimateTokens(messages);
    const now = new Date().toISOString();

    const checkpoint: Checkpoint = {
      id,
      label,
      timestamp: Date.now(),
      messages: [...messages],
      tokenCount,
      stepNumber,
      filesRead: [...filesRead],
      filesModified: [...filesModified],
    };

    this.checkpoints.push(checkpoint);

    if (this.store && this.runId) {
      const snapshot: CheckpointSnapshot = {
        checkpoint: {
          id,
          runId: this.runId,
          label,
          stepNumber,
          tokenCount,
          createdAt: now,
          version: 1,
        },
        messages: [...messages],
        filesRead: [...filesRead],
        filesModified: [...filesModified],
      };
      try {
        this.store.save(snapshot);
      } catch (e) {
        /* persistence failure is non-fatal — in-memory copy still works */
      }
    }

    while (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }

    return checkpoint;
  }

  get(id: string): Checkpoint | undefined {
    let cp = this.checkpoints.find((c) => c.id === id);
    if (!cp && this.store) {
      const snapshot = this.store.getSnapshot(id);
      if (snapshot) {
        cp = this.toCheckpoint(snapshot);
        this.checkpoints.push(cp);
      }
    }
    return cp;
  }

  getLatest(): Checkpoint | undefined {
    if (this.checkpoints.length > 0) {
      return this.checkpoints[this.checkpoints.length - 1];
    }
    if (this.store && this.runId) {
      const record = this.store.getLatestByRun(this.runId);
      if (record) {
        const snapshot = this.store.getSnapshot(record.id);
        if (snapshot) {
          const cp = this.toCheckpoint(snapshot);
          this.checkpoints.push(cp);
          return cp;
        }
      }
    }
    return undefined;
  }

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

  rewind(id: string): LLMMessage[] | null {
    const checkpoint = this.checkpoints.find((cp) => cp.id === id);
    if (!checkpoint) {
      if (this.store) {
        const messages = this.store.rewindTo(id);
        if (messages) {
          const idx = this.checkpoints.findIndex((cp) => cp.id === id);
          if (idx >= 0) {
            this.checkpoints = this.checkpoints.slice(0, idx + 1);
          }
          return messages;
        }
      }
      return null;
    }

    const idx = this.checkpoints.indexOf(checkpoint);
    this.checkpoints = this.checkpoints.slice(0, idx + 1);

    if (this.store) {
      this.store.rewindTo(id);
    }

    return [...checkpoint.messages];
  }

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

    const decisions: string[] = [];
    const findings: string[] = [];

    for (const msg of checkpoint.messages) {
      if (msg.role === 'assistant' && msg.content) {
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

  clear(): void {
    this.checkpoints = [];
    if (this.store && this.runId) {
      this.store.deleteRun(this.runId);
    }
  }

  get size(): number {
    return this.checkpoints.length;
  }

  // ── Internal ──

  private toCheckpoint(snapshot: CheckpointSnapshot): Checkpoint {
    const { checkpoint, messages, filesRead, filesModified } = snapshot;
    return {
      id: checkpoint.id,
      label: checkpoint.label,
      timestamp: new Date(checkpoint.createdAt).getTime(),
      messages: [...messages],
      tokenCount: checkpoint.tokenCount,
      stepNumber: checkpoint.stepNumber,
      filesRead: [...filesRead],
      filesModified: [...filesModified],
    };
  }

  private estimateTokens(messages: LLMMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      total += Math.ceil(content.length / 4);
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

export interface CheckpointManagerOptions {
  /** Path to SQLite store file. Enables crash-safe persistence when set. */
  storePath?: string;
  /** Run ID for multi-run isolation */
  runId?: string;
  /** Max in-memory checkpoints */
  maxCheckpoints?: number;
}

export function getCheckpointManager(options?: CheckpointManagerOptions): CheckpointManager {
  if (!globalCheckpointManager) {
    const maxCheckpoints = options?.maxCheckpoints ?? 20;
    let store: CheckpointStore | undefined;
    if (options?.storePath) {
      store = getCheckpointStore(options.storePath);
    }
    globalCheckpointManager = new CheckpointManager(maxCheckpoints, {
      store,
      runId: options?.runId,
    });
  }
  return globalCheckpointManager;
}

export function resetCheckpointManager(): void {
  globalCheckpointManager = null;
}
