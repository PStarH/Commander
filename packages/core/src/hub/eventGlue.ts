// ============================================================================
// Hub Glue: dispatcher class + install() singleton
// ============================================================================
//
// install() is process-wide idempotent: subsequent calls return the same
// EventGlue instance. Call resetForTests() in test setup to clear the
// singleton between cases.
//
// Modes:
//   off    — start() installs ZERO bus subscriptions. Pure silent.
//   shadow — start() subscribes to every HUB_TOPICS; on each message the
//            JSONL audit sink is appended. No backend writes. DEFAULT.
//   on     — start() subscribes and (in Phase 2) dispatches to backend
//            sinks. REQUIRES `enableBackends: true` as a safety latch.
//
// Dedup:
//   Per-process Map<msgId, ts>. Capacity is bounded (default 4000, min 8);
//   the oldest entry is evicted on overflow. Repeated ids are silently
//   dropped to guard against reverb / retry storms.
//
// Phase 1 (this commit): install + shadow sink + dedup + invariant.
// Phase 2 will swap shadow dispatchers for real backend sinks.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { getMessageBus } from '../runtime/messageBus';
import type { BusMessage } from '../runtime/types/messageBus';

import type { BackendName, HubTopic } from './eventGlue.topics';
import {
  HUB_TOPICS,
  WRITE_TOPICS,
  getSinksForTopic,
} from './eventGlue.topics';

// Re-exports so that ./index.ts barrel can surface the taxonomy + types
// + the Phase-2 reverse-index helper without a second indirection. Without
// these, downstream `import { HUB_TOPICS } from '../hub'` resolves to
// undefined at runtime.
export { HUB_TOPICS, WRITE_TOPICS, getSinksForTopic };
export type { HubTopic, BackendName };

export type GlueMode = 'off' | 'shadow' | 'on';

export interface EventGlueOptions {
  mode?: GlueMode;
  /** Dedup window (entries). Default 4000, minimum 8. */
  dedupCapacity?: number;
  /** Override shadow JSONL sink path. Default: $TMPDIR/commander-hub-shadow.jsonl */
  shadowLogPath?: string;
  /** Safety latch: required for mode === 'on'. Default false. */
  enableBackends?: boolean;
}

const DEFAULT_DEDUP_CAPACITY = 4_000;
const SHADOW_LOG_DEFAULT = join(tmpdir(), 'commander-hub-shadow.jsonl');

let installHandle: EventGlue | null = null;

/**
 * Idempotent process-wide install. First call constructs EventGlue.
 *
 * Re-calls accept ONLY default-equivalent options (mode: 'shadow',
 * enableBackends: false). Anything non-default throws — use setMode() to
 * switch modes at runtime, or resetForTests() if you really need a
 * fresh instance with new options (test-only).
 */
export function install(opts: EventGlueOptions = {}): EventGlue {
  if (installHandle) {
    const wantsChange =
      (opts.mode !== undefined && opts.mode !== 'shadow') ||
      (opts.enableBackends !== undefined && opts.enableBackends !== false) ||
      opts.dedupCapacity !== undefined ||
      opts.shadowLogPath !== undefined;
    if (wantsChange) {
      throw new Error(
        "EventGlue.install() already called. To switch to mode 'on' or flip " +
        'enableBackends, use setMode(). To change dedupCapacity or ' +
        'shadowLogPath, call resetForTests() first.',
      );
    }
    return installHandle;
  }
  installHandle = new EventGlue(opts);
  return installHandle;
}

/** Returns the active EventGlue instance or null if install() hasn't run. */
export function getEventGlue(): EventGlue | null {
  return installHandle;
}

/** Stops the active instance and clears the singleton. Test-only. */
export function resetForTests(): void {
  if (installHandle) {
    try { installHandle.stop(); } catch { /* ignore */ }
  }
  installHandle = null;
}

/**
 * Asserts the invariant: every HUB_TOPICS entry maps to at least one
 * backend, and every WRITE_TOPICS reference is a HUB_TOPIC. Throws at
 * module load if violated — fail fast on misconfiguration.
 */
function assertInvariants(): void {
  const referenced = new Set<string>();
  for (const k of Object.keys(WRITE_TOPICS) as BackendName[]) {
    for (const t of WRITE_TOPICS[k]) referenced.add(t);
  }
  for (const t of HUB_TOPICS) {
    if (!referenced.has(t)) {
      throw new Error(`hub invariant: HUB topic "${t}" has no backend in WRITE_TOPICS`);
    }
  }
  for (const r of referenced) {
    if (!(HUB_TOPICS as readonly string[]).includes(r)) {
      throw new Error(`hub invariant: WRITE_TOPICS references "${r}" which is not in HUB_TOPICS`);
    }
  }
}

// Fail fast at module load.
assertInvariants();

export class EventGlue {
  public mode: GlueMode;
  private readonly dedupCapacity: number;
  private readonly shadowLogPath: string;
  private enableBackends: boolean;
  private readonly recentIds = new Map<string, number>();
  private readonly unsubFns: Array<() => void> = [];
  private started = false;

  constructor(opts: EventGlueOptions = {}) {
    this.mode = opts.mode ?? 'shadow';
    this.enableBackends = opts.enableBackends ?? false;
    if (this.mode === 'on' && !this.enableBackends) {
      throw new Error("EventGlue: mode 'on' requires enableBackends: true");
    }
    this.dedupCapacity = Math.max(8, opts.dedupCapacity ?? DEFAULT_DEDUP_CAPACITY);
    this.shadowLogPath = opts.shadowLogPath ?? SHADOW_LOG_DEFAULT;
  }

  /** Switch modes; restart subscriptions if previously started. */
  setMode(
    m: GlueMode,
    opts: { enableBackends?: boolean } = {},
  ): void {
    if (m === 'on' && !(opts.enableBackends ?? this.enableBackends)) {
      throw new Error("setMode('on') requires enableBackends: true");
    }
    const wasStarted = this.started;
    if (wasStarted) this.stop();
    this.mode = m;
    if (opts.enableBackends !== undefined) this.enableBackends = opts.enableBackends;
    if (wasStarted) this.start();
  }

  /** Subscribe to every HUB_TOPICS via the messageBus. No-op if already started. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.mode === 'off') return; // zero subscriptions in off mode

    const bus = getMessageBus();
    for (const topic of HUB_TOPICS) {
      const unsub = bus.subscribe(topic, (msg: BusMessage) => {
        this.dispatchOne(topic as HubTopic, msg).catch((err) => {
          // Surface for ops; never throw out of bus callback.
          // eslint-disable-next-line no-console
          console.error('[hub/eventGlue] dispatch error', { topic, err });
        });
      });
      this.unsubFns.push(unsub);
    }
  }

  /** Detach every subscription. */
  stop(): void {
    while (this.unsubFns.length) {
      try { this.unsubFns.pop()?.(); } catch { /* ignore teardown noise */ }
    }
    this.started = false;
  }

  /** Current dedup-window size. Public for testability — previously we
   *  exposed the `recentIds` Map via `(g as unknown as { recentIds })`,
   *  which coupled tests to the field name and would silently break on
   *  internal renames. */
  dedupWindowSize(): number {
    return this.recentIds.size;
  }

  /**
   * Handles a single bus message. Public to ease testing.
   * Dedups → shadow sink (shadow/on without backends) → backend sink (Phase 2).
   */
  async dispatchOne(topic: HubTopic, msg: BusMessage): Promise<void> {
    if (!this.shouldDeliver(msg.id)) return;
    if (this.mode === 'off') return; // unreachable (no subscriptions) but defensive
    if (this.mode === 'shadow') {
      this.writeShadowLine(topic, msg);
      return;
    }
    // mode === 'on'
    if (!this.enableBackends) {
      // Should never reach here — guarded by constructor + setMode.
      this.writeShadowLine(topic, msg);
      return;
    }
    // Phase 2: dispatch to actual backend sinks (UnifiedMemory, AtrRunLedger,
    // AuditChainLedger, SagaCoordinator) per WRITE_TOPICS[topic].
  }

  private shouldDeliver(msgId: string): boolean {
    if (this.recentIds.has(msgId)) return false;
    this.recentIds.set(msgId, Date.now());
    if (this.recentIds.size > this.dedupCapacity) {
      const oldest = this.recentIds.keys().next().value;
      if (oldest !== undefined) this.recentIds.delete(oldest);
    }
    return true;
  }

  private writeShadowLine(topic: HubTopic, msg: BusMessage): void {
    const line = JSON.stringify({
      ts: Date.now(),
      topic,
      msgId: msg.id,
      source: msg.source,
      payload: msg.payload,
    });
    try {
      appendFileSync(this.shadowLogPath, line + '\n');
    } catch {
      // Shadow sink is best-effort; never throw out of dispatch.
    }
  }
}
