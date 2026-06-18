"use strict";
/**
 * Message Bus — Event-driven inter-agent communication.
 *
 * Agents can publish messages on topics and subscribe to receive messages.
 * Used for coordination, handoffs, alerts, and state synchronization.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageBus = void 0;
exports.getMessageBus = getMessageBus;
exports.resetMessageBus = resetMessageBus;
const logging_1 = require("../logging");
function generateId() {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
class MessageBus {
    constructor(maxHistory = 1000) {
        this.subscribers = new Map();
        // Ring buffer for history — O(1) push/evict instead of O(n) shift
        this.history = [];
        this.historyHead = 0; // next write position
        this.historyCount = 0; // current number of entries
        this.topics = new Set();
        // GAP-23: Track last publish time per topic for pruning
        this.topicLastActive = new Map();
        // Wildcard subscriber flag — skip wildcard dispatch when no wildcard subscribers exist
        this.hasWildcardSubscribers = false;
        // Topic-indexed history — ring buffer per topic for O(1) insert/evict
        this.topicHistory = new Map();
        this.MAX_TOPICS = 200;
        this.TOPIC_IDLE_TTL_MS = 3600000; // 1 hour
        this.maxHistory = maxHistory;
    }
    publish(topic, source, payload, options) {
        var _a;
        const now = Date.now();
        const message = {
            id: generateId(),
            topic,
            source,
            target: options === null || options === void 0 ? void 0 : options.target,
            payload,
            priority: (_a = options === null || options === void 0 ? void 0 : options.priority) !== null && _a !== void 0 ? _a : 'normal',
            timestamp: new Date(now).toISOString(),
            ttl: options === null || options === void 0 ? void 0 : options.ttl,
        };
        this.topics.add(topic);
        this.topicLastActive.set(topic, now);
        // Ring buffer: O(1) insert, O(1) evict
        if (this.historyCount < this.maxHistory) {
            this.history[this.historyHead] = message;
            this.historyHead = (this.historyHead + 1) % this.maxHistory;
            this.historyCount++;
        }
        else {
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
        }
        else {
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
                        result.catch((err) => (0, logging_1.getGlobalLogger)().error('MessageBus', `handler error on ${topic}`, err));
                    }
                }
                catch (err) {
                    (0, logging_1.getGlobalLogger)().error('MessageBus', `handler error on ${topic}`, err);
                }
            }
        }
        // Only check wildcard handlers if any exist
        if (this.hasWildcardSubscribers && topic !== '*') {
            const wildcardHandlers = this.subscribers.get('*');
            if (wildcardHandlers) {
                for (const handler of wildcardHandlers) {
                    try {
                        const result = handler(message);
                        if (result instanceof Promise) {
                            result.catch((err) => (0, logging_1.getGlobalLogger)().error('MessageBus', `handler error on ${topic}`, err));
                        }
                    }
                    catch (err) {
                        (0, logging_1.getGlobalLogger)().error('MessageBus', `handler error on ${topic}`, err);
                    }
                }
            }
        }
        return message;
    }
    subscribe(topic, handler) {
        if (!this.subscribers.has(topic)) {
            this.subscribers.set(topic, new Set());
        }
        this.subscribers.get(topic).add(handler);
        this.topics.add(topic);
        // Track wildcard subscribers
        if (topic === '*')
            this.hasWildcardSubscribers = true;
        return () => {
            var _a, _b;
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
            if (topic === '*' && ((_b = (_a = this.subscribers.get('*')) === null || _a === void 0 ? void 0 : _a.size) !== null && _b !== void 0 ? _b : 0) === 0) {
                this.hasWildcardSubscribers = false;
            }
        };
    }
    /**
     * Subscribe to multiple topics at once.
     */
    subscribeMany(topics, handler) {
        const unsubs = topics.map((t) => this.subscribe(t, handler));
        return () => unsubs.forEach((fn) => fn());
    }
    /**
     * Get message history for a specific topic or all topics.
     */
    getHistory(topic, limit) {
        let filtered;
        if (topic) {
            // O(1) topic lookup via ring buffer index
            const entry = this.topicHistory.get(topic);
            if (!entry)
                return [];
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
    getActiveTopics() {
        return Array.from(this.topics);
    }
    /**
     * Get subscriber count per topic.
     */
    getSubscriberCount(topic) {
        var _a, _b;
        return (_b = (_a = this.subscribers.get(topic)) === null || _a === void 0 ? void 0 : _a.size) !== null && _b !== void 0 ? _b : 0;
    }
    /**
     * Get all subscriber counts.
     */
    getAllSubscriberCounts() {
        const counts = {};
        for (const [topic, handlers] of this.subscribers) {
            counts[topic] = handlers.size;
        }
        return counts;
    }
    /**
     * Clear message history.
     */
    clearHistory() {
        this.history = [];
        this.historyHead = 0;
        this.historyCount = 0;
        this.topicHistory.clear();
    }
    /** GAP-23: Prune topics with no subscribers and no recent activity. */
    pruneIdleTopics() {
        var _a, _b, _c;
        const now = Date.now();
        for (const topic of this.topics) {
            const lastActive = (_a = this.topicLastActive.get(topic)) !== null && _a !== void 0 ? _a : 0;
            const hasSubscribers = ((_c = (_b = this.subscribers.get(topic)) === null || _b === void 0 ? void 0 : _b.size) !== null && _c !== void 0 ? _c : 0) > 0;
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
    clearSubscribers(topic) {
        if (topic) {
            this.subscribers.delete(topic);
        }
        else {
            this.subscribers.clear();
        }
    }
}
exports.MessageBus = MessageBus;
const tenantAwareSingleton_1 = require("./tenantAwareSingleton");
const messageBusSingleton = (0, tenantAwareSingleton_1.createTenantAwareSingleton)(() => new MessageBus(), {
    dispose: (bus) => bus.clearSubscribers(),
});
/** Get the global MessageBus (single-tenant) or tenant-scoped (multi-tenant). */
function getMessageBus() {
    return messageBusSingleton.get();
}
/** Reset the message bus singleton (for test isolation). */
function resetMessageBus() {
    messageBusSingleton.reset();
}
