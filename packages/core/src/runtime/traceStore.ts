/**
 * TraceStore — Persistent storage for execution trace events.
 *
 * Appends each event as a JSON line to .commander_traces/{runId}.ndjson.
 * Sync writes for crash safety (same pattern as StateCheckpointer).
 */
import { reportSilentFailure } from '../silentFailureReporter';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import type { TraceEvent } from './types';

export interface TraceStore {
  append(event: TraceEvent): void;
  flush(runId: string): void;
  appendCritical?(event: TraceEvent): void;
}

/**
 * Sanitize a runId for safe use as a file path component.
 * Strips path traversal sequences and limits length.
 */
export function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
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
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.baseDir, 0o700);
    } catch (err) {
      reportSilentFailure(err, 'traceStore:42');
      /* best-effort */
    }
  }

  append(event: TraceEvent): void {
    const key = sanitizeRunId(event.runId);
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
      this.staleFlushTimer = setTimeout(() => {
        this.staleFlushTimer = null;
        this.flushStaleBuffers();
      }, 60_000);
      if (this.staleFlushTimer?.unref) this.staleFlushTimer.unref();
    }
  }

  /**
   * Test-only accessor: number of unsynced trace events currently
   * buffered in memory for {@link runId}. Returns 0 if no buffer
   * exists yet (same semantics as `buffers.get(...)?.length ?? 0`).
   *
   * Lets async-migration tests assert pre-flush state without
   * reaching into the TypeScript-private `buffers` Map field, which
   * would couple the test to the internal field name.
   *
   * @internal — not part of the supported TraceStore interface.
   *             Production code should rely on append/flush and read
   *             the on-disk ndjson rather than this in-memory count.
   */
  getBufferCount(runId: string): number {
    const key = sanitizeRunId(runId);
    return this.buffers.get(key)?.length ?? 0;
  }

  /**
   * Append a critical event with fsync — guarantees the bytes are on disk
   * before returning. Use sparingly: e.g. circuit-breaker transitions,
   * compensation exhaustion, intent-log writes. Higher latency than append().
   */
  appendCritical(event: TraceEvent): void {
    const key = sanitizeRunId(event.runId);
    const filePath = path.join(this.baseDir, `${key}.ndjson`);
    const line = JSON.stringify(event) + '\n';
    try {
      const fd = fs.openSync(filePath, 'a', 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
      } catch (err) {
        reportSilentFailure(err, 'traceStore:85');
        /* best-effort */
      }
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      getGlobalLogger().warn('TraceStore', 'Failed to append critical trace', {
        error: (e as Error)?.message,
        runId: key,
      });
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
    const key = sanitizeRunId(runId);
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.length === 0) return;

    const filePath = path.join(this.baseDir, `${key}.ndjson`);
    try {
      if (!fs.existsSync(filePath)) {
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, buffer.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
      } else {
        fs.appendFileSync(filePath, buffer.join('\n') + '\n', 'utf-8');
      }
    } catch (e) {
      getGlobalLogger().warn('TraceStore', 'Failed to flush trace buffer', {
        error: (e as Error)?.message,
        runId: key,
      });
    }
    this.buffers.delete(key);
    this.bufferTimestamps.delete(key);
  }

  /**
   * Async variant of flush() — unblocks the event loop when draining many
   * run buffers concurrently (e.g. graceful shutdown of N parallel runs).
   * Tolerates the same ENOENT / EACCES semantics as the sync version.
   */
  async flushAsync(runId: string): Promise<void> {
    const key = sanitizeRunId(runId);
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.length === 0) return;

    const filePath = path.join(this.baseDir, `${key}.ndjson`);
    try {
      // Probe for existing file via fsp.access — faster than stat since
      // we only need the boolean, and cheaper than an extra existsSync.
      try {
        await fs.promises.access(filePath);
        await fs.promises.appendFile(filePath, buffer.join('\n') + '\n', 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const tmpPath = `${filePath}.tmp`;
        await fs.promises.writeFile(tmpPath, buffer.join('\n') + '\n', {
          encoding: 'utf-8',
          mode: 0o600,
        });
        await fs.promises.rename(tmpPath, filePath);
      }
    } catch (e) {
      getGlobalLogger().warn('TraceStore', 'Failed to flush trace buffer (async)', {
        error: (e as Error)?.message,
        runId: key,
      });
    }
    this.buffers.delete(key);
    this.bufferTimestamps.delete(key);
  }

  flushAll(): void {
    for (const key of this.buffers.keys()) {
      this.flush(key);
    }
  }

  /** Async variant of flushAll — drains all buffered runs in parallel. */
  async flushAllAsync(): Promise<void> {
    await Promise.all(Array.from(this.buffers.keys()).map((k) => this.flushAsync(k)));
  }

  // GAP-04: Graceful shutdown — flush all buffers and clear maps
  shutdown(): void {
    this.flushAll();
    this.buffers.clear();
    this.bufferTimestamps.clear();
  }

  /** Async graceful shutdown — drains in parallel. */
  async shutdownAsync(): Promise<void> {
    await this.flushAllAsync();
    this.buffers.clear();
    this.bufferTimestamps.clear();
  }

  readTrace(runId: string): TraceEvent[] {
    const key = sanitizeRunId(runId);
    const filePath = path.join(this.baseDir, `${key}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim();
      if (!raw) return [];
      const events: TraceEvent[] = [];
      for (const line of raw.split('\n')) {
        try {
          events.push(JSON.parse(line));
        } catch (e) {
          getGlobalLogger().warn('TraceStore', 'Skipped corrupt trace line', {
            error: (e as Error)?.message,
            runId: key,
          });
        }
      }
      return events;
    } catch (e) {
      getGlobalLogger().warn('TraceStore', 'Failed to read trace file', {
        error: (e as Error)?.message,
        runId: key,
      });
      return [];
    }
  }

  /**
   * Async variant of readTrace. SSE stream consumers in /api/v1/observability
   * call this on every event tick; leaving it sync blocked the event loop
   * for the duration of file reads at high event rates.
   */
  async readTraceAsync(runId: string): Promise<TraceEvent[]> {
    const key = sanitizeRunId(runId);
    const filePath = path.join(this.baseDir, `${key}.ndjson`);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      getGlobalLogger().warn('TraceStore', 'Failed to read trace file (async)', {
        error: (err as Error)?.message,
        runId: key,
      });
      return [];
    }
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const events: TraceEvent[] = [];
    for (const line of trimmed.split('\n')) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        getGlobalLogger().warn('TraceStore', 'Skipped corrupt trace line (async)', {
          error: (e as Error)?.message,
          runId: key,
        });
      }
    }
    return events;
  }
}
