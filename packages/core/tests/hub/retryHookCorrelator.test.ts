/**
 * Hub Glue: RetryHookCorrelator — Phase 2 retrospective pairing.
 *
 * What this test covers:
 *   1. Forward dedupe — system.alert `retry_loop_detected` +
 *      tool.blocked `hook_denied` carrying the same (runId, toolName,
 *      pattern) within 5s TTL fold into ONE
 *      `runtime.retry_block_correlated` event with `sourceEvents:
 *      ['system.alert', 'tool.blocked']` and a `pattern` field equal to
 *      the shared key.
 *   2. Reversed-order dedupe — tool.blocked first (a hook denial
 *      before the retry-loop detector flips), then system.alert — the
 *      correlator still matches the pair without double-emitting.
 *   3. Concurrent-run isolation — two distinct runIds firing the same
 *      toolName+pattern within the TTL produce TWO separate unified
 *      events (regression test for the same false-positive window closed
 *      for cycle_detection in the prior PR).
 *   4. Stale-pending pruning — entries older than 5s are dropped on
 *      `pruneNow()` without emitting a unified event.
 *
 * Notes:
 *   - The hook_denied tool.blocked payload's `detail` field is the
 *     conceptual key we use to link back to the retry_loop_detected
 *     `pattern` field. In production these can differ (the hook
 *     message describes the rejection; the pattern is `<tool>:<args>`),
 *     so the test uses a literal `'pattern:retry:loop'` string in BOTH
 *     sides to deliberately force a match-as-fixture.
 *   - never-guard compile-time exhaustiveness for tool.blocked variants
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
  getCycleCorrelator,
  _resetCycleCorrelatorForTests,
} from '../../src/hub/handlers/cycleCorrelator';
import {
  getRetryHookCorrelator,
  _resetRetryHookCorrelatorForTests,
} from '../../src/hub/handlers/retryHookCorrelator';
import { _resetHubGlueForTests } from '../../src/hub';
import { resetMetricsCollector, getMetricsCollector } from '../../src/runtime/metricsCollector';
import type { BusMessage, MessageBusTopic } from '../../src/runtime/types';

function publishHookDenied(
  bus: MessageBus,
  runId: string,
  toolName: string,
  detail: string,
  source = 'agent-r1',
): void {
  bus.publish('tool.blocked', source, {
    runId,
    toolName,
    reason: 'hook_denied',
    detail,
  });
}

function publishRetryLoopAlert(
  bus: MessageBus,
  runId: string,
  toolName: string,
  pattern: string,
  source = 'runtime',
): void {
  bus.publish('system.alert', source, {
    type: 'retry_loop_detected',
    toolName,
    pattern,
    consecutiveCalls: 3,
    toolLoopCount: 3,
    runId,
  });
}

describe('Hub Glue: RetryHookCorrelator — Phase 2 retrospective pairing', () => {
  let bus: MessageBus;

  beforeEach(() => {
    // Reset every singleton + the bus without breaking cross-test ordering
    _resetHubGlueForTests();
    _resetCycleCorrelatorForTests();
    _resetRetryHookCorrelatorForTests();
    _resetToolBlockedHandlerForTests();
    resetMessageBus();
    resetMetricsCollector();
    bus = getMessageBus();
    installToolBlockedHandler();
  });

  afterEach(() => {
    uninstallToolBlockedHandler();
    _resetCycleCorrelatorForTests();
    _resetRetryHookCorrelatorForTests();
    _resetHubGlueForTests();
    _resetToolBlockedHandlerForTests();
    resetMessageBus();
  });

  it('correlates system.alert retry_loop_detected + tool.blocked hook_denied (same runId+pattern) into ONE runtime.retry_block_correlated event', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.retry_block_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const runId = 'run-R1';
      const toolName = 'shell_execute';
      const pattern = 'pattern:retry:loop';
      // system.alert first, tool.blocked second (typical observe order).
      publishRetryLoopAlert(bus, runId, toolName, pattern);
      publishHookDenied(bus, runId, toolName, pattern);

      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe(runId);
      expect(received[0].payload.toolName).toBe(toolName);
      expect(received[0].payload.pattern).toBe(pattern);
      expect(received[0].payload.sourceEvents).toEqual(['system.alert', 'tool.blocked']);
      expect(typeof received[0].payload.correlatedAt).toBe('string');
      // The correlator's pending map must be empty after the dedupe emit.
      expect(getRetryHookCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('handles reversed-order publish (tool.blocked hook_denied before system.alert retry_loop_detected) without double-emitting', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.retry_block_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const runId = 'run-R2';
      const toolName = 'python_execute';
      const pattern = 'pattern:retry:loop:reversed';
      publishHookDenied(bus, runId, toolName, pattern);
      publishRetryLoopAlert(bus, runId, toolName, pattern);

      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe(runId);
      expect(received[0].payload.toolName).toBe(toolName);
      expect(received[0].payload.pattern).toBe(pattern);
      expect(getRetryHookCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('emits TWO separate runtime.retry_block_correlated events for concurrent runs hitting the same tool+pattern (runId disambiguation regression test)', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.retry_block_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const toolName = 'shell_execute';
      const pattern = 'pattern:retry:loop:concurrent';
      publishRetryLoopAlert(bus, 'run-conc-A', toolName, pattern);
      publishHookDenied(bus, 'run-conc-A', toolName, pattern);
      publishRetryLoopAlert(bus, 'run-conc-B', toolName, pattern);
      publishHookDenied(bus, 'run-conc-B', toolName, pattern);

      expect(received).toHaveLength(2);
      const runIds = received.map((r) => r.payload.runId).sort();
      expect(runIds).toEqual(['run-conc-A', 'run-conc-B']);
      for (const evt of received) {
        expect(evt.payload.toolName).toBe(toolName);
        expect(evt.payload.pattern).toBe(pattern);
        expect(evt.payload.sourceEvents).toEqual(['system.alert', 'tool.blocked']);
      }
      expect(getRetryHookCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('drops pending entries older than the TTL on pruneNow()', () => {
    const toolName = 'shell_execute';
    const pattern = 'pattern:retry:loop:stale';
    // Register only the leading edge (system.alert) — no matching
    // tool.blocked yet, so pending stays full.
    publishRetryLoopAlert(bus, 'run-stale-retry', toolName, pattern);
    const pendingBefore = getRetryHookCorrelator().getPendingCount();
    expect(pendingBefore).toBe(1);

    // Force the entry's registeredAt into the past and call pruneNow().
    const correlator = getRetryHookCorrelator();
    type WithMutablePending = { pair: { pending: Map<string, { registeredAt: number }> } };
    const mutable = correlator as unknown as WithMutablePending;
    for (const entry of mutable.pair.pending.values()) {
      entry.registeredAt = Date.now() - 10_000; // older than TTL (5s)
    }
    const pruned = correlator.pruneNow();
    expect(pruned).toBe(1);
    expect(correlator.getPendingCount()).toBe(0);
  });

  it('still emits the tool_blocked_total metric for hook_denied (dual-observation: metric + correlator)', () => {
    // The retry+hook correlator does NOT replace the atomic-denial metric.
    // Both fire because bus subscribers don't exclude each other.
    const collector = getMetricsCollector();
    const incSpy = vi.spyOn(collector, 'incrementCounter');

    bus.publish('tool.blocked', 'agent-r4', {
      runId: 'run-R4',
      toolName: 'shell_execute',
      reason: 'hook_denied',
      detail: 'pattern:nometric',
    });

    const matched = incSpy.mock.calls.find(([name]: unknown[]) => name === 'tool_blocked_total');
    expect(matched).toBeDefined();
  });
});
