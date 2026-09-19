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
import { tenantPathSegment } from './tenantContext';
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

// ── Trace base directory configuration (single owner) ─────────────────────
//
// Every trace *writer* (PersistentTraceStore) and every trace *reader*
// (observability, lineage, hallucination, cost dashboard, tenant storage
// accounting) MUST resolve the base directory through this one function.
// Previously each call site had its own rule — the writer ignored the env
// entirely while the observability reader honoured COMMANDER_TRACE_DIR and the
// tenant storage accountant honoured COMMANDER_TRACES_DIR — so a deployment
// that configured a trace directory silently wrote traces to one path and read
// them from another (zero-cost dashboards, empty observability timelines).

/**
 * Environment aliases that may configure the trace base directory.
 *
 * `COMMANDER_TRACE_DIR` is the deployed spelling (see
 * `deploy/helm/commander/templates/deployment.yaml`). `COMMANDER_TRACES_DIR` is
 * a historical alias retained for compatibility; when both are set they must
 * agree, otherwise resolution fails closed rather than picking one.
 */
export const TRACE_BASE_ENV_KEYS = ['COMMANDER_TRACE_DIR', 'COMMANDER_TRACES_DIR'] as const;

/** Raised when the configured trace directory is ambiguous or unusable. */
export class TraceConfigError extends Error {
  readonly code = 'TRACE_CONFIG_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'TraceConfigError';
  }
}

/**
 * Resolve the configured trace base directory.
 *
 * Contract:
 *  - A blank/whitespace-only value is treated as *unset*, never as a path.
 *  - When several aliases are set they must normalise to the same absolute
 *    path; otherwise this throws {@link TraceConfigError} (fail closed) instead
 *    of silently splitting writers and readers across two directories.
 *  - With nothing configured the legacy default `<cwd>/.commander_traces` is
 *    used, so existing single-process deployments are unaffected.
 *
 * Pure: creates no directory, constructs no recorder, reads no user file.
 */
export function resolveConfiguredTraceBase(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = new Map<string, string>();
  for (const key of TRACE_BASE_ENV_KEYS) {
    const raw = env[key];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    configured.set(path.resolve(cwd, trimmed), key);
  }
  if (configured.size > 1) {
    const keys = [...configured.values()].join(' and ');
    throw new TraceConfigError(
      `Conflicting trace directory configuration: ${keys} resolve to different absolute paths.`,
    );
  }
  const only = configured.keys().next().value;
  return only ?? path.join(cwd, '.commander_traces');
}

/**
 * Compose a trace base directory with the canonical per-tenant segment.
 *
 * Uses the same `tenant_<sanitized-id>` convention as every other tenant-scoped
 * store so a reader can never address a different tenant's directory than the
 * writer created.
 */
export function resolveTraceDir(baseDir: string, tenantId?: string): string {
  if (typeof tenantId !== 'string' || tenantId.length === 0) return baseDir;
  return path.join(baseDir, tenantPathSegment(tenantId));
}

/**
 * Surface the failures collected by a multi-buffer drain. A single failure is
 * re-thrown unchanged so callers can still match on its `code`; several are
 * aggregated rather than silently reduced to the first one.
 */
function throwCollected(errors: unknown[], what: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, `TraceStore: ${errors.length} ${what} failed to flush`);
}

export class PersistentTraceStore implements TraceStore {
  private baseDir: string;
  private buffers: Map<string, string[]> = new Map();
  private bufferTimestamps: Map<string, number> = new Map();
  private static readonly BUFFER_TTL_MS = 5 * 60_000; // 5 minutes
  private static readonly STALE_FLUSH_INTERVAL_MS = 60_000;
  private tenantId?: string;
  private staleFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * In-flight async drains, per run. Guarantees a single writer per ndjson
   * file so a concurrent sync flush or a second `flushAsync` cannot append the
   * same batch twice.
   */
  private asyncFlushes: Map<string, Promise<void>> = new Map();

  constructor(baseDir?: string, tenantId?: string) {
    this.tenantId = tenantId;
    const base = baseDir ?? resolveConfiguredTraceBase();
    this.baseDir = resolveTraceDir(base, tenantId);
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
      try {
        this.flush(key);
      } catch (e) {
        // The batch stays buffered — flush discards only committed events —
        // and the stale-flush timer keeps retrying it. A background append
        // must not turn a transient write error into a caller-visible
        // exception, but the failure is never treated as persisted either.
        getGlobalLogger().warn('TraceStore', 'Trace flush failed; events retained in buffer', {
          error: (e as Error)?.message,
          runId: key,
        });
      }
    }

    // Flush stale buffers periodically (not on every append to avoid O(n) scan)
    this.scheduleStaleFlush();
  }

  /**
   * Arm the periodic stale-buffer sweep. Re-armed after every sweep for as
   * long as anything is buffered, so a low-traffic buffer is still drained
   * once it passes {@link PersistentTraceStore.BUFFER_TTL_MS} instead of
   * waiting for the next append to install a fresh one-shot timer.
   */
  private scheduleStaleFlush(): void {
    if (this.staleFlushTimer) return;
    const timer = setTimeout(() => {
      if (this.staleFlushTimer === timer) this.staleFlushTimer = null;
      this.flushStaleBuffers();
      if (this.buffers.size > 0) this.scheduleStaleFlush();
    }, PersistentTraceStore.STALE_FLUSH_INTERVAL_MS);
    if (timer.unref) timer.unref();
    this.staleFlushTimer = timer;
  }

  private clearStaleFlushTimer(): void {
    if (!this.staleFlushTimer) return;
    clearTimeout(this.staleFlushTimer);
    this.staleFlushTimer = null;
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
    for (const [key, timestamp] of Array.from(this.bufferTimestamps)) {
      if (now - timestamp <= PersistentTraceStore.BUFFER_TTL_MS) continue;
      try {
        this.flush(key);
      } catch (e) {
        // Retained for the next sweep: a failed write is never treated as
        // persisted, and a timer callback must not throw.
        getGlobalLogger().warn('TraceStore', 'Stale trace flush failed; will retry', {
          error: (e as Error)?.message,
          runId: key,
        });
      }
    }
  }

  /** Drop exactly the events that were committed; anything newer stays buffered. */
  private commit(key: string, buffer: string[], count: number): void {
    buffer.splice(0, Math.min(count, buffer.length));
    if (buffer.length === 0) {
      this.buffers.delete(key);
      this.bufferTimestamps.delete(key);
    }
  }

  flush(runId: string): void {
    const key = sanitizeRunId(runId);
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.length === 0) return;
    // An async drain already owns this file — joining it is impossible
    // synchronously, and writing the same batch concurrently would duplicate
    // lines. The events stay buffered for the next drain.
    if (this.asyncFlushes.has(key)) return;

    const filePath = path.join(this.baseDir, `${key}.ndjson`);
    const batch = buffer.slice();
    try {
      if (!fs.existsSync(filePath)) {
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, batch.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmpPath, filePath);
      } else {
        fs.appendFileSync(filePath, batch.join('\n') + '\n', 'utf-8');
      }
    } catch (e) {
      getGlobalLogger().warn('TraceStore', 'Failed to flush trace buffer', {
        error: (e as Error)?.message,
        runId: key,
      });
      // Retain the batch (and its timestamp, so the sweep retries it) and
      // surface the failure instead of reporting a write that never happened.
      throw e;
    }
    this.commit(key, buffer, batch.length);
  }

  /**
   * Async variant of flush() — unblocks the event loop when draining many
   * run buffers concurrently (e.g. graceful shutdown of N parallel runs).
   * Tolerates the same ENOENT / EACCES semantics as the sync version.
   *
   * Rejects when the batch could not be written; the batch stays buffered so
   * that a later flush retries it.
   */
  async flushAsync(runId: string): Promise<void> {
    const key = sanitizeRunId(runId);

    // Join the current owner for this run rather than starting a second
    // writer; its failure is surfaced to this caller as well.
    const inFlight = this.asyncFlushes.get(key);
    if (inFlight) await inFlight;

    const buffer = this.buffers.get(key);
    if (!buffer || buffer.length === 0) return;

    const filePath = path.join(this.baseDir, `${key}.ndjson`);
    // Snapshot before the first await: events appended while this write is in
    // flight must not be deleted by this drain's commit.
    const batch = buffer.slice();

    const drain = (async () => {
      try {
        // Probe for existing file via fsp.access — faster than stat since
        // we only need the boolean, and cheaper than an extra existsSync.
        try {
          await fs.promises.access(filePath);
          await fs.promises.appendFile(filePath, batch.join('\n') + '\n', 'utf-8');
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          const tmpPath = `${filePath}.tmp`;
          await fs.promises.writeFile(tmpPath, batch.join('\n') + '\n', {
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
        throw e;
      }
      this.commit(key, buffer, batch.length);
    })();

    this.asyncFlushes.set(key, drain);
    try {
      await drain;
    } finally {
      if (this.asyncFlushes.get(key) === drain) this.asyncFlushes.delete(key);
    }
  }

  flushAll(): void {
    const errors: unknown[] = [];
    for (const key of Array.from(this.buffers.keys())) {
      try {
        this.flush(key);
      } catch (e) {
        errors.push(e);
      }
    }
    throwCollected(errors, 'trace buffers');
  }

  /** Async variant of flushAll — drains all buffered runs in parallel. */
  async flushAllAsync(): Promise<void> {
    const keys = Array.from(this.buffers.keys());
    const results = await Promise.allSettled(keys.map((k) => this.flushAsync(k)));
    const errors: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    throwCollected(errors, 'trace buffers');
  }

  // GAP-04: Graceful shutdown — flush all buffers and release the sweep timer.
  // A buffer that failed to flush is retained, never discarded as committed.
  shutdown(): void {
    this.clearStaleFlushTimer();
    try {
      this.flushAll();
    } finally {
      this.clearStaleFlushTimer();
    }
  }

  /** Async graceful shutdown — drains in parallel. */
  async shutdownAsync(): Promise<void> {
    this.clearStaleFlushTimer();
    try {
      await this.flushAllAsync();
    } finally {
      this.clearStaleFlushTimer();
    }
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
          getGlobalLogger().warn('TraceStore', 'Malformed trace data', {
            error: (e as Error)?.message,
            runId: key,
          });
          throw new Error(`TRACE_DATA_INVALID: malformed trace line for ${key}`);
        }
      }
      return events;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('TRACE_DATA_INVALID:')) throw e;
      getGlobalLogger().warn('TraceStore', 'Failed to read trace file', {
        error: (e as Error)?.message,
        runId: key,
      });
      throw new Error(`TRACE_READ_FAILED: unable to read trace ${key}`);
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
      throw new Error(`TRACE_READ_FAILED: unable to read trace ${key}`);
    }
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const events: TraceEvent[] = [];
    for (const line of trimmed.split('\n')) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        getGlobalLogger().warn('TraceStore', 'Malformed trace data (async)', {
          error: (e as Error)?.message,
          runId: key,
        });
        throw new Error(`TRACE_DATA_INVALID: malformed trace line for ${key}`);
      }
    }
    return events;
  }
}
