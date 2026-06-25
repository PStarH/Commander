/**
 * CycleCorrelator — Phase 2 / Hub Glue handler that consolidates
 * `agentRuntime`'s dual-emit `cycle_detected` (one `system.alert` event +
 * one `tool.blocked` event fired in immediate sequence from the same
 * `CycleDetector.check` gate at agentRuntime.ts:2388+ and :2563+) into ONE
 * downstream `runtime.cycle_correlated` event.
 *
 * Mechanism (Map-based pending registration, no external dependencies):
 *   - `system.alert` cycle_detected arrives first → register pending entry
 *     keyed by `${runId}:${toolName}:${description}` (runId is now carried
 *     in the system.alert payload itself — see
 *     {@link SystemAlertCycleDetected.runId}).
 *   - `tool.blocked` cycle_detected arrives → look up pending entry →
 *     emit `runtime.cycle_correlated` with `sourceEvents` pinning both
 *     original sources, then remove the pending entry.
 *   - If ordering is reversed (rare race — tool.blocked before system.alert),
 *     the same logic mirrors: tool.blocked registers, system.alert matches.
 *
 * Why runId is in the key (closes the concurrent-run false-positive window):
 *   The previous key `${toolName}:${description}` could not distinguish two
 *   concurrent runs that both triggered the same cycle-detect gate within
 *   the 5s TTL — a single misleading `runtime.cycle_correlated` event
 *   would be emitted, lumping two independent runs as one dedupe pair. By
 *   including `${runId}` in the key, only matching events from the SAME
 *   run pair dedupe. Distinct runs each get their own pending entry and
 *   their own downstream correlation.
 *
 * TTL: 5s window covers handler-execution lag and bus subscriber ordering
 * quirks. Beyond that, unpaired entries are silently dropped — partial
 * correlations are NOT emitted (would create misleading dedupe events).
 *
 * Back-compat note: SystemAlertCycleDetected.runId is OPTIONAL in the
 * type system; publishers that omit it (e.g. an out-of-tree
 * system.alert `cycle_detected` producer) will key with empty runId
 * and therefore only ever match a tool.blocked event that ALSO carries
 * an empty runId — they cannot false-correlate with runId-stamped
 * tool.blocked producers. The two in-tree producers at
 * agentRuntime.ts:2388+ and :2563+ both stamp runId since June 2026.
 */

import { getMessageBus } from '../../runtime/messageBus';
import type { MessageBus } from '../../runtime/messageBus';
import type { BusMessage, MessageBusTopic } from '../../runtime/types';

const CYCLE_CORRELATION_TTL_MS = 5_000;
const PRUNE_INTERVAL_MS = 30_000;
const MAX_PENDING_ENTRIES = 256;
const HUB_GLUE_SOURCE = 'hub-glue';

interface PendingCycle {
  runId: string;
  toolName: string;
  description: string;
  registeredAt: number;
  registeredFrom: 'system.alert' | 'tool.blocked';
}

/**
 * Build the dedup key. Empty `runId` is preserved verbatim so back-compat
 * producers (without runId stamping) only match each other.
 */
const cycleKey = (runId: string, toolName: string, description: string): string =>
  `${runId}:${toolName}:${description}`;

let instance: CycleCorrelator | null = null;

export class CycleCorrelator {
  private readonly pending = new Map<string, PendingCycle>();
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private installed = false;
  private systemAlertUnsub: (() => void) | null = null;

  /**
   * Install the system.alert subscriber that registers the leading-edge
   * `cycle_detected` payload. Idempotent across calls.
   */
  install(bus: MessageBus = getMessageBus()): void {
    if (this.installed) return;
    this.installed = true;
    // The MessageBus dispatcher wraps every subscriber in try/catch and
    // routes failures through its structured logger, so we don't re-wrap
    // here. Calling onSystemAlert directly avoids fighting the bus's
    // error-routing.

    this.systemAlertUnsub = bus.subscribe('system.alert', (msg: BusMessage) => {
      this.onSystemAlert(msg);
    });
    this.pruneInterval = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    // Don't keep the event loop alive just for pruning.
    if (typeof this.pruneInterval.unref === 'function') {
      this.pruneInterval.unref();
    }
  }

  /**
   * Called by the tool.blocked handler when its payload's reason is
   * `'cycle_detected'`. Folds the leading system.alert (or registers the
   * pending if tool.blocked arrived first).
   *
   * Match invariant: when the key matches, BOTH sides carry the same
   * runId (otherwise the key would have been different). The peer's
   * stored runId is therefore the authoritative value to forward to
   * the unified event — no probe-fallback dance needed.
   */
  observeToolBlocked(runId: string, toolName: string, description: string): void {
    const key = cycleKey(runId, toolName, description);
    const existing = this.pending.get(key);
    if (existing && existing.registeredFrom === 'system.alert') {
      this.fireUnified(existing.runId, toolName, description);
      this.pending.delete(key);
      return;
    }
    this.registerPending(key, runId, toolName, description, 'tool.blocked');
  }

  /**
   * Test/inspection accessor — current pending-entry count.
   * Used by the unit test to verify prune behavior.
   */
  getPendingCount(): number {
    return this.pending.size;
  }

  /**
   * Force-prune for testing. Production code uses the setInterval timer.
   */
  pruneNow(): number {
    const before = this.pending.size;
    this.prune();
    return before - this.pending.size;
  }

  /**
   * Drop the pending map and stop the prune timer. Safe to call when already
   * disposed.
   */
  dispose(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    if (this.systemAlertUnsub) {
      this.systemAlertUnsub();
      this.systemAlertUnsub = null;
    }
    this.pending.clear();
    this.installed = false;
  }

  private onSystemAlert(msg: BusMessage): void {
    const payload = msg.payload as
      | {
          type?: string;
          toolName?: string;
          description?: string;
          runId?: string;
        }
      | undefined;
    if (!payload || payload.type !== 'cycle_detected') return;
    if (typeof payload.toolName !== 'string' || typeof payload.description !== 'string') {
      return;
    }
    const toolName = payload.toolName;
    const description = payload.description;
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    const key = cycleKey(runId, toolName, description);
    const existing = this.pending.get(key);
    if (existing && existing.registeredFrom === 'tool.blocked') {
      // Key-match means runIds are equal across both sides; the peer's
      // stored runId is the authoritative value. Symmetric with
      // observeToolBlocked (no asymmetry between the two callers).
      this.fireUnified(existing.runId, toolName, description);
      this.pending.delete(key);
      return;
    }
    this.registerPending(key, runId, toolName, description, 'system.alert');
  }

  private registerPending(
    key: string,
    runId: string,
    toolName: string,
    description: string,
    from: 'system.alert' | 'tool.blocked',
  ): void {
    if (this.pending.size >= MAX_PENDING_ENTRIES) {
      // FIFO eviction: Map iteration order = insertion order in JS, so
      // `keys().next()` returns the oldest entry.
      const firstKey = this.pending.keys().next().value;
      if (typeof firstKey === 'string') {
        this.pending.delete(firstKey);
      }
    }
    this.pending.set(key, {
      runId,
      toolName,
      description,
      registeredAt: Date.now(),
      registeredFrom: from,
    });
  }

  private fireUnified(runId: string, toolName: string, description: string): void {
    // Publish via the bus — typed overload <'runtime.cycle_correlated'>
    // enforces the BusPayloadMap shape at compile time.
    const payload = {
      runId,
      toolName,
      description,
      sourceEvents: ['system.alert', 'tool.blocked'] as ['system.alert', 'tool.blocked'],
      correlatedAt: new Date().toISOString(),
    };
    getMessageBus().publish(
      'runtime.cycle_correlated' as MessageBusTopic,
      HUB_GLUE_SOURCE,
      payload,
    );
  }

  /** Periodically drop entries older than the TTL. */
  private prune(): void {
    const cutoff = Date.now() - CYCLE_CORRELATION_TTL_MS;
    for (const [k, v] of this.pending) {
      if (v.registeredAt < cutoff) {
        this.pending.delete(k);
      }
    }
  }
}

export function getCycleCorrelator(): CycleCorrelator {
  if (!instance) instance = new CycleCorrelator();
  return instance;
}

/** Reset the singleton — used by tests to start from a clean state. */
export function _resetCycleCorrelatorForTests(): void {
  if (instance) {
    instance.dispose();
  }
  instance = null;
}
