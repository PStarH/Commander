/**
 * DeadLetterQueue — Persistent storage for failed executions and tool calls.
 *
 * Each failure is recorded as a JSON line in .commander_dlq/{category}.ndjson.
 * Uses append-only writes for performance. Supports per-category isolation (llm, tool, execution).
 */
import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';
import type { ErrorClass } from './llmRetry';

export type DLQCategory =
  | 'llm'
  | 'tool'
  | 'execution'
  | 'verification'
  | 'circuit_breaker'
  | 'compensation'
  | 'semantic_drift';

/**
 * Tier 4.1: Standardized failure-mode discriminator. Each DLQ entry should
 * include a `mode:<FailureMode>` tag so operators can filter by cause
 * (timeout, rate_limit, auth, etc.) rather than parsing free-form messages.
 */
export type FailureMode =
  | 'timeout'
  | 'rate_limit'
  | 'auth'
  | 'validation'
  | 'compilation'
  | 'execution'
  | 'provider_unavailable'
  | 'budget_exceeded'
  | 'verification'
  | 'compensation_exhausted'
  | 'cascade_escalation'
  | 'subagent_limit'
  | 'circuit_open'
  | 'semantic_degradation'
  | 'unknown';

export const failureModeTag = (mode: FailureMode): string => `mode:${mode}`;

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
  private baseDirEnsured = false;
  private buffers: Map<string, string[]> = new Map();
  // Track line counts per file to avoid re-reading just for counting
  private lineCounts: Map<string, number> = new Map();
  // Serialize per-category flush operations so async writes stay atomic.
  private flushLocks: Map<string, Promise<void>> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), '.commander_dlq');
  }

  private async ensureBaseDir(): Promise<void> {
    if (this.baseDirEnsured) return;
    await fs.promises.mkdir(this.baseDir, { recursive: true });
    this.baseDirEnsured = true;
  }

  record(entry: DeadLetterEntry): void {
    const key = entry.category;
    const buffer = this.buffers.get(key) ?? [];
    buffer.push(JSON.stringify(entry));
    this.buffers.set(key, buffer);

    if (buffer.length >= 100) {
      // Auto-flush is fire-and-forget: record() must stay synchronous and
      // only manipulate the in-memory buffer. Errors are logged best-effort.
      this.flush(key).catch((err) => {
        getGlobalLogger().warn('DeadLetterQueue', 'Auto-flush failed', {
          error: (err as Error)?.message,
          category: key,
        });
      });
    }
    // Publish DLQ depth gauge (in-memory pending entries as a lower bound;
    // full on-disk depth is published by getStats()).
    this.publishDepthGauge();
  }

  /** Set the dlq_depth gauge to the total in-memory buffer depth across categories. */
  private publishDepthGauge(): void {
    let depth = 0;
    for (const buf of this.buffers.values()) depth += buf.length;
    getMetricsCollector().setDlqDepth(depth);
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
    failureMode?: FailureMode;
    failureModeNumber?: number;
    payload?: Record<string, unknown>;
  }): void {
    const tags = [...(spec.tags ?? [])];
    if (spec.failureMode) tags.push(failureModeTag(spec.failureMode));
    if (spec.failureModeNumber !== undefined) tags.push(`mode:${spec.failureModeNumber}`);
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
      tags,
    };
    this.record(entry);
  }

  private static readonly MAX_ENTRIES_PER_FILE = 1000;

  async flush(category?: DLQCategory): Promise<void> {
    const cats = category ? [category] : (Array.from(this.buffers.keys()) as DLQCategory[]);
    for (const cat of cats) {
      await this.flushCategory(cat);
    }
  }

  private async flushCategory(cat: DLQCategory): Promise<void> {
    // Serialize flushes for this category so concurrent writes don't corrupt
    // the append-only file or the tmp+rename atomic rewrite.
    const previous = this.flushLocks.get(cat) ?? Promise.resolve();
    const current = previous.then(
      () => this.flushCategoryUnlocked(cat),
      () => this.flushCategoryUnlocked(cat),
    );
    this.flushLocks.set(cat, current);
    await current;
  }

  private async flushCategoryUnlocked(cat: DLQCategory): Promise<void> {
    await this.ensureBaseDir();

    // Atomic swap: take the buffer out first so concurrent record() calls
    // go into a fresh buffer instead of getting lost when we clear below.
    const buffer = this.buffers.get(cat);
    if (!buffer || buffer.length === 0) return;
    this.buffers.set(cat, []);
    const filePath = path.join(this.baseDir, `${cat}.ndjson`);
    try {
      // Append-only: just append new entries to the file (no read-modify-write)
      const content = buffer.join('\n') + '\n';
      await fs.promises.appendFile(filePath, content, 'utf-8');

      // Update tracked line count
      const prevCount = this.lineCounts.get(cat) ?? 0;
      this.lineCounts.set(cat, prevCount + buffer.length);

      // If over cap, rewrite file with only the last MAX_ENTRIES_PER_FILE lines
      if ((this.lineCounts.get(cat) ?? 0) > DeadLetterQueue.MAX_ENTRIES_PER_FILE) {
        const raw = (await fs.promises.readFile(filePath, 'utf-8')).trim();
        const lines = raw ? raw.split('\n') : [];
        const trimmed = lines.slice(-DeadLetterQueue.MAX_ENTRIES_PER_FILE);
        const tmpPath = path.join(this.baseDir, `${cat}.tmp`);
        await fs.promises.writeFile(tmpPath, trimmed.join('\n') + '\n', 'utf-8');
        await fs.promises.rename(tmpPath, filePath);
        this.lineCounts.set(cat, trimmed.length);
      }
    } catch (e) {
      getGlobalLogger().warn('DeadLetterQueue', 'Failed to flush dead-letter entries', {
        error: (e as Error)?.message,
        category: cat,
      });
    }
  }

  async readEntries(category: DLQCategory, limit = 50): Promise<DeadLetterEntry[]> {
    // Flush in-memory buffer to disk first so reads see all enqueued entries
    await this.flush(category);
    await this.ensureBaseDir();
    const filePath = path.join(this.baseDir, `${category}.ndjson`);
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
    } catch {
      return [];
    }
    try {
      const raw = (await fs.promises.readFile(filePath, 'utf-8')).trim();
      if (!raw) return [];
      const entries: DeadLetterEntry[] = [];
      // Read lines from end (most recent first) without reversing the whole array
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try {
          entries.push(JSON.parse(lines[i]));
        } catch (e) {
          getGlobalLogger().debug('DeadLetterQueue', 'Skipping corrupt entry', {
            error: (e as Error)?.message,
            category,
            line: i,
          });
        }
      }
      return entries;
    } catch (e) {
      getGlobalLogger().warn('DeadLetterQueue', 'Failed to read dead-letter entries', {
        error: (e as Error)?.message,
        category,
      });
      return [];
    }
  }

  /**
   * Get retryable entries: transient failures that haven't been recovered.
   * Useful for automated retry scheduling.
   */
  async getRetryableEntries(category: DLQCategory, limit = 10): Promise<DeadLetterEntry[]> {
    const entries = await this.readEntries(category, 100);
    return entries.filter((e) => e.retryable && !e.recovered && !e.compensated).slice(0, limit);
  }

  /**
   * Replay a previously recorded entry by its id. Marks it recovered
   * and returns the entry plus its category for an external re-execution
   * pipeline (saga compensator, retry scheduler, operator CLI). Update
   * is in-place via tmp-file rename — other entries are preserved.
   *
   * Cross-category search: iterates .ndjson files in baseDir looking
   * for the matching id. Returns null if the entry is not found.
   */
  async replay(entryId: string): Promise<{ category: DLQCategory; entry: DeadLetterEntry } | null> {
    // Flush all buffers to disk so replay can find entries not yet written
    await this.flush();
    await this.ensureBaseDir();
    const files = (await fs.promises.readdir(this.baseDir)).filter((f) => f.endsWith('.ndjson'));
    for (const file of files) {
      const category = file.replace('.ndjson', '') as DLQCategory;
      const filePath = path.join(this.baseDir, file);
      let raw: string;
      try {
        raw = (await fs.promises.readFile(filePath, 'utf-8')).trim();
      } catch {
        continue;
      }
      if (!raw) continue;
      const lines = raw.split('\n');
      const idx = lines.findIndex((line) => {
        try {
          const parsed = JSON.parse(line) as DeadLetterEntry;
          return parsed.id === entryId;
        } catch (err) {
          reportSilentFailure(err, 'deadLetterQueue:240');
          return false;
        }
      });
      if (idx === -1) continue;
      try {
        const entry: DeadLetterEntry = JSON.parse(lines[idx]);
        entry.recovered = true;
        entry.tags = [...(entry.tags ?? []), 'replayed'];
        lines[idx] = JSON.stringify(entry);
        const tmp = path.join(this.baseDir, `${category}.replay.tmp`);
        await fs.promises.writeFile(tmp, lines.join('\n') + '\n', 'utf-8');
        await fs.promises.rename(tmp, filePath);
        this.lineCounts.set(category, lines.length);
        return { category, entry };
      } catch (e) {
        getGlobalLogger().warn('DeadLetterQueue', 'Failed to parse entry during replay', {
          entryId,
          error: (e as Error)?.message,
        });
        return null;
      }
    }
    return null;
  }

  /**
   * Mark an entry as recovered WITHOUT returning/re-executing it.
   * Used by downstream consumers after they have successfully re-executed
   * the operation, to acknowledge that the entry no longer needs retry.
   *
   * This is the "ack" half of the DLQ replay protocol:
   *   1. Worker publishes dlq.replayed event (entry NOT marked recovered)
   *   2. Consumer re-executes the operation
   *   3. Consumer calls markRecovered(entryId) on success
   */
  async markRecovered(entryId: string): Promise<boolean> {
    await this.flush();
    await this.ensureBaseDir();
    const files = (await fs.promises.readdir(this.baseDir)).filter((f) => f.endsWith('.ndjson'));
    for (const file of files) {
      const filePath = path.join(this.baseDir, file);
      let raw: string;
      try {
        raw = (await fs.promises.readFile(filePath, 'utf-8')).trim();
      } catch {
        continue;
      }
      if (!raw) continue;
      const lines = raw.split('\n');
      const idx = lines.findIndex((line) => {
        try {
          const parsed = JSON.parse(line) as DeadLetterEntry;
          return parsed.id === entryId;
        } catch {
          return false;
        }
      });
      if (idx === -1) continue;
      try {
        const parsed = JSON.parse(lines[idx]) as DeadLetterEntry;
        parsed.recovered = true;
        lines[idx] = JSON.stringify(parsed);
        const tmpPath = filePath + '.tmp';
        await fs.promises.writeFile(tmpPath, lines.join('\n') + '\n');
        await fs.promises.rename(tmpPath, filePath);
        return true;
      } catch (err) {
        reportSilentFailure(err, `deadLetterQueue:markRecovered:${entryId}`);
        return false;
      }
    }
    return false;
  }

  /**
   * List all entries across DLQ categories that are retryable but
   * haven't been recovered yet. The caller decides what to do with
   * these (re-execute via saga, alert an operator, etc.).
   */
  async listUnrecoveredEntries(
    limit = 50,
  ): Promise<Array<{ category: DLQCategory; entry: DeadLetterEntry }>> {
    // Flush all buffers to disk so the listing includes pending entries
    await this.flush();
    await this.ensureBaseDir();
    const result: Array<{ category: DLQCategory; entry: DeadLetterEntry }> = [];
    const files = (await fs.promises.readdir(this.baseDir)).filter((f) => f.endsWith('.ndjson'));
    for (const file of files) {
      const category = file.replace('.ndjson', '') as DLQCategory;
      const entries = await this.readEntries(category, limit);
      for (const entry of entries) {
        if (!entry.recovered && entry.retryable) {
          result.push({ category, entry });
          if (result.length >= limit) return result;
        }
      }
    }
    return result;
  }

  async getStats(): Promise<{ category: string; count: number }[]> {
    // Flush all buffers so stats reflect pending entries
    await this.flush();
    await this.ensureBaseDir();
    const results: { category: string; count: number }[] = [];
    let totalDepth = 0;
    try {
      const files = await fs.promises.readdir(this.baseDir);
      for (const f of files) {
        if (f.endsWith('.ndjson')) {
          const cat = f.replace('.ndjson', '');
          // Use tracked count if available, otherwise count by reading
          let count = this.lineCounts.get(cat);
          if (count === undefined) {
            const raw = (await fs.promises.readFile(path.join(this.baseDir, f), 'utf-8')).trim();
            count = raw ? raw.split('\n').length : 0;
            this.lineCounts.set(cat, count);
          }
          results.push({ category: cat, count });
          totalDepth += count;
          // Per-category depth gauge
          getMetricsCollector().setDlqDepth(count, cat);
        }
      }
    } catch (e) {
      getGlobalLogger().warn('DeadLetterQueue', 'Failed to collect dead-letter stats', {
        error: (e as Error)?.message,
      });
    }
    // Aggregate depth gauge (no category label) for dashboard convenience
    getMetricsCollector().setDlqDepth(totalDepth);
    return results;
  }
}
