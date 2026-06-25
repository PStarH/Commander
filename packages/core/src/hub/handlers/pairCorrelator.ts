/**
 * PairCorrelator — Phase 2 / Hub Glue generic retrospective correlator.
 *
 * Extracted from CycleCorrelator (June 2026) to support MULTIPLE
 * system.alert ↔ tool.blocked pair-configurations without duplicating the
 * pending-Map + 5s TTL + FIFO + symmetric match machinery. Each pair
 * (e.g. cycle_detected / cycle_detected, retry_loop_detected / hook_denied)
 * binds a separate PairCorrelator instance via the {@link PairConfig}.
 *
 * Why this exists:
 *   The user-facing audit (June 2026) revealed that the original
 *   dedupe-detection assumption — "system.alert and tool.blocked fire
 *   from the SAME code gate, in immediate sequence" — does NOT hold
 *   universally. Most denial pairs are RETROSPECTIVE: they fire from
 *   different gates (different causality, different timing), but share
 *   a `(runId, toolName, contextKey)` tuple that ties them to the same
 *   underlying runtime event. The Generic PairCorrelator formalizes
 *   this retrospective fit:
 *
 *     1. system.alert side: subscribe once at install(); filter by
 *        {@link PairConfig.alertType}; extract runId/toolName/contextKey.
 *        Register a pending entry keyed by `${runId}:${toolName}:${contextKey}`.
 *     2. tool.blocked side: NOT subscribed here (avoids ordering
 *        races between system.alert and tool.blocked publishing from
 *        different code sites). The Hub Glue toolBlockedHandler invokes
 *        {@link PairCorrelator.observeToolBlocked} when reason matches
 *        {@link PairConfig.blockReason}, breaking the gate-isolation
 *        barrier deliberately (cross-topic linkage).
 *     3. Match: when both sides carry the same key (runId equality +
 *        toolName equality + contextKey equality), emit a unified event
 *        on {@link PairConfig.unifiedTopic} carrying the runId, toolName,
 *        and contextKey value.
 *
 * Back-compat: empty `runId` from a producer without runId-stamping
 * keys the entry with empty runId; back-compat publishers only match
 * each other (they cannot false-correlate with runId-stamped producers).
 *
 * TTL: 5s window covers handler-execution lag and bus subscriber
 * ordering quirks. Beyond that, unpaired entries are silently dropped —
 * partial correlations are NOT emitted (would create misleading dedupe
 * events).
 *
 * FIFO eviction at MAX_PENDING_ENTRIES keeps memory bounded under
 * sustained dedupe pressure.
 */

import { getMessageBus } from '../../runtime/messageBus';
import type { MessageBus } from '../../runtime/messageBus';
import type { BusMessage, MessageBusTopic } from '../../runtime/types';

const PAIR_CORRELATION_TTL_MS = 5_000;
const PRUNE_INTERVAL_MS = 30_000;
const MAX_PENDING_ENTRIES = 256;
export const HUB_GLUE_SOURCE = 'hub-glue';

export interface PairConfig {
  /** Discriminant value for the system.alert payload's `type` field. */
  readonly alertType: string;
  /** Discriminant value for the tool.blocked payload's `reason` field
   *  (only used by toolBlockedHandler routes this correlator through;
   *  observer-side validation lives in observeToolBlocked's caller).
   */
  readonly blockReason: string;
  /** Field name carrying the third key segment on the system.alert side
   *  (e.g. 'description' for cycle_detected, 'pattern' for retry_loop_detected).
   */
  readonly alertContextKeyField: string;
  /** Field name carrying the third key segment on the tool.blocked side
   *  (typically 'detail' across all current denial shapes — but kept
   *  configurable for future variants).
   */
  readonly blockContextKeyField: string;
  /** Field name for the contextKey value on the unified event payload
   *  (matches alertContextKeyField by convention; consumers see
   *  `payload.description` vs `payload.pattern` differentiated).
   */
  readonly unifiedContextField: string;
  /** Topic for the unified event emit. MUST be in
   *  BusPayloadMap with a typed payload, so subscribers can be type-safe.
   */
  readonly unifiedTopic: MessageBusTopic;
}

interface PendingPair {
  runId: string;
  toolName: string;
  contextKey: string;
  registeredAt: number;
  registeredFrom: 'system.alert' | 'tool.blocked';
}

const pairKey = (runId: string, toolName: string, contextKey: string): string =>
  `${runId}:${toolName}:${contextKey}`;

/**
 * Lightweight log helper that defers to the bus's structured logger when
 * available. Subscribers must NEVER throw, so any logging here is
 * best-effort and wrapped in try/catch by MessageBus.publish anyway.
 */
function safeEmit(topic: MessageBusTopic, payload: Record<string, unknown>): void {
  getMessageBus().publish(topic, HUB_GLUE_SOURCE, payload);
}

export class PairCorrelator {
  private readonly pending = new Map<string, PendingPair>();
  private pruneInterval: ReturnType<typeof setInterval> | null = null;
  private installed = false;
  private systemAlertUnsub: (() => void) | null = null;

  constructor(public readonly config: PairConfig) {}

  /**
   * Install the system.alert subscriber for this pair's alertType.
   * Idempotent across calls.
   */
  install(bus: MessageBus = getMessageBus()): void {
    if (this.installed) return;
    this.installed = true;

    this.systemAlertUnsub = bus.subscribe('system.alert', (msg: BusMessage) => {
      this.onSystemAlert(msg);
    });
    this.pruneInterval = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    if (typeof this.pruneInterval.unref === 'function') {
      this.pruneInterval.unref();
    }
  }

  /**
   * Called by the Hub Glue {@link toolBlockedHandler} when its
   * payload's reason matches {@link PairConfig.blockReason}. Folds the
   * leading system.alert (or registers the pending if tool.blocked
   * arrived first).
   *
   * Match invariant: when the key matches, BOTH sides carry the same
   * runId + toolName + contextKey. The peer's stored value is the
   * authoritative input to fireUnified (no probe-fallback dance needed).
   */
  observeToolBlocked(runId: string, toolName: string, contextKey: string): void {
    const key = pairKey(runId, toolName, contextKey);
    const existing = this.pending.get(key);
    if (existing && existing.registeredFrom === 'system.alert') {
      this.fireUnified(existing.runId, toolName, existing.contextKey);
      this.pending.delete(key);
      return;
    }
    this.registerPending(key, runId, toolName, contextKey, 'tool.blocked');
  }

  /** Test/inspection accessor — current pending-entry count. */
  getPendingCount(): number {
    return this.pending.size;
  }

  /** Force-prune for testing. Production code uses the setInterval timer. */
  pruneNow(): number {
    const before = this.pending.size;
    this.prune();
    return before - this.pending.size;
  }

  /** Stop the prune timer, drop subscribers, drop pending map. Safe to
   *  call when already disposed. */
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
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== this.config.alertType) return;
    const runId = typeof payload.runId === 'string' ? (payload.runId as string) : '';
    const toolName = typeof payload.toolName === 'string' ? (payload.toolName as string) : '';
    const ctxValue =
      typeof payload[this.config.alertContextKeyField] === 'string'
        ? (payload[this.config.alertContextKeyField] as string)
        : '';
    if (!runId || !toolName || !ctxValue) return;
    const key = pairKey(runId, toolName, ctxValue);
    const existing = this.pending.get(key);
    if (existing && existing.registeredFrom === 'tool.blocked') {
      // Key-match implies runIds/keys are equal across both sides; the
      // peer's stored value is the authoritative input (no asymmetric
      // fallbacks).
      this.fireUnified(existing.runId, toolName, existing.contextKey);
      this.pending.delete(key);
      return;
    }
    this.registerPending(key, runId, toolName, ctxValue, 'system.alert');
  }

  private registerPending(
    key: string,
    runId: string,
    toolName: string,
    contextKey: string,
    from: 'system.alert' | 'tool.blocked',
  ): void {
    if (this.pending.size >= MAX_PENDING_ENTRIES) {
      // FIFO eviction: Map iteration order = insertion order in JS.
      const firstKey = this.pending.keys().next().value;
      if (typeof firstKey === 'string') {
        this.pending.delete(firstKey);
      }
    }
    this.pending.set(key, {
      runId,
      toolName,
      contextKey,
      registeredAt: Date.now(),
      registeredFrom: from,
    });
  }

  private fireUnified(runId: string, toolName: string, contextKey: string): void {
    // Build payload dynamically to support per-config unifiedContextField.
    const payload: Record<string, unknown> = {
      runId,
      toolName,
      sourceEvents: ['system.alert', 'tool.blocked'] as ['system.alert', 'tool.blocked'],
      correlatedAt: new Date().toISOString(),
    };
    payload[this.config.unifiedContextField] = contextKey;
    safeEmit(this.config.unifiedTopic, payload);
  }

  private prune(): void {
    const cutoff = Date.now() - PAIR_CORRELATION_TTL_MS;
    for (const [k, v] of this.pending) {
      if (v.registeredAt < cutoff) {
        this.pending.delete(k);
      }
    }
  }
}
