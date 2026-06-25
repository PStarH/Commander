/**
 * RetryHookCorrelator — Phase 2 / Hub Glue handler for the
 * `retry_loop_detected` (system.alert) + `hook_denied` (tool.blocked)
 * retrospective pair.
 *
 * Both events fire from DIFFERENT gates of AgentRuntime's
 * `applyPreToolCallGates` flow:
 *   - retry_loop_detected: emitted from `checkRetryLoop` method (Gate 3)
 *     when the same tool+args pattern hits >=3 times within the
 *     recent-patterns window. Payload carries `pattern: '<tool>:<args>'`.
 *   - hook_denied: emitted from Gate 1 (HookManager.fireBeforeToolCall)
 *     per pre-tool-call invocation that the plugin rejects. Payload
 *     carries `detail: '<human-readable rejection message>'`.
 *
 * They are NOT a code-gated dual-emit. They are RETROSPECTIVE: same
 * `(runId, toolName)` tuple, possibly across different per-tool-call
 * invocations, but causally tied to the same retry-loop episode.
 *
 * The third key segment (`pattern` vs `detail`) is structurally
 * different across the two sides — the alert's `pattern` is the
 * canonical `<tool>:<canonicalArgs>` retry-loop key while the
 * block's `detail` is the human-readable message describing why
 * the hook plugin rejected the call. Literal-match between these
 * two fields is structurally impossible without a brittle parser.
 *
 * To handle this, the {@link RETRY_HOOK_PAIR_CONFIG} below sets
 * `ignoreContextKey: true` — the {@link PairCorrelator} uses a
 * 2-tuple `${runId}:${toolName}` match key for this pair, ignoring
 * the contextKey entirely for de-duplication. The contextKey is
 * still captured as INFO-ONLY metadata on the first-arriving peer's
 * pending entry and propagated into the unified payload (so
 * observability isn't degraded). The runId component of the key
 * still isolates concurrent unrelated runs that happen to share a
 * toolName.
 *
 * Mechanism: shared with CycleCorrelator via {@link PairCorrelator}.
 * Subscribes to system.alert filtered by `payload.type ===
 * 'retry_loop_detected'`. The Hub Glue {@link toolBlockedHandler}
 * routes `hook_denied` events into {@link observeToolBlocked} —
 * same machinery as cycle, different config.
 *
 * Unified event: {@link BusPayloadMap}['runtime.retry_block_correlated']
 * payload shape — `{ runId, toolName, pattern, sourceEvents,
 * correlatedAt }`. The `pattern` field reflects whichever peer's
 * contextKey arrived first (typically the alert's canonical
 * `<tool>:<args>` pattern, used for analytics-grade observability).
 *
 * The unified event lets operators see "this run had N identical
 * calls AND a hook denial within the same tool slot" as a single
 * observability entry rather than two correlated events.
 */

import { PairCorrelator, type PairConfig } from './pairCorrelator';

const RETRY_HOOK_PAIR_CONFIG: PairConfig = {
  alertType: 'retry_loop_detected',
  blockReason: 'hook_denied',
  // system.alert retry_loop_detected carries `pattern: '<tool>:<canonicalArgs>'`.
  alertContextKeyField: 'pattern',
  // tool.blocked hook_denied carries `detail: <errorMsg>`. The detail
  // is human-readable (why the hook plugin rejected the call) and
  // structurally CANNOT match the alert's `pattern` (a canonical
  // `<tool>:<args>` key) without a fragile substring match. We use
  // `ignoreContextKey: true` below to match by runId+toolName only.
  // The blockContextKeyField below is INFO-ONLY — captured as pending
  // metadata if tool.blocked happens to arrive first.
  blockContextKeyField: 'detail',
  unifiedContextField: 'pattern',
  unifiedTopic: 'runtime.retry_block_correlated' as PairConfig['unifiedTopic'],
  /**
   * The retry→hook pair is RETROSPECTIVE: the leading system.alert
   * carries `pattern` (canonical `<tool>:<args>`) while the trailing
   * tool.blocked carries `detail` (human-readable rejection message).
   * These two fields are structurally different and cannot be matched
   * literally without a brittle parser. We match by runId+toolName
   * only — within a 5s TTL window, this is sufficient to disambiguate
   * the retry-loop episode from concurrent unrelated runs (which the
   * runId-strengthened key keeps distinct anyway). The first-arriving
   * peer's `contextKey` (the alert's `pattern`) is preserved in the
   * unified payload for analytics-grade observability.
   */
  ignoreContextKey: true,
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
