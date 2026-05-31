/**
 * Message Bus — Event-driven inter-agent communication.
 *
 * Agents can publish messages on topics and subscribe to receive messages.
 * Used for coordination, handoffs, alerts, and state synchronization.
 */

import type {
  BusMessage, MessageBusTopic, MessageHandler, MessagePriority,
  BusPayloadMap, TypedBusMessage,
} from './types';
import { getGlobalLogger } from '../logging';

function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export class MessageBus {
  private subscribers: Map<MessageBusTopic, Set<MessageHandler>> = new Map();
  // Ring buffer for history — O(1) push/evict instead of O(n) shift
  private history: BusMessage[] = [];
  private historyHead = 0; // next write position
  private historyCount = 0; // current number of entries
  private maxHistory: number;
  private topics: Set<MessageBusTopic> = new Set();
  // GAP-23: Track last publish time per topic for pruning
  private topicLastActive: Map<MessageBusTopic, number> = new Map();
  // Wildcard subscriber flag — skip wildcard dispatch when no wildcard subscribers exist
  private hasWildcardSubscribers = false;
  // Topic-indexed history — ring buffer per topic for O(1) insert/evict
  private topicHistory: Map<MessageBusTopic, { buf: BusMessage[]; head: number; count: number }> = new Map();
  private readonly MAX_TOPICS = 200;
  private readonly TOPIC_IDLE_TTL_MS = 3600_000; // 1 hour

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  /**
   * Publish to a known topic — payload and return type are typed.
   */
  publish<T extends keyof BusPayloadMap>(
    topic: T,
    source: string,
    payload: BusPayloadMap[T],
    options?: {
      target?: string;
      priority?: MessagePriority;
      ttl?: number;
    },
  ): TypedBusMessage<T>;
  /**
   * Publish to an arbitrary topic — payload is unknown.
   */
  publish(
    topic: MessageBusTopic,
    source: string,
    payload: unknown,
    options?: {
      target?: string;
      priority?: MessagePriority;
      ttl?: number;
    },
  ): BusMessage;
  publish(
    topic: MessageBusTopic,
    source: string,
    payload: unknown,
    options?: {
      target?: string;
      priority?: MessagePriority;
      ttl?: number;
    },
  ): BusMessage {
    const now = Date.now();
    const message: BusMessage = {
      id: generateId(),
      topic,
      source,
      target: options?.target,
      payload,
      priority: options?.priority ?? 'normal',
      timestamp: new Date(now).toISOString(),
      ttl: options?.ttl,
    };

    this.topics.add(topic);
    this.topicLastActive.set(topic, now);

    // Ring buffer: O(1) insert, O(1) evict
    if (this.historyCount < this.maxHistory) {
      this.history[this.historyHead] = message;
      this.historyHead = (this.historyHead + 1) % this.maxHistory;
      this.historyCount++;
    } else {
      // Overwrite oldest entry
      this.history[this.historyHead] = message;
      this.historyHead = (this.historyHead + 1) % this.maxHistory;
    }

    // Topic-indexed history — ring buffer for O(1) insert/evict
    let topicEntry = this.topicHistory.get(topic);
    if (!topicEntry) {
      topicEntry = { buf: new Array(Math.min(this.maxHistory, 100)), head: 0, count: 0 };
      this.topicHistory.set(topic, topicEntry);
    }
    const maxTopic = topicEntry.buf.length;
    if (topicEntry.count < maxTopic) {
      topicEntry.buf[topicEntry.head] = message;
      topicEntry.head = (topicEntry.head + 1) % maxTopic;
      topicEntry.count++;
    } else {
      topicEntry.buf[topicEntry.head] = message;
      topicEntry.head = (topicEntry.head + 1) % maxTopic;
    }

    // GAP-23: Prune idle topics when count exceeds limit
    if (this.topics.size > this.MAX_TOPICS) {
      this.pruneIdleTopics();
    }

    const handlers = this.subscribers.get(topic);
    if (handlers) {
      for (const handler of handlers) {
        try {
          const result = handler(message);
          if (result instanceof Promise) {
            result.catch(err => getGlobalLogger().error('MessageBus', `handler error on ${topic}`, err));
          }
        } catch (err) {
          getGlobalLogger().error('MessageBus', `handler error on ${topic}`, err as Error);
        }
      }
    }

    // Only check wildcard handlers if any exist
    if (this.hasWildcardSubscribers && topic !== '*') {
      const wildcardHandlers = this.subscribers.get('*' as MessageBusTopic);
      if (wildcardHandlers) {
        for (const handler of wildcardHandlers) {
          try {
            const result = handler(message);
            if (result instanceof Promise) {
              result.catch(err => getGlobalLogger().error('MessageBus', `handler error on ${topic}`, err));
            }
          } catch (err) {
            getGlobalLogger().error('MessageBus', `handler error on ${topic}`, err as Error);
          }
        }
      }
    }

    return message;
  }

  /**
   * Subscribe to a known topic — handler receives typed payload.
   */
  subscribe<T extends keyof BusPayloadMap>(
    topic: T,
    handler: (message: TypedBusMessage<T>) => void | Promise<void>,
  ): () => void;
  /**
   * Subscribe to an arbitrary topic — payload is unknown.
   */
  subscribe(
    topic: MessageBusTopic,
    handler: MessageHandler,
  ): () => void;
  subscribe(
    topic: MessageBusTopic,
    handler: MessageHandler,
  ): () => void {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    this.subscribers.get(topic)!.add(handler);
    this.topics.add(topic);

    // Track wildcard subscribers
    if (topic === '*') this.hasWildcardSubscribers = true;

    return () => {
      const subs = this.subscribers.get(topic);
      if (subs) {
        subs.delete(handler);
        if (subs.size === 0) {
          this.subscribers.delete(topic);
          this.topics.delete(topic);
          this.topicHistory.delete(topic);
          this.topicLastActive.delete(topic);
        }
      }
      if (topic === '*' && (this.subscribers.get('*')?.size ?? 0) === 0) {
        this.hasWildcardSubscribers = false;
      }
    };
  }

  /**
   * Subscribe to multiple topics at once.
   */
  subscribeMany(topics: MessageBusTopic[], handler: MessageHandler): () => void {
    const unsubs = topics.map(t => this.subscribe(t, handler));
    return () => unsubs.forEach(fn => fn());
  }

  /**
   * Get message history for a specific topic or all topics.
   */
  getHistory(topic?: MessageBusTopic, limit?: number): BusMessage[] {
    let filtered: BusMessage[];
    if (topic) {
      // O(1) topic lookup via ring buffer index
      const entry = this.topicHistory.get(topic);
      if (!entry) return [];
      filtered = [];
      for (let i = 0; i < entry.count; i++) {
        const idx = (entry.head - entry.count + i + entry.buf.length) % entry.buf.length;
        filtered.push(entry.buf[idx]);
      }
      if (limit && limit > 0) {
        filtered = filtered.slice(-limit);
      }
      return filtered;
    }

    // No topic filter: reconstruct from ring buffer
    filtered = [];
    for (let i = 0; i < this.historyCount; i++) {
      const idx = (this.historyHead - this.historyCount + i + this.maxHistory) % this.maxHistory;
      filtered.push(this.history[idx]);
    }

    if (limit && limit > 0) {
      filtered = filtered.slice(-limit);
    }
    return filtered;
  }

  /**
   * Get the list of topics that have been published to.
   */
  getActiveTopics(): MessageBusTopic[] {
    return Array.from(this.topics);
  }

  /**
   * Get subscriber count per topic.
   */
  getSubscriberCount(topic: MessageBusTopic): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }

  /**
   * Get all subscriber counts.
   */
  getAllSubscriberCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [topic, handlers] of this.subscribers) {
      counts[topic] = handlers.size;
    }
    return counts;
  }

  /**
   * Clear message history.
   */
  clearHistory(): void {
    this.history = [];
    this.historyHead = 0;
    this.historyCount = 0;
    this.topicHistory.clear();
  }

  /** GAP-23: Prune topics with no subscribers and no recent activity. */
  private pruneIdleTopics(): void {
    const now = Date.now();
    for (const topic of this.topics) {
      const lastActive = this.topicLastActive.get(topic) ?? 0;
      const hasSubscribers = (this.subscribers.get(topic)?.size ?? 0) > 0;
      if (!hasSubscribers && now - lastActive > this.TOPIC_IDLE_TTL_MS) {
        this.topics.delete(topic);
        this.topicLastActive.delete(topic);
        this.topicHistory.delete(topic);
      }
    }
  }

  /**
   * Remove all subscribers for a topic.
   */
  clearSubscribers(topic?: MessageBusTopic): void {
    if (topic) {
      this.subscribers.delete(topic);
    } else {
      this.subscribers.clear();
    }
  }
}

import { createTenantAwareSingleton } from './tenantAwareSingleton';

const messageBusSingleton = createTenantAwareSingleton(() => new MessageBus(), {
  dispose: (bus) => bus.clearSubscribers(),
});

/** Get the global MessageBus (single-tenant) or tenant-scoped (multi-tenant). */
export function getMessageBus(): MessageBus {
  return messageBusSingleton.get();
}

/** Reset the message bus singleton (for test isolation). */
export function resetMessageBus(): void {
  messageBusSingleton.reset();
}
