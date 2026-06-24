// ============================================================================
// Hub Glue: closed-loop event taxonomy + per-backend write targets
// ============================================================================
//
// HUB_TOPICS    — union of every MessageBus topic the glue subscribes to.
// WRITE_TOPICS  — per-backend target lists. Every HUB_TOPICS entry must
//                 appear in at least one WRITE_TOPICS backend list, and
//                 every WRITE_TOPICS entry must be a HUB_TOPICS topic.
//                 The double-sided invariant is asserted at module load
//                 (eventGlue.ts → assertInvariants), so misconfiguration
//                 fails fast.
//
// Phase 1 (this commit): wiring + shadow-mode sink only. No real backend
// writes — orchestrator.ts / agentRuntime.ts direct writes are migrated
// in Phase 2 once shadow parity is verified.

import type { MessageBusTopic } from '../runtime/types/messageBus';

export type BackendName =
  | 'unifiedMemory'
  | 'runLedger'
  | 'auditChainLedger'
  | 'sagas';

export const HUB_TOPICS = [
  // Orchestration arc
  'orchestrator.topology_optimized',
  'orchestrator.suggested_replan',
  'workflow.replan',
  // Runtime arc
  'runtime.conversation_turn',
  'runtime.dlq_enqueued',
  // Sandbox arc
  'tool.compensation_step',
  'sandbox.escape_attempted',
  'sandbox.executed',
  // Telemetry arc
  'telemetry.metric.recorded',
  'telemetry.intent.recorded',
  // Memory arc
  'memory.written',
  'memory.queried',
  'memory.semantic_promoted',
  'memory.user.interaction_recorded',
  'memory.episodic_reinforced',
  'memory.lesson_derived',
  'memory.feedback_signal',
  'memory.procedural_compiled',
  // Security arc
  'security.capability_minted',
  'security.capability_revoked',
  'security.token_delegated',
] as const satisfies readonly MessageBusTopic[];

export type HubTopic = (typeof HUB_TOPICS)[number];

export const WRITE_TOPICS: Readonly<Record<BackendName, readonly HubTopic[]>> = {
  unifiedMemory: [
    'memory.written',
    'memory.user.interaction_recorded',
    'memory.episodic_reinforced',
    'memory.semantic_promoted',
    'memory.lesson_derived',
    'memory.procedural_compiled',
    'memory.feedback_signal',
    'runtime.conversation_turn',
    // Memory queries are interesting to BOTH Memory (for analytics) AND
    // SagaCoordinator (for cache lifecycle / replay decisions). Routing
    // to multiple backends exercises the fanout path.
    'memory.queried',
  ],
  runLedger: [
    'orchestrator.topology_optimized',
    'orchestrator.suggested_replan',
    'workflow.replan',
    'telemetry.metric.recorded',
    'telemetry.intent.recorded',
    'sandbox.executed',
  ],
  auditChainLedger: [
    'security.capability_minted',
    'security.capability_revoked',
    'security.token_delegated',
    'sandbox.escape_attempted',
    'runtime.dlq_enqueued',
  ],
  sagas: [
    'tool.compensation_step',
    'memory.queried',
  ],
};

/**
 * Precomputed reverse-index: topic → backends that should receive writes.
 * Phase 2 dispatcher uses this to fan out a single bus message to all
 * relevant backend sinks without re-scanning WRITE_TOPICS per message.
 *
 * The non-null assertion `m.get(t)!.push(k)` below is safe by
 * construction BECAUSE `assertInvariants()` in
 * packages/core/src/hub/eventGlue.ts runs at module-load and enforces:
 *   1. every WRITE_TOPICS topic appears in some backend list, AND
 *   2. every WRITE_TOPICS topic is also a HUB_TOPICS topic.
 * Combined with the initial loop above that seeds an entry for EVERY
 * HUB_TOPICS item, `m.get(t)` is non-undefined for every `t` we look up
 * here. If you refactor this file in isolation, do NOT silently remove
 * the `!` — either preserve the cross-file invariant or restore a
 * runtime null-guard so misconfiguration fails loud instead of silently
 * dropping writes.
 */
export const SINKS_FOR_TOPIC: ReadonlyMap<HubTopic, readonly BackendName[]> = (() => {
  const m = new Map<HubTopic, BackendName[]>();
  for (const t of HUB_TOPICS) m.set(t, []);
  for (const k of Object.keys(WRITE_TOPICS) as BackendName[]) {
    for (const t of WRITE_TOPICS[k]) {
      m.get(t)!.push(k);
    }
  }
  return m;
})();

/** Returns the read-only list of backends a topic is routed to. */
export function getSinksForTopic(t: HubTopic): readonly BackendName[] {
  return SINKS_FOR_TOPIC.get(t) ?? [];
}
