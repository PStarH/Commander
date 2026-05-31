/**
 * Mailbox implementation for the Actor Model.
 *
 * Each actor has a mailbox that buffers incoming messages.
 * Features:
 * - Priority queue processing (higher priority messages first)
 * - Backpressure with configurable overflow protection
 * - Message deduplication by correlationId
 * - Message expiry for stale messages
 * - System messages bypass capacity limits
 */

import type {
  ActorMessage,
  ActorId,
  ActorLogger,
  MailboxConfig,
  MailboxEntry,
  DEFAULT_MAILBOX_CONFIG,
} from './types';

/**
 * Mailbox for an actor.
 * Handles message buffering, prioritization, and backpressure.
 */
export class Mailbox {
  private readonly actorId: ActorId;
  private readonly config: MailboxConfig;
  private readonly logger: ActorLogger;
  private readonly queue: MailboxEntry[] = [];
  private readonly seenCorrelationIds = new Set<string>();
  private processing = false;
  private readonly onMessage: (message: ActorMessage) => Promise<void>;

  constructor(
    actorId: ActorId,
    config: MailboxConfig,
    logger: ActorLogger,
    onMessage: (message: ActorMessage) => Promise<void>,
  ) {
    this.actorId = actorId;
    this.config = config;
    this.logger = logger;
    this.onMessage = onMessage;
  }

  /**
   * Enqueue a message into the mailbox.
   * Returns false if message was dropped due to backpressure.
   */
  enqueue(message: ActorMessage, priority = this.config.defaultPriority): boolean {
    if (this.config.deduplication && message.correlationId) {
      if (this.seenCorrelationIds.has(message.correlationId)) {
        this.logger.debug('Dropping duplicate message', {
          messageId: message.id,
          correlationId: message.correlationId,
        });
        return false;
      }
      this.seenCorrelationIds.add(message.correlationId);
    }

    const isOverflowProtected = this.config.overflowProtectionTypes.includes(message.type);
    if (!isOverflowProtected && this.config.capacity > 0 && this.queue.length >= this.config.capacity) {
      this.logger.warn('Mailbox overflow, dropping message', {
        actorId: this.actorId,
        messageType: message.type,
        currentSize: this.queue.length,
        capacity: this.config.capacity,
      });
      return false;
    }

    this.queue.push({
      message,
      priority,
      enqueuedAt: Date.now(),
      attempts: 0,
    });

    this.logger.debug('Message enqueued', {
      actorId: this.actorId,
      messageType: message.type,
      queueSize: this.queue.length,
    });

    this.processQueue();
    return true;
  }

  /**
   * Get current mailbox size.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Check if mailbox is empty.
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Clear all messages from the mailbox.
   */
  clear(): void {
    this.queue.length = 0;
    this.seenCorrelationIds.clear();
  }

  /**
   * Drain messages up to a limit, respecting priority order.
   */
  drain(limit = Infinity): ActorMessage[] {
    this.purgeExpired();
    const messages: ActorMessage[] = [];
    while (messages.length < limit && this.queue.length > 0) {
      const entry = this.dequeueEntry();
      if (entry) {
        messages.push(entry.message);
      }
    }
    return messages;
  }

  /**
   * Peek at the next message without removing it.
   */
  peek(): ActorMessage | undefined {
    this.purgeExpired();
    this.sortQueue();
    return this.queue[0]?.message;
  }

  private processQueue(): void {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    this.purgeExpired();
    this.sortQueue();

    while (this.queue.length > 0) {
      const entry = this.dequeueEntry();
      if (!entry) break;

      entry.attempts++;
      try {
        await this.onMessage(entry.message);
      } catch (error) {
        this.logger.error('Message processing failed', error as Error, {
          actorId: this.actorId,
          messageType: entry.message.type,
          messageId: entry.message.id,
          attempts: entry.attempts,
        });

        if (entry.attempts < 3) {
          this.queue.push(entry);
          this.sortQueue();
        }
      }
    }

    this.processing = false;
  }

  private dequeueEntry(): MailboxEntry | undefined {
    this.sortQueue();
    return this.queue.shift();
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  private purgeExpired(): void {
    if (this.config.maxMessageAgeMs <= 0) return;

    const now = Date.now();
    const before = this.queue.length;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const entry = this.queue[i];
      if (now - entry.enqueuedAt > this.config.maxMessageAgeMs) {
        this.queue.splice(i, 1);
      }
    }

    const dropped = before - this.queue.length;
    if (dropped > 0) {
      this.logger.debug('Purged expired messages', {
        actorId: this.actorId,
        dropped,
        remaining: this.queue.length,
      });
    }
  }
}
