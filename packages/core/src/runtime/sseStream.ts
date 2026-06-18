import type { BusMessage, MessageBusTopic } from './types';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';

export type StructuredSSEEventType =
  | 'agent.status'
  | 'agent.thinking'
  | 'reasoning.delta'
  | 'tool_call.delta'
  | 'tool_call.started'
  | 'tool_call.completed'
  | 'tool_call.timeout'
  | 'tool_call.retry'
  | 'tool_call.blocked'
  | 'output.delta'
  | 'output.completed'
  | 'diff.available'
  | 'error.occurred'
  | 'cost.update'
  | 'compensation.update'
  | 'sop.update'
  | 'state.sync';

export interface StructuredSSEEvent {
  event: StructuredSSEEventType;
  data: Record<string, unknown>;
  timestamp: string;
  seq: number;
}

export interface EntityState {
  id: string;
  type: 'agent' | 'tool' | 'mission' | 'subtask';
  status: 'idle' | 'running' | 'completed' | 'failed' | 'blocked';
  parentId?: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface EntityStateTree {
  entities: Map<string, EntityState>;
  rootIds: string[];
}

export class SSEStream {
  private subscribers: Array<(event: string) => void> = [];
  private unsubscribers: Array<() => void> = [];
  private closed = false;
  private seqCounter = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly retryMs: number;
  private eventBuffer: Array<{ id: number; payload: string }> = [];
  private readonly maxBufferSize: number;
  private entityStateTree: EntityStateTree = {
    entities: new Map(),
    rootIds: [],
  };

  constructor(
    topics?: MessageBusTopic[],
    heartbeatIntervalMs?: number,
    options?: { retryMs?: number; maxBufferSize?: number },
  ) {
    this.heartbeatIntervalMs = heartbeatIntervalMs ?? 30_000;
    this.retryMs = options?.retryMs ?? 5000;
    this.maxBufferSize = options?.maxBufferSize ?? 100;
    const bus = getMessageBus();
    const watchTopics: MessageBusTopic[] = topics ?? [
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
      const unsub = bus.subscribe(topic, (message: BusMessage) => {
        if (this.closed) return;
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
      if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }

    this.dispatch(`retry: ${this.retryMs}\n\n`);
  }

  private updateEntityState(message: BusMessage): void {
    const { topic, source, payload } = message;
    const now = new Date().toISOString();

    if (topic.startsWith('agent.')) {
      const agentId = (payload as { agentId?: string })?.agentId ?? source;
      const existing = this.entityStateTree.entities.get(agentId);
      let status: EntityState['status'] = existing?.status ?? 'idle';
      if (topic === 'agent.started') status = 'running';
      else if (topic === 'agent.completed') status = 'completed';
      else if (topic === 'agent.failed') status = 'failed';

      this.entityStateTree.entities.set(agentId, {
        id: agentId,
        type: 'agent',
        status,
        metadata: { ...(existing?.metadata ?? {}), ...(payload as Record<string, unknown>) },
        updatedAt: now,
      });

      if (!existing && !this.entityStateTree.rootIds.includes(agentId)) {
        this.entityStateTree.rootIds.push(agentId);
      }
    }

    if (topic.startsWith('tool.')) {
      const toolCallId = (payload as { toolCallId?: string })?.toolCallId ?? `${source}-${Date.now()}`;
      const parentId = (payload as { agentId?: string })?.agentId;
      let status: EntityState['status'] = 'running';
      if (topic === 'tool.completed') status = 'completed';
      else if (topic === 'tool.timeout' || topic === 'tool.blocked') status = 'failed';

      this.entityStateTree.entities.set(toolCallId, {
        id: toolCallId,
        type: 'tool',
        status,
        parentId,
        metadata: payload as Record<string, unknown>,
        updatedAt: now,
      });
    }

    if (topic.startsWith('mission.')) {
      const missionId = (payload as { missionId?: string })?.missionId ?? source;
      let status: EntityState['status'] = 'running';
      if (topic === 'mission.completed') status = 'completed';
      else if (topic === 'mission.blocked') status = 'blocked';

      this.entityStateTree.entities.set(missionId, {
        id: missionId,
        type: 'mission',
        status,
        metadata: payload as Record<string, unknown>,
        updatedAt: now,
      });
    }
  }

  getStateTree(): EntityStateTree {
    const entities = new Map<string, EntityState>();
    for (const [key, value] of this.entityStateTree.entities) {
      entities.set(key, { ...value, metadata: { ...value.metadata } });
    }
    return {
      entities,
      rootIds: [...this.entityStateTree.rootIds],
    };
  }

  getEntity(id: string): EntityState | undefined {
    return this.entityStateTree.entities.get(id);
  }

  emitStateSync(): void {
    if (this.closed) return;
    const tree = this.getStateTree();
    const serializable = {
      entities: Array.from(tree.entities.values()),
      rootIds: tree.rootIds,
    };
    this.emitStructured('state.sync', { tree: serializable });
  }

  emitStructured(eventType: StructuredSSEEventType, data: Record<string, unknown>): void {
    if (this.closed) return;
    const seq = ++this.seqCounter;
    const event: StructuredSSEEvent = {
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

  private emitRaw(data: Record<string, unknown>): void {
    this.dispatch(`data: ${JSON.stringify(data)}\n\n`);
  }

  private dispatch(payload: string): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(payload);
      } catch (e) {
        getGlobalLogger().warn('SSEStream', 'Subscriber dispatch failed', {
          error: (e as Error)?.message,
        });
      }
    }
  }

  emitReasoning(content: string): void {
    this.emitStructured('reasoning.delta', { content, length: content.length });
  }

  emitToolCall(
    toolName: string,
    status: 'started' | 'completed' | 'delta',
    detail?: Record<string, unknown>,
  ): void {
    const eventType =
      status === 'started'
        ? 'tool_call.started'
        : status === 'completed'
          ? 'tool_call.completed'
          : 'tool_call.delta';
    this.emitStructured(eventType, { toolName, ...detail });
  }

  emitToolTimeout(toolName: string, detail?: Record<string, unknown>): void {
    this.emitStructured('tool_call.timeout', { toolName, ...detail });
  }

  emitToolRetry(toolName: string, attempt: number, detail?: Record<string, unknown>): void {
    this.emitStructured('tool_call.retry', { toolName, attempt, ...detail });
  }

  emitToolBlocked(toolName: string, reason: string, detail?: Record<string, unknown>): void {
    this.emitStructured('tool_call.blocked', { toolName, reason, ...detail });
  }

  /**
   * Emit an abort event with reason.
   * Follows Vercel AI SDK pattern for stream abortion.
   */
  emitAbort(reason: string): void {
    this.emitStructured('error.occurred', { type: 'abort', reason });
  }

  emitStatus(status: string, detail?: string): void {
    this.emitStructured('agent.status', { status, detail: detail ?? '' });
  }

  emitOutput(content: string, done = false): void {
    if (done) {
      this.emitStructured('output.completed', { content });
    } else {
      this.emitStructured('output.delta', { content });
    }
  }

  /**
   * Replay events since a given Last-Event-ID.
   * Used for SSE reconnection — client sends Last-Event-ID header,
   * server replays missed events to close the gap.
   */
  replaySince(lastEventId: number): void {
    const missed = this.eventBuffer.filter((e) => e.id > lastEventId);
    for (const e of missed) {
      this.dispatch(e.payload);
    }
  }

  onEvent(callback: (event: string) => void): () => void {
    this.subscribers.push(callback);
    return () => {
      const idx = this.subscribers.indexOf(callback);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  pipe(writable: { write(data: string): void }): void {
    const unsub = this.onEvent((event) => {
      if (!this.closed) {
        try {
          writable.write(event);
        } catch (e) {
          getGlobalLogger().warn('SSEStream', 'Writable stream write failed', {
            error: (e as Error)?.message,
          });
          this.close();
        }
      }
    });
    this.unsubscribers.push(unsub);
  }

  close(): void {
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
      } catch (e) {
        getGlobalLogger().warn('SSEStream', 'Unsubscribe failed', { error: (e as Error)?.message });
      }
    }
    this.unsubscribers = [];
    this.subscribers = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
