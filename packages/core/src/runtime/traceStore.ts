/**
 * TraceStore — Persistent storage for execution trace events.
 *
 * Appends each event as a JSON line to .commander_traces/{runId}.ndjson.
 * Sync writes for crash safety (same pattern as StateCheckpointer).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getGlobalLogger } from '../logging';
import type { TraceEvent } from './types';

export interface TraceStore {
  append(event: TraceEvent): void;
  flush(runId: string): void;
}

export class PersistentTraceStore implements TraceStore {
  private baseDir: string;
  private buffers: Map<string, string[]> = new Map();
  private bufferTimestamps: Map<string, number> = new Map();
  private static readonly BUFFER_TTL_MS = 5 * 60_000; // 5 minutes
  private tenantId?: string;
  private staleFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseDir?: string, tenantId?: string) {
    this.tenantId = tenantId;
    const base = baseDir ?? path.join(process.cwd(), '.commander_traces');
    this.baseDir = tenantId ? path.join(base, `tenant_${tenantId}`) : base;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  append(event: TraceEvent): void {
    const key = event.runId;
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.push(JSON.stringify(event));
    } else {
      this.buffers.set(key, [JSON.stringify(event)]);
      this.bufferTimestamps.set(key, Date.now());
    }

    if (buffer && buffer.length >= 10) {
      this.flush(key);
    }

    // Flush stale buffers periodically (not on every append to avoid O(n) scan)
    if (!this.staleFlushTimer) {
      this.staleFlushTimer = setTimeout(() => { this.staleFlushTimer = null; this.flushStaleBuffers(); }, 60_000);
      if (this.staleFlushTimer?.unref) this.staleFlushTimer.unref();
    }
  }

  private flushStaleBuffers(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.bufferTimestamps) {
      if (now - timestamp > PersistentTraceStore.BUFFER_TTL_MS) {
        this.flush(key);
      }
    }
  }

  flush(runId: string): void {
    const buffer = this.buffers.get(runId);
    if (!buffer || buffer.length === 0) return;

    const filePath = path.join(this.baseDir, `${runId}.ndjson`);
    try {
      // Append-only: avoids reading the entire growing file on every flush
      fs.appendFileSync(filePath, buffer.join('\n') + '\n', 'utf-8');
    } catch (e) { getGlobalLogger().warn('TraceStore', 'Failed to flush trace buffer', { error: (e as Error)?.message, runId }); }
    this.buffers.delete(runId);
    this.bufferTimestamps.delete(runId);
  }

  flushAll(): void {
    for (const key of this.buffers.keys()) {
      this.flush(key);
    }
  }

  // GAP-04: Graceful shutdown — flush all buffers and clear maps
  shutdown(): void {
    this.flushAll();
    this.buffers.clear();
    this.bufferTimestamps.clear();
  }

  readTrace(runId: string): TraceEvent[] {
    const filePath = path.join(this.baseDir, `${runId}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      const events: TraceEvent[] = [];
      for (const line of raw.split('\n')) {
        try { events.push(JSON.parse(line)); } catch (e) { getGlobalLogger().warn('TraceStore', 'Skipped corrupt trace line', { error: (e as Error)?.message, runId }); }
      }
      return events;
    } catch (e) {
      getGlobalLogger().warn('TraceStore', 'Failed to read trace file', { error: (e as Error)?.message, runId });
      return [];
    }
  }
}
