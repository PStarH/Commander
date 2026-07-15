/**
 * Event Sourcing Engine — optional file WAL + hash-chain integrity
 *
 * Implements the IEventSourcingEngine contract from Pillar I.
 *
 * Durability (honest):
 * - Constructor default: `walPath = null` → **in-memory only** (not durable).
 * - When `walPath` is set (or via `getGlobalEventSourcingEngine()`, which defaults
 *   to `.commander_state/event-sourcing.wal` or COMMANDER_EVENT_SOURCING_WAL):
 *   append-only NDJSON WAL with hash-chain + optional HMAC.
 * - Do not market "always durable WAL" without a configured path.
 *
 * Features when WAL-backed:
 * - Append-only log with hash-chain tamper-evidence (SHA-256)
 * - Snapshot creation for faster recovery
 * - Streaming replay via AsyncIterable
 * - Log compaction (trim events before a snapshot)
 *
 * Per constraint IF-05, provides deterministic event replay when WAL is configured.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { getMetricsCollector } from './metricsCollector';
import { getCurrentTenantId } from './tenantContext';
import { streamWalLines } from './walStream';
import { atomicWriteFile } from './atomicWrite';
import { StateContract, getSecurityPrimitives } from '../security/securityPrimitives';
import type { IEventSourcingEngine, IEvent } from '../contracts/pillarI';

// ============================================================================
// Types
// ============================================================================

interface StoredEvent extends IEvent {
  /** SHA-256 hash of (previousHash + serialized payload) */
  hash: string;
  /** Tenant ID captured at append time for replay-time filtering. */
  tenantId?: string;
  /** Optional HMAC signature over the event payload. Added when an integrity
   *  key is configured; absent for legacy/unprotected WAL files. */
  _sig?: string;
  _ts?: number;
}

interface Snapshot {
  id: string;
  timestamp: number;
  eventCount: number;
  lastEventHash: string;
  stateSummary: string;
}

// ============================================================================
// EventSourcingEngine Implementation
// ============================================================================

// Number of recent write latencies to retain for p95 calculation.
const WRITE_LATENCY_WINDOW = 200;

/** Default in-memory hot window; older WAL events are streamed from disk on replay. */
const DEFAULT_WAL_HOT_WINDOW = 2000;

function resolveWalHotWindow(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const env = process.env.COMMANDER_WAL_HOT_WINDOW;
  if (env !== undefined && env !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_WAL_HOT_WINDOW;
}

export interface EventSourcingEngineOptions {
  walPath?: string;
  /** Max events retained in RAM; 0 = unlimited (legacy load-all). */
  hotWindowSize?: number;
}
export class EventSourcingEngine implements IEventSourcingEngine {
  private events: StoredEvent[] = [];
  /** Total events in the WAL (hot window + cold segments on disk). */
  private totalEventCount = 0;
  private readonly hotWindowSize: number;
  private snapshots: Map<string, Snapshot> = new Map();
  private walPath: string | null;
  private lastHash: string = '';
  private writeLock: Promise<void> = Promise.resolve();
  private initialized = false;
  /** Incrementally tracked WAL file size in bytes (avoids per-append stat syscall). */
  private walSizeBytes = 0;
  /** Ring buffer of recent WAL append durations (ms) for p95 reporting. */
  private writeLatencies: number[] = [];
  private integrity = getSecurityPrimitives().integrity;

  constructor(options?: EventSourcingEngineOptions) {
    this.walPath = options?.walPath ?? null;
    this.hotWindowSize = resolveWalHotWindow(options?.hotWindowSize);
  }

  /** True only when a WAL path is configured (file-backed). In-memory is not durable. */
  isDurable(): boolean {
    return typeof this.walPath === 'string' && this.walPath.length > 0;
  }

  /** Resolved WAL path, or null when running in-memory. */
  getWalPath(): string | null {
    return this.walPath;
  }

  /** Push into the hot window and trim cold events from RAM. */
  private pushHot(event: StoredEvent): void {
    this.events.push(event);
    if (this.hotWindowSize > 0 && this.events.length > this.hotWindowSize) {
      this.events.shift();
    }
  }

  private parseStoredLine(line: string): StoredEvent | null {
    try {
      const event: StoredEvent = JSON.parse(line);
      if (event._sig) {
        const payload = {
          id: event.id,
          type: event.type,
          timestamp: event.timestamp,
          previousHash: event.previousHash,
          hash: event.hash,
          tenantId: event.tenantId,
          payload: event.payload,
        };
        const isValid = this.integrity.verify({
          data: { ...payload, _ts: event._ts },
          _sig: event._sig,
          _ts: event._ts ?? 0,
        });
        if (!isValid) {
          const integrityErr = new Error(`WAL integrity check failed for event ${event.id}`);
          getGlobalLogger().error(
            'EventSourcingEngine',
            'WAL integrity check failed',
            integrityErr,
            { eventId: event.id },
          );
          reportSilentFailure(integrityErr, 'eventSourcingEngine:parse:integrity');
          return null;
        }
      }
      return event;
    } catch (err) {
      reportSilentFailure(err, 'eventSourcingEngine:parse');
      return null;
    }
  }

  private stripStoredEvent(stored: StoredEvent): IEvent {
    const { hash: _h, tenantId: _t, _sig: _s, _ts: _ts, ...event } = stored;
    return { ...event };
  }

  private hotWindowOffset(): number {
    return Math.max(0, this.totalEventCount - this.events.length);
  }

  private async findEventIndex(eventId: string): Promise<number> {
    const hotIdx = this.events.findIndex((e) => e.id === eventId);
    if (hotIdx !== -1) return this.hotWindowOffset() + hotIdx;
    if (!this.walPath) return -1;
    let index = 0;
    for await (const { line } of streamWalLines(this.walPath)) {
      const event = this.parseStoredLine(line);
      if (!event) continue;
      if (event.id === eventId) return index;
      index++;
    }
    return -1;
  }

  /**
   * Initialize the WAL file if a path was configured.
   * Creates parent directories if needed.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (this.walPath) {
      const dir = path.dirname(this.walPath);
      try {
        await fs.promises.mkdir(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      // Segmented WAL load: track total count + last hash; retain only hot window in RAM.
      try {
        for await (const { line } of streamWalLines(this.walPath)) {
          const event = this.parseStoredLine(line);
          if (!event) continue;
          this.totalEventCount++;
          this.lastHash = event.hash;
          if (this.hotWindowSize === 0) {
            this.events.push(event);
          } else {
            this.pushHot(event);
          }
        }
        if (this.totalEventCount > 0) {
          getGlobalLogger().info('EventSourcingEngine', 'Loaded WAL events (segmented)', {
            total: this.totalEventCount,
            hotWindow: this.events.length,
          });
        }
        const stat = await fs.promises.stat(this.walPath);
        this.walSizeBytes = stat.size;
      } catch {
        // WAL file doesn't exist yet — will be created on first append
      }
    }
    // Publish initial gauges so /metrics reflects state before the first append
    this.publishMetrics();
  }

  /** Push current log dimensions + WAL size + write latency into MetricsCollector. */
  private publishMetrics(latencyMs?: number): void {
    const mc = getMetricsCollector();
    mc.setEventSourcingWalSize(this.walSizeBytes);
    mc.setEventSourcingTotals(this.totalEventCount, this.snapshots.size);
    if (latencyMs !== undefined) mc.recordEventSourcingWrite(latencyMs);
  }

  /**
   * Atomic append to the WAL.
   * Computes the hash chain and persists to disk (if configured).
   *
   * The prevHash snapshot, event ID generation, and hash computation all
   * happen INSIDE the writeLock callback. This is critical: if prevHash is
   * read outside the lock, two concurrent append() calls would both snapshot
   * the same lastHash, producing two events whose previousHash fields point
   * to the same predecessor — breaking the hash chain and causing
   * verifyIntegrity() to fail. Moving the entire chain-extension logic
   * inside the lock guarantees each append observes the correct predecessor.
   */
  async append(event: Omit<IEvent, 'id' | 'timestamp' | 'previousHash'>): Promise<IEvent> {
    const writeStart = Date.now();

    // Result holder — populated inside the lock callback, returned after.
    let resultEvent: IEvent | null = null;

    // Chain the write to ensure ordering. All chain-sensitive computation
    // (prevHash snapshot, id generation, hash computation) happens inside
    // the lock to prevent concurrent appends from corrupting the chain.
    this.writeLock = this.writeLock.then(async () => {
      const prevHash = this.lastHash;
      const timestamp = Date.now();
      const id = crypto.randomUUID();
      // Capture tenant at append time so replay can filter deterministically.
      const tenantId = getCurrentTenantId() ?? undefined;

      const fullEvent: IEvent = {
        ...event,
        id,
        timestamp,
        previousHash: prevHash || undefined,
      };

      // Compute hash: SHA-256(previousHash + type + id + timestamp + tenantId + serialized payload)
      // Including tenantId in the hash input prevents cross-tenant hash collisions
      // and ensures tamper-evidence covers the tenant attribution.
      const hashInput = `${prevHash}|${fullEvent.type}|${id}|${timestamp}|${tenantId ?? ''}|${JSON.stringify(fullEvent.payload)}`;
      const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

      const storedEvent: StoredEvent = { ...fullEvent, hash, tenantId };

      // IntegrityLayer: HMAC-sign the event payload when an integrity key is
      // configured. Legacy WAL lines without _sig remain loadable.
      if (process.env.COMMANDER_INTEGRITY_KEY || this.integrity) {
        const { _sig, _ts } = this.integrity.sign({
          id: storedEvent.id,
          type: storedEvent.type,
          timestamp: storedEvent.timestamp,
          previousHash: storedEvent.previousHash,
          hash: storedEvent.hash,
          tenantId: storedEvent.tenantId,
          payload: storedEvent.payload,
        });
        storedEvent._sig = _sig;
        storedEvent._ts = _ts;
      }

      // StateContract scope: WAL write is the side effect; if it fails we
      // roll back the in-memory event chain so memory and disk stay consistent.
      const scopeResult = await StateContract.useScope(
        () => {
          const eventsBefore = this.events.length;
          const totalBefore = this.totalEventCount;
          const lastHashBefore = this.lastHash;
          this.pushHot(storedEvent);
          this.totalEventCount++;
          this.lastHash = hash;
          return {
            state: { eventsBefore, totalBefore, lastHashBefore },
            commit: () => {
              /* memory state is already updated */
            },
            rollback: () => {
              this.events.length = eventsBefore;
              this.totalEventCount = totalBefore;
              this.lastHash = lastHashBefore;
            },
          };
        },
        async () => {
          if (this.walPath) {
            const line = JSON.stringify(storedEvent) + '\n';
            await fs.promises.appendFile(this.walPath, line, 'utf8');
            this.walSizeBytes += Buffer.byteLength(line, 'utf8');
          }
        },
      );

      if (!scopeResult.committed) {
        const err = new Error(scopeResult.error ?? 'WAL append rejected by StateContract');
        reportSilentFailure(err, 'eventSourcingEngine:append:stateContract');
        getGlobalLogger().error('EventSourcingEngine', 'WAL append rolled back', err, {
          eventId: id,
        });
      }

      resultEvent = { ...fullEvent };
    });

    await this.writeLock;

    // Record write latency for p95 health reporting
    const latency = Date.now() - writeStart;
    this.writeLatencies.push(latency);
    if (this.writeLatencies.length > WRITE_LATENCY_WINDOW) {
      this.writeLatencies.shift();
    }
    // Publish event-sourcing metrics (write latency + WAL size + totals)
    this.publishMetrics(latency);

    return resultEvent!;
  }

  /**
   * Wait for any in-flight WAL append to complete.
   * Used during test teardown and graceful shutdown.
   */
  async flush(): Promise<void> {
    await this.writeLock;
  }

  /**
   * Streaming read from a given event ID (for replay).
   * If no eventId given, reads from the beginning.
   * When a tenant context is active, only events appended by the same tenant
   * are yielded — preventing cross-tenant data exposure during replay.
   */
  async *readFrom(eventId?: string): AsyncIterable<IEvent> {
    const currentTenant = getCurrentTenantId() ?? undefined;
    let startIndex = 0;

    if (eventId) {
      const idx = await this.findEventIndex(eventId);
      if (idx === -1) {
        getGlobalLogger().warn('EventSourcingEngine', 'Event not found for replay', { eventId });
        return;
      }
      startIndex = idx;
    }

    const hotOffset = this.hotWindowOffset();
    let streamed = 0;

    if (this.walPath && startIndex < hotOffset) {
      let index = 0;
      for await (const { line } of streamWalLines(this.walPath)) {
        if (index < startIndex) {
          index++;
          continue;
        }
        if (index >= hotOffset) break;
        const stored = this.parseStoredLine(line);
        if (!stored) {
          index++;
          continue;
        }
        if (currentTenant && stored.tenantId && stored.tenantId !== currentTenant) {
          index++;
          continue;
        }
        yield this.stripStoredEvent(stored);
        streamed++;
        index++;
      }
    }

    const hotStart = Math.max(0, startIndex - hotOffset);
    for (let i = hotStart; i < this.events.length; i++) {
      const stored = this.events[i];
      if (currentTenant && stored.tenantId && stored.tenantId !== currentTenant) {
        continue;
      }
      yield this.stripStoredEvent(stored);
    }
    void streamed;
  }

  /**
   * Create a snapshot of current state for fast recovery.
   * Returns the snapshot ID.
   */
  async snapshot(): Promise<string> {
    const id = crypto.randomUUID();
    const lastHash = this.lastHash;
    const lastTimestamp = this.events[this.events.length - 1]?.timestamp ?? Date.now();

    const typeCounts: Record<string, number> = {};
    if (this.walPath) {
      for await (const { line } of streamWalLines(this.walPath)) {
        const e = this.parseStoredLine(line);
        if (e) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
      }
    } else {
      for (const e of this.events) {
        typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
      }
    }

    const snapshot: Snapshot = {
      id,
      timestamp: lastTimestamp,
      eventCount: this.totalEventCount,
      lastEventHash: lastHash,
      stateSummary: JSON.stringify(typeCounts),
    };

    this.snapshots.set(id, snapshot);
    getGlobalLogger().info('EventSourcingEngine', 'Snapshot created', {
      snapshotId: id,
      eventCount: this.totalEventCount,
    });
    // Refresh totals gauge so the new snapshot count is observable
    this.publishMetrics();

    return id;
  }

  /**
   * Verify hash-chain integrity of the entire log.
   * Recomputes all hashes and checks they match.
   */
  async verifyIntegrity(): Promise<boolean> {
    const chain: StoredEvent[] = [];
    if (this.walPath) {
      for await (const { line } of streamWalLines(this.walPath)) {
        const event = this.parseStoredLine(line);
        if (event) chain.push(event);
      }
    } else {
      chain.push(...this.events);
    }

    if (chain.length === 0) return true;

    let prevHash = '';

    for (let i = 0; i < chain.length; i++) {
      const event = chain[i];

      const expectedPrevHash = i === 0 ? '' : chain[i - 1].hash;
      if (event.previousHash !== expectedPrevHash && event.previousHash !== undefined) {
        if (event.previousHash !== (prevHash || undefined)) {
          getGlobalLogger().warn('EventSourcingEngine', 'Hash chain broken', {
            eventIndex: i,
            eventId: event.id,
          });
          return false;
        }
      }

      const stored = event as StoredEvent;
      const hashInput = `${prevHash}|${event.type}|${event.id}|${event.timestamp}|${stored.tenantId ?? ''}|${JSON.stringify(event.payload)}`;
      const computedHash = crypto.createHash('sha256').update(hashInput).digest('hex');

      if (computedHash !== event.hash) {
        getGlobalLogger().warn('EventSourcingEngine', 'Hash mismatch detected', {
          eventIndex: i,
          eventId: event.id,
          expected: event.hash,
          computed: computedHash,
        });
        return false;
      }

      prevHash = event.hash;
    }

    return true;
  }

  /**
   * Compact the log by removing events before a snapshot.
   * Returns the number of events removed.
   */
  async compact(snapshotId: string): Promise<number> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot '${snapshotId}' not found`);
    }

    const remaining: StoredEvent[] = [];
    let snapshotEventIndex = -1;
    let index = 0;

    if (this.walPath) {
      for await (const { line } of streamWalLines(this.walPath)) {
        const event = this.parseStoredLine(line);
        if (!event) continue;
        if (event.hash === snapshot.lastEventHash) {
          snapshotEventIndex = index;
        } else if (snapshotEventIndex !== -1) {
          remaining.push(event);
        }
        index++;
      }
    } else {
      snapshotEventIndex = this.events.findIndex((e) => e.hash === snapshot.lastEventHash);
      if (snapshotEventIndex !== -1) {
        remaining.push(...this.events.slice(snapshotEventIndex + 1));
      }
    }

    if (snapshotEventIndex === -1) {
      getGlobalLogger().warn('EventSourcingEngine', 'Snapshot event not found in log', {
        snapshotId,
      });
      return 0;
    }

    const removedCount = snapshotEventIndex + 1;

    // After compaction, the remaining events form a new chain starting from ''.
    // Re-hash the entire chain so verifyIntegrity() accepts the compacted log.
    let prevHash = '';
    for (let i = 0; i < remaining.length; i++) {
      const e = remaining[i];
      const hashInput = `${prevHash}|${e.type}|${e.id}|${e.timestamp}|${e.tenantId ?? ''}|${JSON.stringify(e.payload)}`;
      const newHash = crypto.createHash('sha256').update(hashInput).digest('hex');
      remaining[i] = {
        ...e,
        previousHash: prevHash || undefined,
        hash: newHash,
      };
      // Re-sign with HMAC if integrity key is configured
      if (process.env.COMMANDER_INTEGRITY_KEY || this.integrity) {
        const { _sig, _ts } = this.integrity.sign({
          id: remaining[i].id,
          type: remaining[i].type,
          timestamp: remaining[i].timestamp,
          previousHash: remaining[i].previousHash,
          hash: remaining[i].hash,
          tenantId: remaining[i].tenantId,
          payload: remaining[i].payload,
        });
        remaining[i]._sig = _sig;
        remaining[i]._ts = _ts;
      } else {
        delete remaining[i]._sig;
        delete remaining[i]._ts;
      }
      prevHash = newHash;
    }

    this.totalEventCount = remaining.length;
    this.events =
      this.hotWindowSize === 0
        ? remaining
        : remaining.slice(Math.max(0, remaining.length - this.hotWindowSize));
    this.lastHash = remaining[remaining.length - 1]?.hash ?? '';

    if (this.walPath) {
      try {
        const lines =
          remaining.map((e) => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : '');
        // REL-4: atomic WAL rewrite — an in-place writeFile that crashes mid-way
        // truncates the entire log and loses all events. Write → fsync → rename.
        await atomicWriteFile(this.walPath, lines);
        this.walSizeBytes = Buffer.byteLength(lines, 'utf8');
      } catch (err) {
        reportSilentFailure(err, 'eventSourcingEngine:compact:write');
        getGlobalLogger().error(
          'EventSourcingEngine',
          'WAL rewrite failed during compaction',
          err as Error,
          { snapshotId },
        );
      }
    }

    getGlobalLogger().info('EventSourcingEngine', 'Log compacted', {
      snapshotId,
      removedCount,
      remainingCount: this.totalEventCount,
    });
    this.publishMetrics();

    return removedCount;
  }

  /**
   * Get the total number of events in the log.
   */
  getEventCount(): number {
    return this.totalEventCount;
  }

  /**
   * Get a specific event by ID.
   */
  getEvent(eventId: string): IEvent | undefined {
    const hot = this.events.find((e) => e.id === eventId);
    if (hot) return this.stripStoredEvent(hot);
    return undefined;
  }

  /**
   * Async lookup that scans cold WAL segments when the event is not in the hot window.
   */
  async getEventAsync(eventId: string): Promise<IEvent | undefined> {
    const hot = this.getEvent(eventId);
    if (hot) return hot;
    if (!this.walPath) return undefined;
    for await (const { line } of streamWalLines(this.walPath)) {
      const stored = this.parseStoredLine(line);
      if (stored?.id === eventId) return this.stripStoredEvent(stored);
    }
    return undefined;
  }

  /**
   * Get all snapshots.
   */
  getSnapshots(): Snapshot[] {
    return [...this.snapshots.values()];
  }

  /**
   * Replay events from the log, applying a handler to each.
   * Useful for state reconstruction.
   */
  async replay(
    handler: (event: IEvent) => void | Promise<void>,
    fromEventId?: string,
  ): Promise<number> {
    let count = 0;
    for await (const event of this.readFrom(fromEventId)) {
      await handler(event);
      count++;
    }
    return count;
  }

  /**
   * Get all events matching a correlationId (typically a runId).
   * Used by DeterminismCapture.restoreFromWAL() to rebuild in-memory
   * capture state after a process crash, enabling Path A replay recovery.
   */
  getEventsByCorrelationId(correlationId: string): IEvent[] {
    const result: IEvent[] = [];
    const seen = new Set<string>();

    const collect = (e: StoredEvent) => {
      if (e.correlationId !== correlationId || seen.has(e.id)) return;
      seen.add(e.id);
      result.push(this.stripStoredEvent(e));
    };

    if (this.walPath) {
      try {
        const data = fs.readFileSync(this.walPath, 'utf8');
        for (const line of data.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const e = this.parseStoredLine(trimmed);
          if (e) collect(e);
        }
      } catch {
        for (const e of this.events) collect(e);
      }
    } else {
      for (const e of this.events) collect(e);
    }
    return result;
  }

  /** Async variant — streams cold segments without a full-file read. */
  async getEventsByCorrelationIdAsync(correlationId: string): Promise<IEvent[]> {
    const result: IEvent[] = [];
    const seen = new Set<string>();

    const collect = (e: StoredEvent) => {
      if (e.correlationId !== correlationId || seen.has(e.id)) return;
      seen.add(e.id);
      result.push(this.stripStoredEvent(e));
    };

    if (this.walPath) {
      for await (const { line } of streamWalLines(this.walPath)) {
        const e = this.parseStoredLine(line);
        if (e) collect(e);
      }
    } else {
      for (const e of this.events) collect(e);
    }
    return result;
  }

  /**
   * p95 of recent WAL append latencies (ms), or null if no writes recorded.
   * Used by eventSourcingHealth to report write-latency degradation.
   */
  getWriteLatencyP95(): number | null {
    if (this.writeLatencies.length === 0) return null;
    const sorted = [...this.writeLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return sorted[idx];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalEventSourcingEngine: EventSourcingEngine | null = null;

export function getGlobalEventSourcingEngine(options?: { walPath?: string }): EventSourcingEngine {
  if (!globalEventSourcingEngine) {
    const walPath =
      options?.walPath ??
      (typeof process !== 'undefined' ? process.env?.COMMANDER_EVENT_SOURCING_WAL : undefined) ??
      null;

    // Default WAL path: <cwd>/.commander_state/event-sourcing.wal
    const resolvedWalPath =
      walPath ??
      (typeof process !== 'undefined'
        ? path.join(process.cwd(), '.commander_state', 'event-sourcing.wal')
        : null);

    globalEventSourcingEngine = new EventSourcingEngine({
      walPath: resolvedWalPath ?? undefined,
    });
  }
  return globalEventSourcingEngine;
}

/** Reset the global singleton — for test isolation only.
 *  Awaits any pending WAL writes so temp directories can be cleaned up. */
export async function resetGlobalEventSourcingEngine(): Promise<void> {
  const engine = globalEventSourcingEngine;
  if (engine) {
    await engine.flush();
  }
  globalEventSourcingEngine = null;
}
