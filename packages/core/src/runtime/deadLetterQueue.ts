/**
 * DeadLetterQueue — Persistent storage for failed executions and tool calls.
 *
 * Each failure is recorded as a JSON line in .commander_dlq/{category}.ndjson.
 * Sync writes for crash safety. Supports per-category isolation (llm, tool, execution).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import type { ErrorClass } from './llmRetry';

export type DLQCategory = 'llm' | 'tool' | 'execution' | 'verification';

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

  flush(category?: DLQCategory): void {
    const cats = category ? [category] : (['llm', 'tool', 'execution', 'verification'] as DLQCategory[]);
    for (const cat of cats) {
      const buffer = this.buffers.get(cat);
      if (!buffer || buffer.length === 0) continue;
      const filePath = path.join(this.baseDir, `${cat}.ndjson`);
      const tmpPath = path.join(this.baseDir, `${cat}.tmp`);
      try {
        const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
        const content = existing + buffer.join('\n') + '\n';
        fs.writeFileSync(tmpPath, content, 'utf-8');
        fs.renameSync(tmpPath, filePath);
      } catch (e) { getGlobalLogger().warn('DeadLetterQueue', 'Failed to flush dead-letter entries', { error: (e as Error)?.message, category: cat }); }
      this.buffers.set(cat, []);
    }
  }

  readEntries(category: DLQCategory, limit = 50): DeadLetterEntry[] {
    const filePath = path.join(this.baseDir, `${category}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      const entries: DeadLetterEntry[] = [];
      for (const line of raw.split('\n').reverse()) {
        try { entries.push(JSON.parse(line)); } catch (e) { getGlobalLogger().warn('DeadLetterQueue', 'Skipped corrupt dead-letter entry', { error: (e as Error)?.message, category, line }); }
        if (entries.length >= limit) break;
      }
      return entries;
    } catch (e) {
      getGlobalLogger().warn('DeadLetterQueue', 'Failed to read dead-letter entries', { error: (e as Error)?.message, category });
      return [];
    }
  }

  getStats(): { category: string; count: number }[] {
    const results: { category: string; count: number }[] = [];
    try {
      const files = fs.readdirSync(this.baseDir);
      for (const f of files) {
        if (f.endsWith('.ndjson')) {
          const raw = fs.readFileSync(path.join(this.baseDir, f), 'utf-8').trim();
          const count = raw ? raw.split('\n').length : 0;
          results.push({ category: f.replace('.ndjson', ''), count });
        }
      }
    } catch (e) { getGlobalLogger().warn('DeadLetterQueue', 'Failed to collect dead-letter stats', { error: (e as Error)?.message }); }
    return results;
  }
}
