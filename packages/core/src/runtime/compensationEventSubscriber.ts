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

import { reportSilentFailure } from '../silentFailureReporter';
import type { MessageBus } from './messageBus';
import type { PersistentTraceStore } from './traceStore';
import { getGlobalLogger } from '../logging';
import { getMetricsCollector } from './metricsCollector';

export class CompensationEventSubscriber {
  private unsubPlanned: (() => void) | null = null;
  private unsubStep: (() => void) | null = null;

  /**
   * Subscribe to compensation events. Safe to call multiple times —
   * previous subscriptions are cleaned up before new ones are created.
   */
  start(bus: MessageBus, traceStore: PersistentTraceStore): void {
    // Clean up previous subscriptions if re-starting
    this.stop();

    this.unsubPlanned = bus.subscribe('tool.compensation_planned', (msg) => {
      const { toolName, stepCount, risk, runId } = msg.payload;

      // 1. Structured log
      getGlobalLogger().info('CompensationEvent', 'Compensation planned', {
        toolName,
        stepCount,
        risk,
        runId,
      });

      // 2. Metrics counters
      try {
        getMetricsCollector().incrementCounter(
          'compensation_planned_total',
          'Total compensation plans created',
          1,
          [
            { name: 'tool', value: toolName },
            { name: 'risk', value: risk },
          ],
        );
      } catch (err) {
        reportSilentFailure(err, 'compensationEventSubscriber:52');
        /* best-effort */
      }

      // 3. Persistent trace event
      try {
        traceStore.append({
          schemaVersion: 1,
          id: `comp-planned-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          spanId: `comp-planned-${runId}`,
          traceId: runId,
          runId,
          agentId: 'system',
          type: 'state_change',
          timestamp: new Date().toISOString(),
          durationMs: 0,
          data: {
            input: { toolName, stepCount, risk },
            output: { status: 'planned' },
          },
        });
      } catch (err) {
        reportSilentFailure(err, 'compensationEventSubscriber:74');
        /* best-effort */
      }
    });

    this.unsubStep = bus.subscribe('tool.compensation_step', (msg) => {
      const { toolName, actionId, stepIndex, totalSteps, status, error, runId } = msg.payload;

      // 1. Structured log
      const totalStr = `[${stepIndex + 1}/${totalSteps}]`;
      getGlobalLogger().info(
        'CompensationEvent',
        `Compensation step ${totalStr}: ${toolName} -> ${status}`,
        {
          toolName,
          actionId,
          stepIndex,
          totalSteps,
          status,
          error,
          runId,
        },
      );

      // 2. Metrics counters and latency
      try {
        getMetricsCollector().recordStepLatency('compensation', 0);
        getMetricsCollector().incrementCounter(
          'compensation_steps_total',
          'Total compensation steps by status',
          1,
          [
            { name: 'tool', value: toolName },
            { name: 'status', value: status },
          ],
        );
      } catch (err) {
        reportSilentFailure(err, 'compensationEventSubscriber:111');
        /* best-effort */
      }

      // 3. Persistent trace event
      try {
        traceStore.append({
          schemaVersion: 1,
          id: `comp-step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          spanId: `comp-step-${runId}-${stepIndex}`,
          traceId: runId,
          runId,
          agentId: 'system',
          type: 'state_change',
          timestamp: new Date().toISOString(),
          durationMs: 0,
          data: {
            input: { toolName, actionId, stepIndex, totalSteps },
            output: { status, error },
          },
        });
      } catch (err) {
        reportSilentFailure(err, 'compensationEventSubscriber:133');
        /* best-effort */
      }
    });
  }

  /** Unsubscribe from all topics. Safe to call multiple times. */
  stop(): void {
    if (this.unsubPlanned) {
      this.unsubPlanned();
      this.unsubPlanned = null;
    }
    if (this.unsubStep) {
      this.unsubStep();
      this.unsubStep = null;
    }
  }

  /**
   * Test-only accessor: returns whether bus subscriptions are currently
   * active. True after `start()` until `stop()` is called. Lets async-
   * migration / lifecycle tests assert pre/post-dispose subscriber
   * state without reaching into the TypeScript-private `unsubPlanned`
   * and `unsubStep` unsubscribe handles, which would couple the test
   * to the internal field names.
   *
   * @internal — not part of the supported CompensationEventSubscriber
   *             interface.
   */
  isSubscribed(): boolean {
    return this.unsubPlanned !== null && this.unsubStep !== null;
  }
}
