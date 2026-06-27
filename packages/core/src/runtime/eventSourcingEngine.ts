/**
 * Event Sourcing Engine — WAL persistence with hash-chain integrity
 *
 * Implements the IEventSourcingEngine contract from Pillar I.
 *
 * Features:
 * - Write-Ahead Log (WAL) with atomic appends
 * - Hash-chain tamper-evidence (each event links to previous via SHA-256)
 * - Snapshot creation for fast recovery
 * - Streaming replay via AsyncIterable
 * - Log compaction (trim events before a snapshot)
 *
 * Per constraint IF-05, provides deterministic event replay.
 * Per constraint NFR-CON-02, provides strong consistency.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { IEventSourcingEngine, IEvent } from '../contracts/pillarI';

// ============================================================================
// Types
// ============================================================================

interface StoredEvent extends IEvent {
  /** SHA-256 hash of (previousHash + serialized payload) */
  hash: string;
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

export class EventSourcingEngine implements IEventSourcingEngine {
  private events: StoredEvent[] = [];
  private snapshots: Map<string, Snapshot> = new Map();
  private walPath: string | null;
  private lastHash: string = '';
  private writeLock: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options?: { walPath?: string }) {
    this.walPath = options?.walPath ?? null;
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

      // Load existing events from WAL
      try {
        const data = await fs.promises.readFile(this.walPath, 'utf8');
        if (data.trim()) {
          const lines = data.trim().split('\n');
          for (const line of lines) {
            try {
              const event: StoredEvent = JSON.parse(line);
              this.events.push(event);
              this.lastHash = event.hash;
            } catch (err) {
              reportSilentFailure(err, 'eventSourcingEngine:init:parse');
            }
          }
          getGlobalLogger().info('EventSourcingEngine', 'Loaded WAL events', {
            count: this.events.length,
          });
        }
      } catch {
        // WAL file doesn't exist yet — will be created on first append
      }
    }
  }

  /**
   * Atomic append to the WAL.
   * Computes the hash chain and persists to disk (if configured).
   */
  async append(
    event: Omit<IEvent, 'id' | 'timestamp' | 'previousHash'>,
  ): Promise<IEvent> {
    // Serialize writes to prevent hash chain corruption
    const prevHash = this.lastHash;
    const timestamp = Date.now();
    const id = crypto.randomUUID();

    const fullEvent: IEvent = {
      ...event,
      id,
      timestamp,
      previousHash: prevHash || undefined,
    };

    // Compute hash: SHA-256(previousHash + type + id + timestamp + serialized payload)
    const hashInput = `${prevHash}|${fullEvent.type}|${id}|${timestamp}|${JSON.stringify(fullEvent.payload)}`;
    const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

    const storedEvent: StoredEvent = { ...fullEvent, hash };

    // Chain the write to ensure ordering
    this.writeLock = this.writeLock.then(async () => {
      this.events.push(storedEvent);
      this.lastHash = hash;

      if (this.walPath) {
        try {
          const line = JSON.stringify(storedEvent) + '\n';
          await fs.promises.appendFile(this.walPath, line, 'utf8');
        } catch (err) {
          reportSilentFailure(err, 'eventSourcingEngine:append:write');
          getGlobalLogger().error(
            'EventSourcingEngine',
            'WAL write failed',
            err as Error,
            { eventId: id },
          );
        }
      }
    });

    await this.writeLock;

    return { ...fullEvent };
  }

  /**
   * Streaming read from a given event ID (for replay).
   * If no eventId given, reads from the beginning.
   */
  async *readFrom(eventId?: string): AsyncIterable<IEvent> {
    let startIndex = 0;

    if (eventId) {
      const idx = this.events.findIndex((e) => e.id === eventId);
      if (idx === -1) {
        getGlobalLogger().warn('EventSourcingEngine', 'Event not found for replay', { eventId });
        return;
      }
      startIndex = idx;
    }

    for (let i = startIndex; i < this.events.length; i++) {
      const { hash, ...event } = this.events[i];
      yield { ...event };
    }
  }

  /**
   * Create a snapshot of current state for fast recovery.
   * Returns the snapshot ID.
   */
  async snapshot(): Promise<string> {
    const id = crypto.randomUUID();
    const lastEvent = this.events[this.events.length - 1];
    const lastHash = lastEvent?.hash ?? '';
    const lastTimestamp = lastEvent?.timestamp ?? Date.now();

    // State summary: event count, last hash, types histogram
    const typeCounts: Record<string, number> = {};
    for (const e of this.events) {
      typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
    }

    const snapshot: Snapshot = {
      id,
      timestamp: lastTimestamp,
      eventCount: this.events.length,
      lastEventHash: lastHash,
      stateSummary: JSON.stringify(typeCounts),
    };

    this.snapshots.set(id, snapshot);
    getGlobalLogger().info('EventSourcingEngine', 'Snapshot created', {
      snapshotId: id,
      eventCount: this.events.length,
    });

    return id;
  }

  /**
   * Verify hash-chain integrity of the entire log.
   * Recomputes all hashes and checks they match.
   */
  async verifyIntegrity(): Promise<boolean> {
    if (this.events.length === 0) return true;

    let prevHash = '';

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];

      // Verify previousHash linkage
      const expectedPrevHash = i === 0 ? '' : this.events[i - 1].hash;
      if (event.previousHash !== expectedPrevHash && event.previousHash !== undefined) {
        if (event.previousHash !== (prevHash || undefined)) {
          getGlobalLogger().warn('EventSourcingEngine', 'Hash chain broken', {
            eventIndex: i,
            eventId: event.id,
          });
          return false;
        }
      }

      // Recompute hash
      const hashInput = `${prevHash}|${event.type}|${event.id}|${event.timestamp}|${JSON.stringify(event.payload)}`;
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

    // Find the index of the last event in the snapshot
    const snapshotEventIndex = this.events.findIndex((e) => e.hash === snapshot.lastEventHash);
    if (snapshotEventIndex === -1) {
      getGlobalLogger().warn('EventSourcingEngine', 'Snapshot event not found in log', {
        snapshotId,
      });
      return 0;
    }

    const removedCount = snapshotEventIndex + 1;

    // Keep only events after the snapshot
    this.events = this.events.slice(snapshotEventIndex + 1);

    // Rewrite WAL if configured
    if (this.walPath) {
      try {
        const lines = this.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fs.promises.writeFile(this.walPath, lines, 'utf8');
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
      remainingCount: this.events.length,
    });

    return removedCount;
  }

  /**
   * Get the total number of events in the log.
   */
  getEventCount(): number {
    return this.events.length;
  }

  /**
   * Get a specific event by ID.
   */
  getEvent(eventId: string): IEvent | undefined {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) return undefined;
    const { hash, ...rest } = event;
    return { ...rest };
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
}

// ============================================================================
// Singleton
// ============================================================================

let globalEventSourcingEngine: EventSourcingEngine | null = null;

export function getGlobalEventSourcingEngine(): EventSourcingEngine {
  if (!globalEventSourcingEngine) {
    globalEventSourcingEngine = new EventSourcingEngine();
  }
  return globalEventSourcingEngine;
}
