/**
 * DeadLetterQueue — Persistent storage for failed executions and tool calls.
 *
 * Each failure is recorded as a JSON line in .commander_dlq/{category}.ndjson.
 * Uses append-only writes for performance. Supports per-category isolation (llm, tool, execution).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import type { ErrorClass } from './llmRetry';

export type DLQCategory = 'llm' | 'tool' | 'execution' | 'verification' | 'circuit_breaker' | 'compensation';

export interface DeadLetterEntry {
  id: string;
  category: DLQCategory;
  runId: string;
  agentId: string;
  missionId?: string;
  timestamp: string;
  errorClass: ErrorClass;
  errorMessage: string;
  retryable: boolean;
  attemptNumber: number;
  /** Name of the operation that failed */
  operationName: string;
  /** Snapshot of input args or request at time of failure */
  inputSnapshot?: string;
  /** Token usage before failure */
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Whether a compensation action was executed */
  compensated: boolean;
  /** Whether the failure was recovered (retry succeeded) */
  recovered: boolean;
  /** Tags for filtering */
  tags: string[];
}

export class DeadLetterQueue {
  private baseDir: string;
  private buffers: Map<string, string[]> = new Map();
  // Track line counts per file to avoid re-reading just for counting
  private lineCounts: Map<string, number> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), '.commander_dlq');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  record(entry: DeadLetterEntry): void {
    const key = entry.category;
    const buffer = this.buffers.get(key) ?? [];
    buffer.push(JSON.stringify(entry));
    this.buffers.set(key, buffer);

    if (buffer.length >= 10) {
      this.flush(key);
    }
  }

  /**
   * Convenience: enqueue from partial spec. Fills sensible defaults for
   * the DeadLetterEntry required fields. Used by observability hooks
   * (circuit breaker, compensation, sub-agent) that don't have a full
   * run context.
   */
  enqueue(spec: {
    category: DLQCategory;
    runId?: string;
    agentId?: string;
    missionId?: string;
    operationName: string;
    errorMessage: string;
    errorClass?: ErrorClass;
    retryable?: boolean;
    attemptNumber?: number;
    compensated?: boolean;
    recovered?: boolean;
    tags?: string[];
    payload?: Record<string, unknown>;
  }): void {
    const entry: DeadLetterEntry = {
      id: `${spec.category}-${spec.operationName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      category: spec.category,
      runId: spec.runId ?? 'unknown',
      agentId: spec.agentId ?? 'unknown',
      missionId: spec.missionId,
      timestamp: new Date().toISOString(),
      errorClass: spec.errorClass ?? 'permanent',
      errorMessage: spec.errorMessage,
      retryable: spec.retryable ?? false,
      attemptNumber: spec.attemptNumber ?? 1,
      operationName: spec.operationName,
      inputSnapshot: spec.payload ? JSON.stringify(spec.payload) : undefined,
      compensated: spec.compensated ?? false,
      recovered: spec.recovered ?? false,
      tags: spec.tags ?? [],
    };
    this.record(entry);
  }

  private static readonly MAX_ENTRIES_PER_FILE = 1000;

  flush(category?: DLQCategory): void {
    const cats = category ? [category] : (['llm', 'tool', 'execution', 'verification', 'circuit_breaker', 'compensation'] as DLQCategory[]);
    for (const cat of cats) {
      // Atomic swap: take the buffer out first so concurrent record() calls
      // go into a fresh buffer instead of getting lost when we clear below.
      const buffer = this.buffers.get(cat);
      if (!buffer || buffer.length === 0) continue;
      this.buffers.set(cat, []);
      const filePath = path.join(this.baseDir, `${cat}.ndjson`);
      try {
        // Append-only: just append new entries to the file (no read-modify-write)
        const content = buffer.join('\n') + '\n';
        fs.appendFileSync(filePath, content, 'utf-8');

        // Update tracked line count
        const prevCount = this.lineCounts.get(cat) ?? 0;
        this.lineCounts.set(cat, prevCount + buffer.length);

        // If over cap, rewrite file with only the last MAX_ENTRIES_PER_FILE lines
        if ((this.lineCounts.get(cat) ?? 0) > DeadLetterQueue.MAX_ENTRIES_PER_FILE) {
          const raw = fs.readFileSync(filePath, 'utf-8').trim();
          const lines = raw ? raw.split('\n') : [];
          const trimmed = lines.slice(-DeadLetterQueue.MAX_ENTRIES_PER_FILE);
          const tmpPath = path.join(this.baseDir, `${cat}.tmp`);
          fs.writeFileSync(tmpPath, trimmed.join('\n') + '\n', 'utf-8');
          fs.renameSync(tmpPath, filePath);
          this.lineCounts.set(cat, trimmed.length);
        }
      } catch (e) { getGlobalLogger().warn('DeadLetterQueue', 'Failed to flush dead-letter entries', { error: (e as Error)?.message, category: cat }); }
    }
  }

  readEntries(category: DLQCategory, limit = 50): DeadLetterEntry[] {
    const filePath = path.join(this.baseDir, `${category}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      const entries: DeadLetterEntry[] = [];
      // Read lines from end (most recent first) without reversing the whole array
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try { entries.push(JSON.parse(lines[i])); } catch (e) { getGlobalLogger().debug('DeadLetterQueue', 'Skipping corrupt entry', { error: (e as Error)?.message, category, line: i }); }
      }
      return entries;
    } catch (e) {
      getGlobalLogger().warn('DeadLetterQueue', 'Failed to read dead-letter entries', { error: (e as Error)?.message, category });
      return [];
    }
  }

  /**
   * Get retryable entries: transient failures that haven't been recovered.
   * Useful for automated retry scheduling.
   */
  getRetryableEntries(category: DLQCategory, limit = 10): DeadLetterEntry[] {
    return this.readEntries(category, 100)
      .filter(e => e.retryable && !e.recovered && !e.compensated)
      .slice(0, limit);
  }

  getStats(): { category: string; count: number }[] {
    const results: { category: string; count: number }[] = [];
    try {
      const files = fs.readdirSync(this.baseDir);
      for (const f of files) {
        if (f.endsWith('.ndjson')) {
          const cat = f.replace('.ndjson', '');
          // Use tracked count if available, otherwise count by reading
          let count = this.lineCounts.get(cat);
          if (count === undefined) {
            const raw = fs.readFileSync(path.join(this.baseDir, f), 'utf-8').trim();
            count = raw ? raw.split('\n').length : 0;
            this.lineCounts.set(cat, count);
          }
          results.push({ category: cat, count });
        }
      }
    } catch (e) { getGlobalLogger().warn('DeadLetterQueue', 'Failed to collect dead-letter stats', { error: (e as Error)?.message }); }
    return results;
  }
}
