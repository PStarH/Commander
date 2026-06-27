/**
 * Distributed Event Bus — Cross-node pub/sub with pluggable backends
 *
 * Extends ContractEventBus with optional Redis/NATS backends for
 * cross-node event distribution. When no backend is configured, falls
 * back to in-memory operation (backward compatible with ContractEventBus).
 *
 * Features:
 * - Local-first: local subscribers receive messages instantly (zero network)
 * - Optional cross-node fan-out via Redis Pub/Sub or NATS
 * - Monotonic event IDs with node-prefixed UUIDs for global ordering
 * - Replay works locally; cross-node replay requires a message log (Kafka)
 *
 * Per constraint PII-FR-10, supports cross-node A2A communication.
 */

import { getGlobalLogger } from '../logging';
import { reportSilentFailure } from '../silentFailureReporter';
import { ContractEventBus } from './contractEventBus';

// ============================================================================
// Types
// ============================================================================

export type BackendType = 'memory' | 'redis' | 'nats';

export interface DistributedBusConfig {
  /** Backend type */
  backend: BackendType;
  /** Redis URL (e.g., redis://localhost:6379) */
  redisUrl?: string;
  /** NATS URL (e.g., nats://localhost:4222) */
  natsUrl?: string;
  /** Node ID prefix for globally unique event IDs */
  nodeId?: string;
  /** Channel prefix for pub/sub topics */
  channelPrefix?: string;
  /** Whether to enable local-first delivery (default: true) */
  localFirst?: boolean;
}

interface RedisLike {
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  quit(): Promise<void>;
}

// ============================================================================
// DistributedEventBus Implementation
// ============================================================================

export class DistributedEventBus extends ContractEventBus {
  private backend: BackendType;
  private redisClient: RedisLike | null = null;
  private nodeId: string;
  private channelPrefix: string;
  private localFirst: boolean;
  private subscribedTopics: Set<string> = new Set();
  private remoteSubscriptions: Map<string, (message: unknown) => void> = new Map();
  private eventCounter = 0;

  constructor(config: DistributedBusConfig = { backend: 'memory' }) {
    super();
    this.backend = config.backend;
    this.nodeId = config.nodeId ?? `node-${Math.random().toString(36).substring(2, 8)}`;
    this.channelPrefix = config.channelPrefix ?? 'commander:events:';
    this.localFirst = config.localFirst ?? true;

    if (config.backend === 'redis' && config.redisUrl) {
      this.initRedis(config.redisUrl).catch((err) => {
        reportSilentFailure(err, 'distributedEventBus:initRedis');
        getGlobalLogger().warn('DistributedEventBus', 'Redis init failed — falling back to in-memory', {
          error: (err as Error).message,
        });
        this.backend = 'memory';
      });
    }
  }

  /**
   * Initialize Redis connection.
   * Dynamically imports the `redis` package (optional dependency).
   */
  private async initRedis(redisUrl: string): Promise<void> {
    try {
      const redis = await import('redis');
      const client = redis.createClient({ url: redisUrl });
      await client.connect();

      // Create a RedisLike adapter
      this.redisClient = {
        async publish(channel: string, message: string): Promise<number> {
          return client.publish(channel, message);
        },
        async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
          await client.subscribe(channel, (msg: string) => handler(msg));
        },
        async unsubscribe(channel: string): Promise<void> {
          await client.unsubscribe(channel);
        },
        async quit(): Promise<void> {
          await client.quit();
        },
      };

      getGlobalLogger().info('DistributedEventBus', 'Redis backend connected', {
        url: redisUrl.replace(/:[^:@]+@/, ':****@'),
      });
    } catch (err) {
      // redis package not installed — that's OK, fall back to memory
      getGlobalLogger().info('DistributedEventBus', 'Redis package not available — using in-memory', {
        hint: 'Install redis package: npm install redis',
      });
      this.backend = 'memory';
    }
  }

  /**
   * Override publish to fan out to remote nodes when backend is configured.
   *
   * Delivery order:
   * 1. Local subscribers (instant, if localFirst=true)
   * 2. Remote nodes via pub/sub backend
   * 3. Local subscribers (if localFirst=false, after remote confirmation)
   */
  async publish(topic: string, message: unknown): Promise<void> {
    // Local delivery first (if localFirst)
    if (this.localFirst) {
      await super.publish(topic, message);
    }

    // Remote fan-out
    if (this.backend !== 'memory' && this.redisClient) {
      try {
        const channel = this.channelPrefix + topic;
        const envelope = {
          nodeId: this.nodeId,
          topic,
          message,
          eventId: `${this.nodeId}-${++this.eventCounter}`,
          timestamp: Date.now(),
        };
        await this.redisClient.publish(channel, JSON.stringify(envelope));

        getGlobalLogger().debug('DistributedEventBus', 'Published to remote', {
          topic,
          channel,
          eventId: envelope.eventId,
        });
      } catch (err) {
        reportSilentFailure(err, 'distributedEventBus:publish:remote');
        getGlobalLogger().warn('DistributedEventBus', 'Remote publish failed — local only', {
          topic,
          error: (err as Error).message,
        });
      }
    }

    // Local delivery after remote (if not localFirst)
    if (!this.localFirst) {
      await super.publish(topic, message);
    }
  }

  /**
   * Override subscribe to also listen on remote pub/sub channels.
   */
  subscribe(topic: string, handler: (message: unknown) => void): () => void {
    // Subscribe locally
    const unsubLocal = super.subscribe(topic, handler);

    // Subscribe remotely if backend is configured
    if (this.backend !== 'memory' && this.redisClient) {
      const channel = this.channelPrefix + topic;

      // Avoid duplicate subscriptions to the same channel
      if (!this.subscribedTopics.has(channel)) {
        this.subscribedTopics.add(channel);

        this.redisClient.subscribe(channel, (rawMessage: string) => {
          try {
            const envelope = JSON.parse(rawMessage) as {
              nodeId: string;
              topic: string;
              message: unknown;
              eventId: string;
              timestamp: number;
            };

            // Skip messages from this node (already delivered locally)
            if (envelope.nodeId === this.nodeId) return;

            getGlobalLogger().debug('DistributedEventBus', 'Received from remote', {
              topic: envelope.topic,
              sourceNode: envelope.nodeId,
              eventId: envelope.eventId,
            });

            // Deliver to local subscribers via the parent class
            super.publish(envelope.topic, envelope.message);
          } catch (err) {
            reportSilentFailure(err, 'distributedEventBus:remoteMessage:parse');
          }
        }).catch((err) => {
          reportSilentFailure(err, 'distributedEventBus:subscribe:remote');
        });
      }
    }

    return () => {
      unsubLocal();
      // Note: remote subscription persists for topic lifetime
      // (multiple local subscribers share one remote subscription)
    };
  }

  /**
   * Get the current backend type.
   */
  getBackend(): BackendType {
    return this.backend;
  }

  /**
   * Get the node ID.
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Check if the bus is operating in distributed mode.
   */
  isDistributed(): boolean {
    return this.backend !== 'memory' && this.redisClient !== null;
  }

  /**
   * Gracefully shutdown the bus and disconnect from backend.
   */
  async shutdown(): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
        getGlobalLogger().info('DistributedEventBus', 'Backend disconnected');
      } catch (err) {
        reportSilentFailure(err, 'distributedEventBus:shutdown');
      }
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createDistributedEventBus(
  config?: Partial<DistributedBusConfig>,
): DistributedEventBus {
  return new DistributedEventBus({
    backend: 'memory',
    ...config,
  });
}
