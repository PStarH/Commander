"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseChannelAdapter = void 0;
const messageBus_1 = require("./messageBus");
class BaseChannelAdapter {
    constructor() {
        this.bus = (0, messageBus_1.getMessageBus)();
        this.status = 'disconnected';
        this.eventHandlers = new Map();
        this.sessions = new Map();
        this.busUnsubscribers = [];
    }
    async initialize(config, agentLoop) {
        this.config = { ...this.defaultConfig, ...config };
        this.agentLoop = agentLoop;
        // Clean up any previous subscriptions before re-subscribing
        for (const unsub of this.busUnsubscribers)
            unsub();
        this.busUnsubscribers = [];
        this.busUnsubscribers.push(this.bus.subscribe('agent.started', () => {
            this.onAgentEvent('started', { source: this.config.channelId });
        }), this.bus.subscribe('agent.completed', () => {
            this.onAgentEvent('completed', { source: this.config.channelId });
        }), this.bus.subscribe('agent.failed', () => {
            this.onAgentEvent('failed', { source: this.config.channelId });
        }));
    }
    async start() {
        this.status = 'connecting';
        await this.connectPlatform();
        this.status = 'connected';
        this.bus.publish('channel.connected', this.config.channelId, { platform: this.platform });
    }
    async stop() {
        this.status = 'disconnected';
        for (const unsub of this.busUnsubscribers)
            unsub();
        this.busUnsubscribers = [];
        await this.disconnectPlatform();
        this.bus.publish('channel.disconnected', this.config.channelId, { platform: this.platform });
    }
    getStatus() {
        return this.status;
    }
    onEvent(event, handler) {
        if (!this.eventHandlers.has(event))
            this.eventHandlers.set(event, new Set());
        this.eventHandlers.get(event).add(handler);
    }
    emitEvent(event, data) {
        var _a;
        (_a = this.eventHandlers.get(event)) === null || _a === void 0 ? void 0 : _a.forEach((h) => h(data));
    }
    isUserAllowed(userId) {
        var _a, _b;
        if ((_a = this.config.blockedUsers) === null || _a === void 0 ? void 0 : _a.includes(userId))
            return false;
        if (((_b = this.config.allowedUsers) === null || _b === void 0 ? void 0 : _b.length) && !this.config.allowedUsers.includes(userId))
            return false;
        return true;
    }
    isAdmin(userId) {
        var _a, _b;
        return (_b = (_a = this.config.adminUsers) === null || _a === void 0 ? void 0 : _a.includes(userId)) !== null && _b !== void 0 ? _b : false;
    }
    manageSession(userId, threadId) {
        const sessionKey = `${userId}:${threadId !== null && threadId !== void 0 ? threadId : 'default'}`;
        const existing = this.sessions.get(sessionKey);
        if (existing) {
            existing.lastMessage = Date.now();
            return { isNew: false, sessionId: sessionKey };
        }
        if (this.sessions.size >= this.config.maxConcurrentSessions) {
            let oldestKey;
            let oldestTime = Infinity;
            for (const [key, session] of this.sessions) {
                if (session.lastMessage < oldestTime) {
                    oldestTime = session.lastMessage;
                    oldestKey = key;
                }
            }
            if (oldestKey)
                this.sessions.delete(oldestKey);
        }
        this.sessions.set(sessionKey, { userId, lastMessage: Date.now(), threadId });
        return { isNew: true, sessionId: sessionKey };
    }
    cleanupStaleSessions() {
        const timeout = this.config.sessionTimeoutMs;
        const now = Date.now();
        const stale = [];
        for (const [key, session] of this.sessions.entries()) {
            if (now - session.lastMessage > timeout)
                stale.push(key);
        }
        for (const key of stale)
            this.sessions.delete(key);
    }
    async handleIncomingMessage(msg) {
        if (!this.config.enabled)
            return;
        if (!this.isUserAllowed(msg.userId))
            return;
        this.manageSession(msg.userId, msg.threadId);
        this.cleanupStaleSessions();
        const normalized = this.normalizeMessage(msg);
        this.bus.publish('channel.message', this.config.channelId, normalized);
        if (this.config.autoResponse) {
            this.agentLoop.addTask(normalized.content, this.isAdmin(msg.userId) ? 10 : 0);
        }
        this.emitEvent('message', normalized);
    }
    normalizeMessage(msg) {
        return {
            ...msg,
            channelId: this.config.channelId,
            timestamp: msg.timestamp || new Date().toISOString(),
        };
    }
    onAgentEvent(_type, _data) {
        this.emitEvent(_type, {});
    }
}
exports.BaseChannelAdapter = BaseChannelAdapter;
