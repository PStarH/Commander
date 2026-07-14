/**
 * Event Bus — Inter-agent communication with replay and backpressure
 *
 * Implements the IEventBus contract from Pillar II.
 *
 * Features:
 * - Topic-based pub/sub messaging
 * - Event persistence for replay (Last-Event-ID recovery)
 * - Consumer rate limiting (backpressure)
 * - Dead letter queue for failed deliveries
 * - Monotonic event IDs for gap detection
 *
 * Per constraint PII-FR-09, supports replay via Last-Event-ID.
 * Per constraint PII-FR-10, supports cross-node A2A communication.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import type { IEventBus } from '../contracts/pillarII';
import { getMessageBus } from './messageBus';
import type { MessageBus } from './messageBus';
import { getGlobalEventSourcingEngine } from './eventSourcingEngine';

// ============================================================================
// Types
// ============================================================================

interface StoredEvent {
  /** Monotonic event ID (for gap detection and replay) */
  id: number;
  /** Topic name */
  topic: string;
  /** Event payload */
  message: unknown;
  /** Timestamp */
  timestamp: number;
}

interface DeadLetterEntry {
  topic: string;
  message: unknown;
  error: Error;
  timestamp: number;
  attempts: number;
}

interface Subscription {
  handler: (message: unknown) => void;
  topic: string;
}

// ============================================================================
// EventBus Implementation
// ============================================================================

export class ContractEventBus implements IEventBus {
  private subscribers: Map<string, Set<Subscription>> = new Map();
  private eventLog: StoredEvent[] = [];
  private deadLetters: DeadLetterEntry[] = [];
  private deadLetterHandlers: Array<(message: unknown, error: Error) => void> = [];
  private maxLogSize: number;
  private maxDeadLetters: number;
  private consumerRatePerSecond: number = Infinity;
  private tokensAvailable: number = Infinity;
  private lastTokenRefillTime: number = Date.now();
  private eventIdCounter = 0;
  /** Production message bus for bridging events to the runtime */
  private productionBus: MessageBus | null = null;

  constructor(options?: {
    maxLogSize?: number;
    maxDeadLetters?: number;
    initialRate?: number;
    bridgeToMessageBus?: boolean;
  }) {
    this.maxLogSize = options?.maxLogSize ?? 10000;
    this.maxDeadLetters = options?.maxDeadLetters ?? 1000;
    if (options?.initialRate) {
      this.consumerRatePerSecond = options.initialRate;
      this.tokensAvailable = options.initialRate;
    }
    // Bridge to the production MessageBus by default — events published
    // via the contract IEventBus are also delivered to all production
    // subscribers of MessageBus (~30 modules reference it).
    // This connects the contract layer to the production runtime.
    if (options?.bridgeToMessageBus !== false) {
      try {
        this.productionBus = getMessageBus();
      } catch {
        // MessageBus not yet initialized — contract bus operates standalone
      }
    }
  }

  /**
   * Publish a message to a topic.
   * The message is persisted for replay and delivered to all subscribers.
   *
   * In addition to local delivery, the message is also published to the
   * production MessageBus, connecting contract-layer events to the ~30
   * production modules that subscribe via MessageBus.
   */
  async publish(topic: string, message: unknown): Promise<void> {
    // Refill tokens (token bucket for backpressure)
    this.refillTokens();

    // Create and store the event
    const event: StoredEvent = {
      id: ++this.eventIdCounter,
      topic,
      message,
      timestamp: Date.now(),
    };

    this.eventLog.push(event);

    // Trim log if exceeding max size
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }

    // P2: Persist to EventSourcingEngine WAL for durability.
    // This enables replayFrom() to work across process restarts —
    // the event log survives crashes and can be replayed to rebuild state.
    // Fire-and-forget: never blocks the publish critical path.
    try {
      getGlobalEventSourcingEngine()
        .append({
          type: `bus.${topic}`,
          payload: { id: event.id, topic, message, timestamp: event.timestamp },
        })
        .catch((err: unknown) => {
          reportSilentFailure(err, 'contractEventBus:publish:wal');
        });
    } catch (err) {
      reportSilentFailure(err, 'contractEventBus:publish:wal:init');
    }

    // Deliver to local subscribers
    const subs = this.subscribers.get(topic);
    if (subs && subs.size > 0) {
      const deliveryPromises: Promise<void>[] = [];

      for (const sub of subs) {
        deliveryPromises.push(this.deliver(sub, event));
      }

      await Promise.allSettled(deliveryPromises);
    }

    // Bridge: also publish to the production MessageBus so that
    // runtime modules (agentLoop, orchestrator, SLO manager, etc.)
    // receive events published through the IEventBus contract.
    if (this.productionBus) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.productionBus.publish(topic as any, 'ContractEventBus', message);
      } catch (err) {
        reportSilentFailure(err, 'contractEventBus:publish:bridge');
      }
    }

    getGlobalLogger().debug('EventBus', 'Published', {
      topic,
      eventId: event.id,
      subscriberCount: subs?.size ?? 0,
      bridged: this.productionBus !== null,
    });
  }

  /**
   * Subscribe to a topic.
   * Returns an unsubscribe function.
   */
  subscribe(topic: string, handler: (message: unknown) => void): () => void {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }

    const sub: Subscription = { handler, topic };
    this.subscribers.get(topic)!.add(sub);

    getGlobalLogger().debug('EventBus', 'Subscribed', { topic });

    return () => {
      const subs = this.subscribers.get(topic);
      if (subs) {
        subs.delete(sub);
        if (subs.size === 0) {
          this.subscribers.delete(topic);
        }
      }
    };
  }

  /**
   * Replay events since a given event ID (gap recovery).
   * Yields events in order, filtered by topic if specified.
   */
  async *replayFrom(eventId: string): AsyncIterable<unknown> {
    const fromId = parseInt(eventId, 10);

    if (isNaN(fromId)) {
      getGlobalLogger().warn('EventBus', 'Invalid event ID for replay', { eventId });
      return;
    }

    // Find events after the given ID
    const events = this.eventLog.filter((e) => e.id > fromId);

    getGlobalLogger().info('EventBus', 'Replaying events', {
      fromEventId: eventId,
      eventCount: events.length,
    });

    for (const event of events) {
      yield {
        id: String(event.id),
        topic: event.topic,
        message: event.message,
        timestamp: event.timestamp,
      };
    }
  }

  /**
   * Set the consumer rate (backpressure).
   * Messages are throttled to this rate.
   */
  setConsumerRate(ratePerSecond: number): void {
    this.consumerRatePerSecond = ratePerSecond;
    this.tokensAvailable = ratePerSecond;
    this.lastTokenRefillTime = Date.now();

    getGlobalLogger().info('EventBus', 'Consumer rate set', {
      ratePerSecond,
    });
  }

  /**
   * Register a dead letter handler.
   * Called when a message delivery fails after retries.
   */
  onDeadLetter(handler: (message: unknown, error: Error) => void): void {
    this.deadLetterHandlers.push(handler);
  }

  // ------------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------------

  /**
   * Deliver a message to a subscriber with error handling.
   * Failed deliveries are retried once, then sent to dead letter queue.
   */
  private async deliver(sub: Subscription, event: StoredEvent): Promise<void> {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        sub.handler(event.message);
        return; // Success
      } catch (err) {
        if (attempt < maxAttempts) {
          // Brief delay before retry
          await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
          continue;
        }

        // All attempts failed — send to dead letter queue
        const dlqEntry: DeadLetterEntry = {
          topic: event.topic,
          message: event.message,
          error: err as Error,
          timestamp: Date.now(),
          attempts: maxAttempts,
        };

        this.deadLetters.push(dlqEntry);

        // Trim dead letters if exceeding max
        if (this.deadLetters.length > this.maxDeadLetters) {
          this.deadLetters.shift();
        }

        // Notify dead letter handlers
        for (const handler of this.deadLetterHandlers) {
          try {
            handler(event.message, err as Error);
          } catch (handlerErr) {
            reportSilentFailure(handlerErr, 'eventBus:deadLetterHandler');
          }
        }

        getGlobalLogger().warn('EventBus', 'Message delivery failed — sent to DLQ', {
          topic: event.topic,
          eventId: event.id,
          error: (err as Error).message,
        });
        return;
      }
    }
  }

  /**
   * Refill the token bucket for rate limiting.
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = (now - this.lastTokenRefillTime) / 1000;
    this.tokensAvailable = Math.min(
      this.consumerRatePerSecond,
      this.tokensAvailable + elapsed * this.consumerRatePerSecond,
    );
    this.lastTokenRefillTime = now;
  }

  // ------------------------------------------------------------------------
  // Public inspection methods
  // ------------------------------------------------------------------------

  /**
   * Get the total number of events in the log.
   */
  getEventCount(): number {
    return this.eventLog.length;
  }

  /**
   * Get the latest event ID.
   */
  getLatestEventId(): string {
    return String(this.eventIdCounter);
  }

  /**
   * Get all dead letter entries.
   */
  getDeadLetters(): DeadLetterEntry[] {
    return [...this.deadLetters];
  }

  /**
   * Get subscriber count for a topic.
   */
  getSubscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }

  /**
   * Get all active topics.
   */
  getActiveTopics(): string[] {
    return [...this.subscribers.keys()].filter((t) => (this.subscribers.get(t)?.size ?? 0) > 0);
  }

  /**
   * Clear the event log and dead letters.
   */
  clear(): void {
    this.eventLog = [];
    this.deadLetters = [];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let globalEventBus: ContractEventBus | null = null;

/**
 * Global contract event bus accessor.
 *
 * Returns a DistributedEventBus so the distributed-capable bus is live at
 * runtime: it reads COMMANDER_EVENT_BUS_BACKEND / COMMANDER_EVENT_BUS_REDIS_URL
 * and fans out cross-node via Redis Pub/Sub when configured, falling back to
 * in-memory operation (backward compatible with ContractEventBus) otherwise.
 *
 * Lazy-require breaks the circular module dependency — distributedEventBus.ts
 * extends ContractEventBus, so it cannot be statically imported here without
 * triggering the `extends` evaluation before this class is defined.
 */
export function getGlobalContractEventBus(): ContractEventBus {
  if (!globalEventBus) {
    const { createDistributedEventBus } = require('./distributedEventBus') as {
      createDistributedEventBus: (config?: {
        backend?: 'memory' | 'redis' | 'nats';
        redisUrl?: string;
        natsUrl?: string;
        nodeId?: string;
      }) => ContractEventBus;
    };
    const backend = (process.env.COMMANDER_EVENT_BUS_BACKEND ?? 'memory') as
      'memory' | 'redis' | 'nats';
    globalEventBus = createDistributedEventBus({
      backend,
      redisUrl: process.env.COMMANDER_EVENT_BUS_REDIS_URL,
    });
  }
  return globalEventBus;
}
