// ─────────────────────────────────────────────────────────────────────────────
// EventSourcingSubscriber
//
// Subscribes to MessageBus topics that represent the agent execution
// lifecycle (LLM calls, tool executions, checkpoints, compensations,
// agent state changes) and forwards them to the EventSourcingEngine's
// WAL with a SHA-256 hash chain.
//
// This enables state reconstruction from the event log — the foundation
// for Temporal-style replay recovery (Phase 2) — without invading the
// agentRuntime.ts God object. The subscriber is fully decoupled: if the
// EventSourcingEngine fails, agent runtime continues unaffected.
//
// Design principles:
// - Fire-and-forget: never blocks the message bus critical path
// - Silent failure: errors are reported via reportSilentFailure, never thrown
// - Zero invasion: subscribes to existing topics, no changes to publishers
// ─────────────────────────────────────────────────────────────────────────────

import type { MessageBus } from './messageBus';
import type { MessageBusTopic } from './types/messageBus';
import { getGlobalEventSourcingEngine, type EventSourcingEngine } from './eventSourcingEngine';
import { reportSilentFailure } from '../silentFailureReporter';

/**
 * Topics that represent agent execution lifecycle events worth
 * persisting to the event sourcing WAL for state reconstruction.
 *
 * Note: RunLedger state transitions (run.started/executing/verifying/
 * committed/aborted, action.recorded) are already synced directly in
 * runLedger.ts via emitSourcingEvent(). This subscriber covers the
 * events that flow through the MessageBus but not through RunLedger.
 */
const LIFECYCLE_TOPICS: MessageBusTopic[] = [
  'tool.started',
  'tool.completed',
  'tool.timeout',
  'tool.retry',
  'tool.compensation_planned',
  'tool.compensation_step',
  'agent.started',
  'agent.completed',
  'agent.failed',
  'agent.interrupted',
  'trace.recorded',
];

export class EventSourcingSubscriber {
  private unsubscribe: (() => void) | null = null;
  private started = false;

  constructor(
    private bus: MessageBus,
    private engine: EventSourcingEngine = getGlobalEventSourcingEngine(),
  ) {}

  /**
   * Start subscribing to lifecycle topics and forwarding events to the
   * EventSourcingEngine WAL. Idempotent — safe to call multiple times.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribe = this.bus.subscribeMany(LIFECYCLE_TOPICS, (msg) => {
      this.forward(msg).catch((err: unknown) => {
        reportSilentFailure(err, 'eventSourcingSubscriber:forward');
      });
    });
  }

  /**
   * Stop subscribing. Idempotent.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.started = false;
  }

  /**
   * Forward a single bus message to the EventSourcingEngine WAL.
   * The message topic becomes the event type; the payload is preserved.
   */
  private async forward(msg: {
    topic: MessageBusTopic;
    source?: string;
    payload?: unknown;
    runId?: string;
  }): Promise<void> {
    try {
      await this.engine.append({
        type: `bus.${msg.topic}`,
        payload: {
          topic: msg.topic,
          source: msg.source,
          data: msg.payload,
        },
        correlationId: msg.runId,
      });
    } catch (err) {
      reportSilentFailure(err, 'eventSourcingSubscriber:forward:append');
    }
  }

  /** Check if the subscriber is currently active. */
  get isRunning(): boolean {
    return this.started;
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let globalSubscriber: EventSourcingSubscriber | null = null;

/**
 * Get or create the global EventSourcingSubscriber singleton.
 * The subscriber is not started automatically — call start() after
 * the MessageBus and EventSourcingEngine are both initialized.
 */
export function getGlobalEventSourcingSubscriber(bus?: MessageBus): EventSourcingSubscriber {
  if (!globalSubscriber) {
    const messageBus = bus ?? require('./messageBus').getMessageBus();
    globalSubscriber = new EventSourcingSubscriber(messageBus);
  }
  return globalSubscriber;
}
