/**
 * Message Bus — Event-driven inter-agent communication.
 *
 * Agents can publish messages on topics and subscribe to receive messages.
 * Used for coordination, handoffs, alerts, and state synchronization.
 */
import type { BusMessage, MessageBusTopic, MessageHandler, MessagePriority, BusPayloadMap, TypedBusMessage } from './types';
export declare class MessageBus {
    private subscribers;
    private history;
    private historyHead;
    private historyCount;
    private maxHistory;
    private topics;
    private topicLastActive;
    private hasWildcardSubscribers;
    private topicHistory;
    private readonly MAX_TOPICS;
    private readonly TOPIC_IDLE_TTL_MS;
    constructor(maxHistory?: number);
    /**
     * Publish to a known topic — payload and return type are typed.
     */
    publish<T extends keyof BusPayloadMap>(topic: T, source: string, payload: BusPayloadMap[T], options?: {
        target?: string;
        priority?: MessagePriority;
        ttl?: number;
    }): TypedBusMessage<T>;
    /**
     * Publish to an arbitrary topic — payload is unknown.
     */
    publish(topic: MessageBusTopic, source: string, payload: unknown, options?: {
        target?: string;
        priority?: MessagePriority;
        ttl?: number;
    }): BusMessage;
    /**
     * Subscribe to a known topic — handler receives typed payload.
     */
    subscribe<T extends keyof BusPayloadMap>(topic: T, handler: (message: TypedBusMessage<T>) => void | Promise<void>): () => void;
    /**
     * Subscribe to an arbitrary topic — payload is unknown.
     */
    subscribe(topic: MessageBusTopic, handler: MessageHandler): () => void;
    /**
     * Subscribe to multiple topics at once.
     */
    subscribeMany(topics: MessageBusTopic[], handler: MessageHandler): () => void;
    /**
     * Get message history for a specific topic or all topics.
     */
    getHistory(topic?: MessageBusTopic, limit?: number): BusMessage[];
    /**
     * Get the list of topics that have been published to.
     */
    getActiveTopics(): MessageBusTopic[];
    /**
     * Get subscriber count per topic.
     */
    getSubscriberCount(topic: MessageBusTopic): number;
    /**
     * Get all subscriber counts.
     */
    getAllSubscriberCounts(): Record<string, number>;
    /**
     * Clear message history.
     */
    clearHistory(): void;
    /** GAP-23: Prune topics with no subscribers and no recent activity. */
    private pruneIdleTopics;
    /**
     * Remove all subscribers for a topic.
     */
    clearSubscribers(topic?: MessageBusTopic): void;
}
/** Get the global MessageBus (single-tenant) or tenant-scoped (multi-tenant). */
export declare function getMessageBus(): MessageBus;
/** Reset the message bus singleton (for test isolation). */
export declare function resetMessageBus(): void;
//# sourceMappingURL=messageBus.d.ts.map