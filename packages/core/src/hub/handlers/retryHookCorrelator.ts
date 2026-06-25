/**
 * RetryHookCorrelator — Phase 2 / Hub Glue handler for the
 * `retry_loop_detected` (system.alert) + `hook_denied` (tool.blocked)
 * retrospective pair.
 *
 * Both events fire from DIFFERENT gates of AgentRuntime's
 * `applyPreToolCallGates` flow:
 *   - retry_loop_detected: emitted from `checkRetryLoop` method (Gate 3)
 *     when the same tool+args pattern hits >=3 times within the
 *     recent-patterns window.
 *   - hook_denied: emitted from Gate 1 (HookManager.fireBeforeToolCall)
 *     per pre-tool-call invocation that the plugin rejects.
 *
 * They are NOT a code-gated dual-emit. They are RETROSPECTIVE: same
 * `(runId, toolName, pattern)` tuple, possibly different per-tool-call
 * invocations, but causally tied to the same retry-loop episode.
 *
 * Mechanism: same as CycleCorrelator (via the shared
 * {@link PairCorrelator}). Subscribes to system.alert filtered by
 * `payload.type === 'retry_loop_detected'`. The Hub Glue
 * {@link toolBlockedHandler} routes `hook_denied` events into
 * {@link observeToolBlocked} — same pair-shape as cycle, different
 * contextKeyField ('pattern' instead of 'description').
 *
 * Unified event: {@link BusPayloadMap}['runtime.retry_block_correlated']
 * payload shape — `{ runId, toolName, pattern, sourceEvents,
 * correlatedAt }` matching style of runtime.cycle_correlated.
 *
 * Why both events share a `(runId, toolName, pattern)` tuple:
 *   - retry_loop_detected fires AFTER 3 identical calls have already
 *     accumulated in the patterns array.
 *   - subsequent hook_denied events on a different tool call lack the
 *     same pattern, so they don't match.
 *   - a hook_denied event with the SAME pattern (within 5s TTL) IS
 *     causally linked to the retry loop — they're often the same
 *     anomaly seen through different lenses.
 *
 * The unified event lets operators see "this run had N identical calls AND
 * a hook denial matching the same pattern" as a single observability
 * entry rather than two correlated events.
 */

import { PairCorrelator, HUB_GLUE_SOURCE, type PairConfig } from './pairCorrelator';

const RETRY_HOOK_PAIR_CONFIG: PairConfig = {
  alertType: 'retry_loop_detected',
  blockReason: 'hook_denied',
  // system.alert retry_loop_detected carries `pattern: '<tool>:<canonicalArgs>'`.
  alertContextKeyField: 'pattern',
  // tool.blocked hook_denied carries `detail: <errorMsg>`. Convention:
  // hook messages describe the rejected (tool, args) call surface — we
  // do NOT rely on `detail` matching `pattern` literally, but for now
  // keep them aligned on a single string key via the unified field.
  blockContextKeyField: 'detail',
  unifiedContextField: 'pattern',
  unifiedTopic: 'runtime.retry_block_correlated' as PairConfig['unifiedTopic'],
};

export class RetryHookCorrelator {
  readonly pair: PairCorrelator;

  constructor(pair: PairCorrelator = new PairCorrelator(RETRY_HOOK_PAIR_CONFIG)) {
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

let instance: RetryHookCorrelator | null = null;

export function getRetryHookCorrelator(): RetryHookCorrelator {
  if (!instance) instance = new RetryHookCorrelator();
  return instance;
}

/** Reset the singleton — used by tests to start from a clean state. */
export function _resetRetryHookCorrelatorForTests(): void {
  if (instance) {
    instance.dispose();
  }
  instance = null;
}

export { HUB_GLUE_SOURCE };
