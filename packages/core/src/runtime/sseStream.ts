import type { BusMessage } from './types';
import { getMessageBus } from './messageBus';

/**
 * SSE (Server-Sent Events) stream for real-time agent execution visibility.
 *
 * Subscribes to the message bus and formats events as SSE-compatible strings.
 * The orchestrator already emits events via getMessageBus() — this class
 * bridges those events to an HTTP response stream.
 *
 * Usage in an HTTP server:
 *   const stream = new SSEStream();
 *   res.writeHead(200, {
 *     'Content-Type': 'text/event-stream',
 *     'Cache-Control': 'no-cache',
 *     'Connection': 'keep-alive',
 *   });
 *   stream.pipe(res);
 *   // ... run agent ...
 *   stream.close();
 */
export class SSEStream {
  private subscribers: Array<(event: string) => void> = [];
  private unsubscribers: Array<() => void> = [];
  private closed = false;

  constructor(topics?: string[]) {
    const bus = getMessageBus();
    const watchTopics = (topics ?? [
      'agent.started',
      'agent.completed',
      'agent.failed',
      'agent.message',
      'mission.updated',
      'mission.blocked',
      'mission.completed',
      'system.alert',
      'tool.executed',
    ]) as any[];

    for (const topic of watchTopics) {
      const unsub = bus.subscribe(topic, (message: BusMessage) => {
        if (this.closed) return;
        this.emit({
          topic: message.topic,
          source: message.source,
          payload: message.payload,
          timestamp: message.timestamp,
          priority: message.priority,
        });
      });
      this.unsubscribers.push(unsub);
    }
  }

  private emit(data: Record<string, unknown>): void {
    const event = `data: ${JSON.stringify(data)}\n\n`;
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch { /* ignore */ }
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
