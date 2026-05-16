import type { BusMessage, MessageBusTopic } from './types';
import { getMessageBus } from './messageBus';

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
  | 'output.delta'
  | 'output.completed'
  | 'diff.available'
  | 'error.occurred';

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
  private readonly HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

  constructor(topics?: MessageBusTopic[]) {
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
    this.heartbeatTimer = setInterval(() => {
      if (!this.closed) {
        this.dispatch(': heartbeat\n\n');
      }
    }, this.HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  emitStructured(eventType: StructuredSSEEventType, data: Record<string, unknown>): void {
    if (this.closed) return;
    const event: StructuredSSEEvent = {
      event: eventType,
      data,
      timestamp: new Date().toISOString(),
      seq: ++this.seqCounter,
    };
    this.dispatch(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private emitRaw(data: Record<string, unknown>): void {
    this.dispatch(`data: ${JSON.stringify(data)}\n\n`);
  }

  private dispatch(payload: string): void {
    for (const subscriber of this.subscribers) {
      try { subscriber(payload); } catch { /* ignore */ }
    }
  }

  emitReasoning(content: string): void {
    this.emitStructured('reasoning.delta', { content, length: content.length });
  }

  emitToolCall(toolName: string, status: 'started' | 'completed' | 'delta', detail?: Record<string, unknown>): void {
    const eventType = status === 'started' ? 'tool_call.started'
      : status === 'completed' ? 'tool_call.completed'
      : 'tool_call.delta';
    this.emitStructured(eventType, { toolName, ...detail });
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
        try { writable.write(event); } catch { this.close(); }
      }
    });
    this.unsubscribers.push(unsub);
  }

  close(): void {
    this.closed = true;
    // GAP-28: Stop heartbeat timer on close
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.unsubscribers = [];
    this.subscribers = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
