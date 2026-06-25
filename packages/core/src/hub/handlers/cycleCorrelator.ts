/**
 * CycleCorrelator — Phase 2 / Hub Glue handler for the
 * `cycle_detected` / `cycle_detected` retrospective pair.
 *
 * Thin wrapper around {@link PairCorrelator} that fixes the cycle-specific
 * (alertType='cycle_detected', unifiedTopic='runtime.cycle_correlated',
 * contextKeyField='description') configuration. Preserves the
 * {@link getCycleCorrelator} singleton accessor + per-test reset hooks so
 * existing call-sites and tests don't need to migrate.
 *
 * Extracted from the original 120-Line CycleCorrelator in June 2026 as
 * part of the Generic PairCorrelator pattern (see pairCorrelator.ts).
 * The mechanics (pending Map + 5s TTL + FIFO + 256 cap + symmetric
 * existing.runId resolution) live in PairCorrelator; this file just
 * supplies the cycle-specific config and re-exports a singleton.
 */

import { PairCorrelator, type PairConfig } from './pairCorrelator';

const CYCLE_PAIR_CONFIG: PairConfig = {
  alertType: 'cycle_detected',
  blockReason: 'cycle_detected',
  alertContextKeyField: 'description',
  blockContextKeyField: 'detail',
  unifiedContextField: 'description',
  unifiedTopic: 'runtime.cycle_correlated' as PairConfig['unifiedTopic'],
};

// Re-export so existing imports keep working.
export type { PairConfig };

export class CycleCorrelator {
  /** Internal generic correlator — public for tests. */
  readonly pair: PairCorrelator;

  constructor(pair: PairCorrelator = new PairCorrelator(CYCLE_PAIR_CONFIG)) {
    this.pair = pair;
  }

  install(bus: Parameters<PairCorrelator['install']>[0]): void {
    this.pair.install(bus);
  }

  observeToolBlocked(runId: string, toolName: string, contextKey: string): void {
    this.pair.observeToolBlocked(runId, toolName, contextKey);
  }

  getPendingCount(): number {
    return this.pair.getPendingCount();
  }

  pruneNow(): number {
    return this.pair.pruneNow();
  }

  dispose(): void {
    this.pair.dispose();
  }
}

let instance: CycleCorrelator | null = null;

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
