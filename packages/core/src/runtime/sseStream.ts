import type { BusMessage, MessageBusTopic } from './types';
import { getMessageBus } from './messageBus';
import { getGlobalLogger } from '../logging';

/**
 * Structured SSE event types for real-time agent execution visibility.
 *
 * Reference: Codex CLI's OutputItemDone, ToolCallInputDelta, ReasoningContentDelta events.
 * Commander adds richer structure with status, thinking, and diff events.
 */
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
  | 'sop.update';

export interface StructuredSSEEvent {
  event: StructuredSSEEventType;
  data: Record<string, unknown>;
  timestamp: string;
  seq: number;
}

export class SSEStream {
  private subscribers: Array<(event: string) => void> = [];
  private unsubscribers: Array<() => void> = [];
  private closed = false;
  private seqCounter = 0;
  // GAP-28: Heartbeat to keep SSE connections alive through proxies
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;
  /** Reconnection interval in ms (sent to client via `retry:` field) */
  private readonly retryMs: number;
  /** Buffer of recent events for Last-Event-ID replay (ring buffer) */
  private eventBuffer: Array<{ id: number; payload: string }> = [];
  private readonly maxBufferSize: number;

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

    // GAP-28: Start heartbeat to prevent proxy/load-balancer timeouts
    if (this.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (!this.closed) {
          this.dispatch(': heartbeat\n\n');
        }
      }, this.heartbeatIntervalMs);
      if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }

    // Send retry interval on connection so clients know how long to wait before reconnecting
    this.dispatch(`retry: ${this.retryMs}\n\n`);
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
