/**
 * Hub Glue: SemanticCircuitCorrelator — Phase 2 retrospective pairing.
 *
 * What this test covers:
 *   1. Forward dedupe — system.alert `semantic_circuit_trip` +
 *      tool.blocked `circuit_broken` carrying the same runId within
 *      5s TTL fold into ONE `runtime.circuit_correlated` event with
 *      `sourceEvents: ['system.alert', 'tool.blocked']`. Both producers
 *      stamp `runId`: the alert side via the new
 *      `recordSemanticFailure(reason, ctx)` ctx-thread, the block side
 *      natively (since guardianBlock / orchestrator denial paths
 *      always carry runId in their tool.blocked emits).
 *   2. Reversed-order dedupe — if a `circuit_broken` tool.blocked
 *      arrives before the `semantic_circuit_trip` alert, the
 *      correlator still matches the pair without double-emitting.
 *   3. Concurrent-run isolation — two distinct runIds firing the
 *      semantic-trip-then-circuit-broken sequence produce TWO
 *      separate unified events (regression test for runId-strengthened
 *      multi-run safety).
 *   4. Stale-pending pruning — entries older than 5s dropped on
 *      `pruneNow()` without emitting a unified event.
 *   5. Structural-difference tolerance — alert's `reason` (the
 *      verification failure msg) and block's `detail` (the broken
 *      circuit provider name) are structurally different strings,
 *      but the correlator still pairs them via `ignoreContextKey: true`
 *      + `requireToolNameOnAlert: false`.
 *   6. Atomic-metric dual-observation — `tool_blocked_total` metric
 *      counter still fires for `circuit_broken` (the correlator
 *      does NOT replace the metric).
 *
 * Notes:
 *   - The singleton CircuitBreaker emits `semantic_circuit_trip` from
 *     a constructor-wired closure in agentRuntime.ts. The bus
 *     subscriber pattern matches the agentRuntime.ts:366 closure's
 *     payload shape.
 *   - never-guard compile-time exhaustiveness for ToolBlockedVariant
 *     lives in toolBlockedHandler.ts and is enforced by the package
 *     typecheck (not this test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetMessageBus, getMessageBus, MessageBus } from '../../src/runtime/messageBus';
import {
  installToolBlockedHandler,
  uninstallToolBlockedHandler,
  _resetToolBlockedHandlerForTests,
} from '../../src/hub/handlers/toolBlockedHandler';
import {
  getSemanticCircuitCorrelator,
  _resetSemanticCircuitCorrelatorForTests,
} from '../../src/hub/handlers/semanticCircuitCorrelator';
import { _resetHubGlueForTests } from '../../src/hub';
import { resetMetricsCollector, getMetricsCollector } from '../../src/runtime/metricsCollector';
import type { BusMessage, MessageBusTopic } from '../../src/runtime/types';

function publishCircuitBroken(
  bus: MessageBus,
  runId: string,
  toolName: string,
  detail: string,
  source = 'agent-r1',
): void {
  bus.publish('tool.blocked', source, {
    runId,
    toolName,
    reason: 'circuit_broken',
    detail,
  });
}

function publishSemanticCircuitTrip(
  bus: MessageBus,
  runId: string,
  reason: string,
  consecutiveFailures = 3,
  source = 'runtime',
): void {
  bus.publish('system.alert', source, {
    type: 'semantic_circuit_trip',
    consecutiveFailures,
    reason,
    runId,
  });
}

describe('Hub Glue: SemanticCircuitCorrelator — Phase 2 retrospective pairing', () => {
  let bus: MessageBus;

  beforeEach(() => {
    _resetHubGlueForTests();
    _resetSemanticCircuitCorrelatorForTests();
    _resetToolBlockedHandlerForTests();
    resetMessageBus();
    resetMetricsCollector();
    bus = getMessageBus();
    installToolBlockedHandler();
  });

  afterEach(() => {
    uninstallToolBlockedHandler();
    _resetSemanticCircuitCorrelatorForTests();
    _resetHubGlueForTests();
    _resetToolBlockedHandlerForTests();
    resetMessageBus();
  });

  it('correlates system.alert semantic_circuit_trip + tool.blocked circuit_broken (same runId) into ONE runtime.circuit_correlated event', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.circuit_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const runId = 'run-S1';
      const toolName = 'shell_execute';
      const reasonOnAlertSide = 'verification_failed: hallucination';
      const detailOnBlockSide = 'agent-runtime';
      publishSemanticCircuitTrip(bus, runId, reasonOnAlertSide);
      publishCircuitBroken(bus, runId, toolName, detailOnBlockSide);

      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe(runId);
      // First-arriving peer contextKey wins; alert fires first → reason.
      expect(received[0].payload.reason).toBe(reasonOnAlertSide);
      expect(received[0].payload.sourceEvents).toEqual(['system.alert', 'tool.blocked']);
      expect(typeof received[0].payload.correlatedAt).toBe('string');
      expect(getSemanticCircuitCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('handles reversed-order publish (tool.blocked circuit_broken before system.alert semantic_circuit_trip) without double-emitting', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.circuit_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const runId = 'run-S2';
      const toolName = 'python_execute';
      const reasonOnAlertSide = 'verification_failed: low_confidence';
      const detailOnBlockSide = 'reliability-engine';
      publishCircuitBroken(bus, runId, toolName, detailOnBlockSide);
      publishSemanticCircuitTrip(bus, runId, reasonOnAlertSide);

      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe(runId);
      // tool.blocked arrived first → block's detail wins as the info-only contextKey.
      expect(received[0].payload.reason).toBe(detailOnBlockSide);
      expect(getSemanticCircuitCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('emits TWO separate runtime.circuit_correlated events for concurrent runs hitting the semantic-trip pattern within the 5s TTL (runId disambiguation)', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.circuit_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const toolName = 'shell_execute';
      const reason = 'verification_failed: anomaly';
      const detail = 'agent-runtime';
      publishSemanticCircuitTrip(bus, 'run-conc-A', reason);
      publishCircuitBroken(bus, 'run-conc-A', toolName, detail);
      publishSemanticCircuitTrip(bus, 'run-conc-B', reason);
      publishCircuitBroken(bus, 'run-conc-B', toolName, detail);

      expect(received).toHaveLength(2);
      const runIds = received.map((r) => r.payload.runId).sort();
      expect(runIds).toEqual(['run-conc-A', 'run-conc-B']);
      for (const evt of received) {
        expect(evt.payload.reason).toBe(reason);
        expect(evt.payload.sourceEvents).toEqual(['system.alert', 'tool.blocked']);
      }
      expect(getSemanticCircuitCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('drops pending entries older than the TTL on pruneNow()', () => {
    publishSemanticCircuitTrip(bus, 'run-stale-circuit', 'verification_failed');
    expect(getSemanticCircuitCorrelator().getPendingCount()).toBe(1);

    const correlator = getSemanticCircuitCorrelator();
    type WithMutablePending = { pair: { pending: Map<string, { registeredAt: number }> } };
    const mutable = correlator as unknown as WithMutablePending;
    for (const entry of mutable.pair.pending.values()) {
      entry.registeredAt = Date.now() - 10_000; // older than TTL (5s)
    }
    const pruned = correlator.pruneNow();
    expect(pruned).toBe(1);
    expect(correlator.getPendingCount()).toBe(0);
  });

  it('tolerates structural field-shape differences between alert `reason` and block `detail` (regression test — composer would fail at the 3-tuple stage)', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.circuit_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const runId = 'run-shape-circuit';
      const toolName = 'shell_execute';
      const reasonOnAlert = 'verification_failed: llm_drift';
      // Block side `detail` is structurally a circuit provider name, NOT
      // the alert's reason — structural asymmetry that would 3-tuple-fail.
      const detailOnBlock = 'openai-circuit';
      publishSemanticCircuitTrip(bus, runId, reasonOnAlert);
      publishCircuitBroken(bus, runId, toolName, detailOnBlock);

      // ignoreContextKey: true + requireToolNameOnAlert: false makes
      // runId alone the match signal; structurally different strings
      // on the alert vs. block side STILL correlate.
      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe(runId);
      expect(received[0].payload.reason).toBe(reasonOnAlert);
      expect(getSemanticCircuitCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('still emits the tool_blocked_total metric for circuit_broken (dual-observation: metric + correlator)', () => {
    const collector = getMetricsCollector();
    const incSpy = vi.spyOn(collector, 'incrementCounter');

    bus.publish('tool.blocked', 'agent-r6', {
      runId: 'run-S6',
      toolName: 'shell_execute',
      reason: 'circuit_broken',
      detail: 'metric-test',
    });

    const matched = incSpy.mock.calls.find(([name]: unknown[]) => name === 'tool_blocked_total');
    expect(matched).toBeDefined();
  });
});
