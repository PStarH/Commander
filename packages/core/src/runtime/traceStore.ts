/**
 * TraceStore — Persistent storage for execution trace events.
 *
 * Appends each event as a JSON line to .commander_traces/{runId}.ndjson.
 * Sync writes for crash safety (same pattern as StateCheckpointer).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TraceEvent } from './types';

export interface TraceStore {
  append(event: TraceEvent): void;
  flush(runId: string): void;
}

export class PersistentTraceStore implements TraceStore {
  private baseDir: string;
  private buffers: Map<string, string[]> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), '.commander_traces');
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  append(event: TraceEvent): void {
    const key = event.runId;
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.push(JSON.stringify(event));
    } else {
      this.buffers.set(key, [JSON.stringify(event)]);
    }

    if (buffer && buffer.length >= 10) {
      this.flush(key);
    }
  }

  flush(runId: string): void {
    const buffer = this.buffers.get(runId);
    if (!buffer || buffer.length === 0) return;

    const filePath = path.join(this.baseDir, `${runId}.ndjson`);
    const tmpPath = path.join(this.baseDir, `${runId}.tmp`);
    try {
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
      const content = existing + buffer.join('\n') + '\n';
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch { /* ignore */ }
    this.buffers.set(runId, []);
  }

  flushAll(): void {
    for (const key of this.buffers.keys()) {
      this.flush(key);
    }
  }

  readTrace(runId: string): TraceEvent[] {
    const filePath = path.join(this.baseDir, `${runId}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      const events: TraceEvent[] = [];
      for (const line of raw.split('\n')) {
        try { events.push(JSON.parse(line)); } catch { /* skip corrupt */ }
      }
      return events;
    } catch {
      return [];
    }
  }
}
