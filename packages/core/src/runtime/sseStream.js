"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SSEStream = void 0;
const messageBus_1 = require("./messageBus");
const logging_1 = require("../logging");
class SSEStream {
    constructor(topics, heartbeatIntervalMs, options) {
        var _a, _b;
        this.subscribers = [];
        this.unsubscribers = [];
        this.closed = false;
        this.seqCounter = 0;
        this.heartbeatTimer = null;
        this.eventBuffer = [];
        this.entityStateTree = {
            entities: new Map(),
            rootIds: [],
        };
        this.heartbeatIntervalMs = heartbeatIntervalMs !== null && heartbeatIntervalMs !== void 0 ? heartbeatIntervalMs : 30000;
        this.retryMs = (_a = options === null || options === void 0 ? void 0 : options.retryMs) !== null && _a !== void 0 ? _a : 5000;
        this.maxBufferSize = (_b = options === null || options === void 0 ? void 0 : options.maxBufferSize) !== null && _b !== void 0 ? _b : 100;
        const bus = (0, messageBus_1.getMessageBus)();
        const watchTopics = topics !== null && topics !== void 0 ? topics : [
            'agent.started',
            'agent.completed',
            'agent.failed',
            'agent.message',
            'mission.updated',
            'mission.blocked',
            'mission.completed',
            'system.alert',
            'tool.executed',
            'tool.started',
            'tool.completed',
            'tool.timeout',
            'tool.retry',
            'tool.blocked',
        ];
        for (const topic of watchTopics) {
            const unsub = bus.subscribe(topic, (message) => {
                if (this.closed)
                    return;
                this.updateEntityState(message);
                this.emitRaw({
                    topic: message.topic,
                    source: message.source,
                    payload: message.payload,
                    timestamp: message.timestamp,
                    priority: message.priority,
                });
            });
            this.unsubscribers.push(unsub);
        }
        if (this.heartbeatIntervalMs > 0) {
            this.heartbeatTimer = setInterval(() => {
                if (!this.closed) {
                    this.dispatch(': heartbeat\n\n');
                }
            }, this.heartbeatIntervalMs);
            if (this.heartbeatTimer.unref)
                this.heartbeatTimer.unref();
        }
        this.dispatch(`retry: ${this.retryMs}\n\n`);
    }
    updateEntityState(message) {
        var _a, _b, _c, _d, _e;
        const { topic, source, payload } = message;
        const now = new Date().toISOString();
        if (topic.startsWith('agent.')) {
            const agentId = (_a = payload === null || payload === void 0 ? void 0 : payload.agentId) !== null && _a !== void 0 ? _a : source;
            const existing = this.entityStateTree.entities.get(agentId);
            let status = (_b = existing === null || existing === void 0 ? void 0 : existing.status) !== null && _b !== void 0 ? _b : 'idle';
            if (topic === 'agent.started')
                status = 'running';
            else if (topic === 'agent.completed')
                status = 'completed';
            else if (topic === 'agent.failed')
                status = 'failed';
            this.entityStateTree.entities.set(agentId, {
                id: agentId,
                type: 'agent',
                status,
                metadata: { ...((_c = existing === null || existing === void 0 ? void 0 : existing.metadata) !== null && _c !== void 0 ? _c : {}), ...payload },
                updatedAt: now,
            });
            if (!existing && !this.entityStateTree.rootIds.includes(agentId)) {
                this.entityStateTree.rootIds.push(agentId);
            }
        }
        if (topic.startsWith('tool.')) {
            const toolCallId = (_d = payload === null || payload === void 0 ? void 0 : payload.toolCallId) !== null && _d !== void 0 ? _d : `${source}-${Date.now()}`;
            const parentId = payload === null || payload === void 0 ? void 0 : payload.agentId;
            let status = 'running';
            if (topic === 'tool.completed')
                status = 'completed';
            else if (topic === 'tool.timeout' || topic === 'tool.blocked')
                status = 'failed';
            this.entityStateTree.entities.set(toolCallId, {
                id: toolCallId,
                type: 'tool',
                status,
                parentId,
                metadata: payload,
                updatedAt: now,
            });
        }
        if (topic.startsWith('mission.')) {
            const missionId = (_e = payload === null || payload === void 0 ? void 0 : payload.missionId) !== null && _e !== void 0 ? _e : source;
            let status = 'running';
            if (topic === 'mission.completed')
                status = 'completed';
            else if (topic === 'mission.blocked')
                status = 'blocked';
            this.entityStateTree.entities.set(missionId, {
                id: missionId,
                type: 'mission',
                status,
                metadata: payload,
                updatedAt: now,
            });
        }
    }
    getStateTree() {
        const entities = new Map();
        for (const [key, value] of this.entityStateTree.entities) {
            entities.set(key, { ...value, metadata: { ...value.metadata } });
        }
        return {
            entities,
            rootIds: [...this.entityStateTree.rootIds],
        };
    }
    getEntity(id) {
        return this.entityStateTree.entities.get(id);
    }
    emitStateSync() {
        if (this.closed)
            return;
        const tree = this.getStateTree();
        const serializable = {
            entities: Array.from(tree.entities.values()),
            rootIds: tree.rootIds,
        };
        this.emitStructured('state.sync', { tree: serializable });
    }
    emitStructured(eventType, data) {
        if (this.closed)
            return;
        const seq = ++this.seqCounter;
        const event = {
            event: eventType,
            data,
            timestamp: new Date().toISOString(),
            seq,
        };
        const payload = `id: ${seq}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
        // Buffer for Last-Event-ID replay
        this.eventBuffer.push({ id: seq, payload });
        if (this.eventBuffer.length > this.maxBufferSize) {
            this.eventBuffer.shift();
        }
        this.dispatch(payload);
    }
    emitRaw(data) {
        this.dispatch(`data: ${JSON.stringify(data)}\n\n`);
    }
    dispatch(payload) {
        for (const subscriber of this.subscribers) {
            try {
                subscriber(payload);
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('SSEStream', 'Subscriber dispatch failed', {
                    error: e === null || e === void 0 ? void 0 : e.message,
                });
            }
        }
    }
    emitReasoning(content) {
        this.emitStructured('reasoning.delta', { content, length: content.length });
    }
    emitToolCall(toolName, status, detail) {
        const eventType = status === 'started'
            ? 'tool_call.started'
            : status === 'completed'
                ? 'tool_call.completed'
                : 'tool_call.delta';
        this.emitStructured(eventType, { toolName, ...detail });
    }
    emitToolTimeout(toolName, detail) {
        this.emitStructured('tool_call.timeout', { toolName, ...detail });
    }
    emitToolRetry(toolName, attempt, detail) {
        this.emitStructured('tool_call.retry', { toolName, attempt, ...detail });
    }
    emitToolBlocked(toolName, reason, detail) {
        this.emitStructured('tool_call.blocked', { toolName, reason, ...detail });
    }
    /**
     * Emit an abort event with reason.
     * Follows Vercel AI SDK pattern for stream abortion.
     */
    emitAbort(reason) {
        this.emitStructured('error.occurred', { type: 'abort', reason });
    }
    emitStatus(status, detail) {
        this.emitStructured('agent.status', { status, detail: detail !== null && detail !== void 0 ? detail : '' });
    }
    emitOutput(content, done = false) {
        if (done) {
            this.emitStructured('output.completed', { content });
        }
        else {
            this.emitStructured('output.delta', { content });
        }
    }
    /**
     * Replay events since a given Last-Event-ID.
     * Used for SSE reconnection — client sends Last-Event-ID header,
     * server replays missed events to close the gap.
     */
    replaySince(lastEventId) {
        const missed = this.eventBuffer.filter((e) => e.id > lastEventId);
        for (const e of missed) {
            this.dispatch(e.payload);
        }
    }
    onEvent(callback) {
        this.subscribers.push(callback);
        return () => {
            const idx = this.subscribers.indexOf(callback);
            if (idx >= 0)
                this.subscribers.splice(idx, 1);
        };
    }
    pipe(writable) {
        const unsub = this.onEvent((event) => {
            if (!this.closed) {
                try {
                    writable.write(event);
                }
                catch (e) {
                    (0, logging_1.getGlobalLogger)().warn('SSEStream', 'Writable stream write failed', {
                        error: e === null || e === void 0 ? void 0 : e.message,
                    });
                    this.close();
                }
            }
        });
        this.unsubscribers.push(unsub);
    }
    close() {
        this.closed = true;
        // Send [DONE] marker (Vercel AI SDK pattern) to signal stream completion
        this.dispatch('data: [DONE]\n\n');
        // GAP-28: Stop heartbeat timer on close
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const unsub of this.unsubscribers) {
            try {
                unsub();
            }
            catch (e) {
                (0, logging_1.getGlobalLogger)().warn('SSEStream', 'Unsubscribe failed', { error: e === null || e === void 0 ? void 0 : e.message });
            }
        }
        this.unsubscribers = [];
        this.subscribers = [];
    }
    get isClosed() {
        return this.closed;
    }
}
exports.SSEStream = SSEStream;
