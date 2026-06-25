/**
 * CycleCorrelator — Phase 2 / Hub Glue handler that consolidates
 * `agentRuntime`'s dual-emit `cycle_detected` (one `system.alert` event +
 * one `tool.blocked` event fired in immediate sequence from the same
 * `CycleDetector.check` gate at agentRuntime.ts:2388 and :2563) into ONE
 * downstream `runtime.cycle_correlated` event.
 *
 * Mechanism (Map-based pending registration, no external dependencies):
 *   - `system.alert` cycle_detected arrives first → register pending entry
 *     keyed by `${toolName}:${description}` (both sides use the same tuple
 *     from `gate.description`).
 *   - `tool.blocked` cycle_detected arrives → look up pending entry →
 *     emit `runtime.cycle_correlated` with `sourceEvents` pinning both
 *     original sources, then remove the pending entry.
 *   - If ordering is reversed (rare race — tool.blocked before system.alert),
 *     the same logic mirrors: tool.blocked registers, system.alert matches.
 *
 * TTL: 5s window covers handler-execution lag and bus subscriber ordering
 * quirks. Beyond that, unpaired entries are silently dropped — partial
 * correlations are NOT emitted (would create misleading dedupe events).
 *
 * Dedup-key limitation — the key intentionally drops `runId` because the
 * upstream `system.alert cycle_detected` payload does NOT carry runId (the
 * publisher at agentRuntime.ts:2388 / :2563 emits only
 * `{ type, toolName, description }`). Two concurrent runs that BOTH trigger
 * `CycleDetector` with identical tool+args within the TTL window can
 * therefore false-correlate. We accept this in exchange for not editing
 * the system.alert publisher (which is out-of-scope for this PR). The
 * mitigation path, if needed, is to extend the `system.alert cycle_detected`
 * payload shape to include `runId` in a follow-up PR, then strengthen the
 * key to `${runId}:${toolName}:${description}`.
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

const cycleKey = (toolName: string, description: string): string => `${toolName}:${description}`;

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
   */
  observeToolBlocked(runId: string, toolName: string, description: string): void {
    const key = cycleKey(toolName, description);
    const existing = this.pending.get(key);
    if (existing && existing.registeredFrom === 'system.alert') {
      // Prefer the runId from tool.blocked (more specific — comes from the
      // ctx of the agent execute()). Fall back to the system.alert's
      // (limited) runId if missing.
      const unifiedRunId = runId || existing.runId;
      this.fireUnified(unifiedRunId, toolName, description);
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
      | { type?: string; toolName?: string; description?: string }
      | undefined;
    if (!payload || payload.type !== 'cycle_detected') return;
    if (typeof payload.toolName !== 'string' || typeof payload.description !== 'string') {
      return;
    }
    const toolName = payload.toolName;
    const description = payload.description;
    const key = cycleKey(toolName, description);
    const existing = this.pending.get(key);
    if (existing && existing.registeredFrom === 'tool.blocked') {
      const unifiedRunId = existing.runId || (msg as BusMessage & { runId?: string }).runId || '';
      this.fireUnified(unifiedRunId, toolName, description);
      this.pending.delete(key);
      return;
    }
    // system.alert doesn't carry runId in its payload — encode as empty
    // string; the matching tool.blocked call will overwrite via fireUnified.
    this.registerPending(key, '', toolName, description, 'system.alert');
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
