/**
 * SemanticCircuitCorrelator — Phase 2 / Hub Glue handler for the
 * `semantic_circuit_trip` (system.alert) + `circuit_broken`
 * (tool.blocked) retrospective pair.
 *
 * Both events fire from DIFFERENT layers of the runtime:
 *   - semantic_circuit_trip: emitted by AgentRuntime's constructor-wired
 *     `setSemanticTripHandler` closure (also mirrored by
 *     serviceInitializer.ts). The handler fires after the singleton
 *     CircuitBreaker trips its 3+ consecutive verification failures
 *     threshold. The handler closes over the AgentRuntime's
 *     `this.ledgerCtx?.runId` (or the ctx threaded via the new
 *     `recordSemanticFailure(reason, ctx)` overload).
 *   - circuit_broken: emitted per-call by AgentRuntime's
 *     `applyPreToolCallGates` orchestrator when the orchestrator's
 *     circuit-broken plan rejects a tool call before execution.
 *     Carries runId + toolName (the rejected cb.toolCall.name) +
 *     detail (the broken circuit's provider name).
 *
 * They are NOT a code-gated dual-emit. They are RETROSPECTIVE: same
 * `(runId)` tuple, possibly across different per-tool-call
 * invocations, but causally tied to the same semantic-degradation
 * episode. Importantly, the third key segment (`reason` on the alert
 * side vs. `detail` on the block side) is structurally different —
 * `reason` is the verification failure message; `detail` is the
 * broken circuit's provider name. They cannot be matched literally.
 *
 * To handle this, the {@link SEMANTIC_CIRCUIT_PAIR_CONFIG} below sets:
 *   - `ignoreContextKey: true` — 2-tuple `${runId}:${toolName}` match
 *     key, contextKey treated as INFO-ONLY.
 *   - `requireToolNameOnAlert: false` — the singleton ReliabilityEngine
 *     / CircuitBreaker's system.alert emit does NOT always carry a
 *     clean tool reference (verification failures are aggregated
 *     across tool calls); without this flag, the correlator would
 *     silently drop alert leads with missing toolName. The match key
 *     becomes effectively runId-only when toolName is absent on the
 *     alert side, while the tool.blocked side ALWAYS carries toolName
 *     (the rejected cb.toolCall.name), giving us the strongest
 *     matchable signal: a runId-strengthened 1-tuple for back-compat
 *     publishers, or a 2-tuple when toolName is available.
 *
 * Mechanism: shared with CycleCorrelator / RetryHookCorrelator via
 * {@link PairCorrelator}. Subscribes to system.alert filtered by
 * `payload.type === 'semantic_circuit_trip'`. The Hub Glue
 * {@link toolBlockedHandler} routes `circuit_broken` events into
 * {@link observeToolBlocked} — same machinery as the other Tier-0
 * pairs, different config.
 *
 * Unified event: {@link BusPayloadMap}['runtime.circuit_correlated']
 * payload shape — `{ runId, toolName?, reason, sourceEvents,
 * correlatedAt }`. `toolName` and `reason` are OPTIONAL on the
 * unified payload because they propagate from whichever side carries
 * them first (and may be absent on the alert side when
 * `requireToolNameOnAlert: false` matches by runId alone).
 */
import { PairCorrelator, type PairConfig } from './pairCorrelator';

const SEMANTIC_CIRCUIT_PAIR_CONFIG: PairConfig = {
  alertType: 'semantic_circuit_trip',
  blockReason: 'circuit_broken',
  // system.alert semantic_circuit_trip carries `reason: '<verification failure msg>'`.
  alertContextKeyField: 'reason',
  // tool.blocked circuit_broken carries `detail: '<broken circuit provider>'`.
  blockContextKeyField: 'detail',
  unifiedContextField: 'reason',
  unifiedTopic: 'runtime.circuit_correlated' as PairConfig['unifiedTopic'],
  /**
   * The alert's `reason` (verification failure message) and the
   * block's `detail` (broken circuit provider name) are structurally
   * different strings — they cannot be matched literally without a
   * brittle parser. ignoreContextKey=true opts out of contextKey
   * matching; contextKey is INFO-ONLY and captured from the first-
   * arriving peer.
   */
  ignoreContextKey: true,
  /**
   * The singleton ReliabilityEngine emits system.alert
   * semantic_circuit_trip without a clean tool reference (aggregated
   * across recent verification failures). Without this flag, the
   * PairCorrelator would silently drop the alert when toolName is
   * absent, breaking the entire dedupe pipeline. With this flag,
   * runId alone is the matching signal — within the 5s TTL this is
   * sufficient to disambiguate concurrent unrelated runs.
   */
  requireToolNameOnAlert: false,
};

export class SemanticCircuitCorrelator {
  readonly pair: PairCorrelator;

  constructor(pair: PairCorrelator = new PairCorrelator(SEMANTIC_CIRCUIT_PAIR_CONFIG)) {
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

let instance: SemanticCircuitCorrelator | null = null;

export function getSemanticCircuitCorrelator(): SemanticCircuitCorrelator {
  if (!instance) instance = new SemanticCircuitCorrelator();
  return instance;
}

/** Reset the singleton — used by tests to start from a clean state. */
export function _resetSemanticCircuitCorrelatorForTests(): void {
  if (instance) {
    instance.dispose();
  }
  instance = null;
}
