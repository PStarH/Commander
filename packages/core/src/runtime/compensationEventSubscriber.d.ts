/**
 * CompensationEventSubscriber — Logs and records compensation bus events for observability.
 *
 * Subscribes to 'tool.compensation_planned' and 'tool.compensation_step' topics and:
 * 1. Logs via getGlobalLogger (structured JSON)
 * 2. Records metrics counters via getMetricsCollector
 * 3. Appends trace events via PersistentTraceStore for persistent storage
 *
 * Register in AgentRuntime constructor alongside other observability setup.
 */
import type { MessageBus } from './messageBus';
import type { PersistentTraceStore } from './traceStore';
export declare class CompensationEventSubscriber {
    private unsubPlanned;
    private unsubStep;
    /**
     * Subscribe to compensation events. Safe to call multiple times —
     * previous subscriptions are cleaned up before new ones are created.
     */
    start(bus: MessageBus, traceStore: PersistentTraceStore): void;
    /** Unsubscribe from all topics. Safe to call multiple times. */
    stop(): void;
}
//# sourceMappingURL=compensationEventSubscriber.d.ts.map