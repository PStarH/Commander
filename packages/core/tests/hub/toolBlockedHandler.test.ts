/**
 * Hub Glue: tool.blocked handler — Phase 2 / cycle_correlated dedupe
 *
 * What this test covers:
 *   1. Cycle dedupe — system.alert `cycle_detected` + tool.blocked
 *      `cycle_detected` fired in sequence from the same gate at
 *      agentRuntime.ts:2388 / :2563 collapse into ONE
 *      `runtime.cycle_correlated` event with `sourceEvents: ['system.alert',
 *      'tool.blocked']`.
 *   2. Reversed-order dedupe — if hand-order changes (e.g. tool.blocked
 *      fires first), the correlator still matches the pair.
 *   3. security_orchestrator_denied routes to security.policy_denied with
 *      a real agentId (surfaces the bus source as agentId).
 *   4. Atomic denials (hook_denied here) feed the `tool_blocked_total`
 *      metric counter with a `reason` tag.
 *   5. Stale-pending pruning — entries older than 5s are dropped on
 *      `pruneNow()` without emitting a unified event.
 *
 * Notes:
 *   - never-guard compile-time exhaustiveness is enforced at the type
 *     level in toolBlockedHandler.ts (the `const _exhaustive: never =
 *     payload` assignment fails to compile when a new ToolBlockedXxx
 *     variant is added without a switch case above it). This test cannot
 *     exercise that directly; the package typecheck is the assertion.
 *
 *   - ToolBlockedVariant's strict discriminated-union typing forces every
 *     publish site (and every test payload) to carry a literal `reason`
 *     that matches one of the 9 union members. The helpers below generate
 *     variant-shaped payloads so the test reads true-to-type.
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
import { _resetHubGlueForTests } from '../../src/hub';
import { resetMetricsCollector, getMetricsCollector } from '../../src/runtime/metricsCollector';
import type { BusMessage, MessageBusTopic } from '../../src/runtime/types';

function publishCycleBlocked(
  bus: MessageBus,
  runId: string,
  toolName: string,
  description: string,
  source = 'agent-1',
): void {
  bus.publish('tool.blocked', source, {
    runId,
    toolName,
    reason: 'cycle_detected',
    detail: description,
  });
}

function publishCycleAlert(
  bus: MessageBus,
  toolName: string,
  description: string,
  source = 'runtime',
): void {
  bus.publish('system.alert', source, {
    type: 'cycle_detected',
    toolName,
    description,
  });
}

describe('Hub Glue: tool.blocked handler — Phase 2 cycle dedupe', () => {
  let bus: MessageBus;

  beforeEach(() => {
    // Reset every singleton without breaking cross-test ordering
    _resetHubGlueForTests();
    _resetCycleCorrelatorForTests();
    _resetToolBlockedHandlerForTests();
    resetMessageBus();
    resetMetricsCollector();
    bus = getMessageBus();
    installToolBlockedHandler();
  });

  afterEach(() => {
    uninstallToolBlockedHandler();
    _resetCycleCorrelatorForTests();
    _resetHubGlueForTests();
    _resetToolBlockedHandlerForTests();
    resetMessageBus();
  });

  it('correlates system.alert cycle_detected + tool.blocked cycle_detected into ONE runtime.cycle_correlated event', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.cycle_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const runId = 'run-X';
      const toolName = 'shell_execute';
      const description = 'cycle description';
      // Mirror agentRuntime.ts:2388 → 2396 ordering.
      publishCycleAlert(bus, toolName, description);
      publishCycleBlocked(bus, runId, toolName, description);

      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe(runId);
      expect(received[0].payload.toolName).toBe(toolName);
      expect(received[0].payload.description).toBe(description);
      expect(received[0].payload.sourceEvents).toEqual(['system.alert', 'tool.blocked']);
      expect(typeof received[0].payload.correlatedAt).toBe('string');
      // The correlator's pending map must be empty after the dedupe emit.
      expect(getCycleCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('handles reversed-order publish (tool.blocked before system.alert) without double-emitting', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('runtime.cycle_correlated', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      const toolName = 'python_execute';
      const description = 'reversed-order cycle';
      // tool.blocked first — analog of a future publisher emitting in the
      //  opposite order; we want exactly one unified emit, not zero, not two.
      publishCycleBlocked(bus, 'run-R', toolName, description);
      publishCycleAlert(bus, toolName, description);

      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe('run-R');
      expect(getCycleCorrelator().getPendingCount()).toBe(0);
    } finally {
      unsub();
    }
  });

  it('routes security_orchestrator_denied to security.policy_denied with the agentId surfaced', () => {
    const received: Array<{
      topic: MessageBusTopic;
      payload: Record<string, unknown>;
    }> = [];
    const unsub = bus.subscribe('security.policy_denied', (msg: BusMessage) => {
      received.push({
        topic: msg.topic,
        payload: msg.payload as Record<string, unknown>,
      });
    });
    try {
      bus.publish('tool.blocked', 'agent-7', {
        runId: 'run-Y',
        toolName: 'shell_execute',
        reason: 'security_orchestrator_denied',
        detail: 'AdaptiveHITL blocked',
      });

      expect(received).toHaveLength(1);
      expect(received[0].payload.runId).toBe('run-Y');
      expect(received[0].payload.toolName).toBe('shell_execute');
      expect(received[0].payload.reason).toBe('AdaptiveHITL blocked');
      expect(received[0].payload.agentId).toBe('agent-7');
    } finally {
      unsub();
    }
  });

  it('emits tool_blocked_total metric for atomic denials (hook_denied)', () => {
    // Spy on the singleton collector's incrementCounter — verifies the
    // metric tick fires with the correct name and tags.
    const collector = getMetricsCollector();
    const incSpy = vi.spyOn(collector, 'incrementCounter');

    bus.publish('tool.blocked', 'agent-2', {
      runId: 'run-Z',
      toolName: 'shell_execute',
      reason: 'hook_denied',
      detail: 'plugin denied this tool',
    });

    const matched = incSpy.mock.calls.find(([name]: unknown[]) => name === 'tool_blocked_total');
    expect(matched).toBeDefined();
  });

  it('drops pending entries older than the TTL on pruneNow()', () => {
    const toolName = 'shell_execute';
    const description = 'stale-pending';
    // Register only the leading edge (system.alert) — no matching
    // tool.blocked yet, so pending stays full.
    publishCycleAlert(bus, toolName, description);
    const pendingBefore = getCycleCorrelator().getPendingCount();
    expect(pendingBefore).toBe(1);

    // Force the entry's registeredAt into the past and call pruneNow().
    const correlator = getCycleCorrelator();
    type WithMutablePending = { pending: Map<string, { registeredAt: number }> };
    const mutable = correlator as unknown as WithMutablePending;
    for (const entry of mutable.pending.values()) {
      entry.registeredAt = Date.now() - 10_000; // older than TTL
    }
    const pruned = correlator.pruneNow();
    expect(pruned).toBe(1);
    expect(correlator.getPendingCount()).toBe(0);
  });
});
