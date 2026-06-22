// ---------------------------------------------------------------------------
// Operator-facing labels for OrchestrationTopology values.
//
// SINGLE SOURCE OF TRUTH. Every renderer (CLI Plan section in
// cli/commands/core.ts, runtime log in agentLoop.ts, runtime log in
// ultimate/orchestrator.ts) imports `strategyLabel` from here so that
// adding a new OrchestrationTopology enum value requires only this one
// edit. If you add an entry below, also extend OrchestrationTopology in
// ./types.ts.
//
// Canonical labels are the concise set that has shipped longest in
// cli/commands/core.ts. If you find a more accurate label for any
// legacy alias, edit it HERE — never edit the copy in a call site, the
// whole point of this module is that there is no copy.
// ---------------------------------------------------------------------------

export const STRATEGY_LABELS: Record<string, string> = {
  // Canonical (Anthropic-aligned 5)
  SINGLE: 'one agent',
  CHAIN: 'step-by-step chain',
  DISPATCH: 'fan-out by capability',
  ORCHESTRATOR: 'lead + subagents',
  REVIEW: 'critique and revise',
  // Legacy aliases (kept for back-compat through the deprecation window)
  SEQUENTIAL: 'step-by-step',
  PARALLEL: 'fan-out workers',
  HIERARCHICAL: 'tree of reviewers',
  HYBRID: 'mixed approach',
  DEBATE: 'multi-perspective review',
  ENSEMBLE: 'multiple attempts',
  EVALUATOR_OPTIMIZER: 'critic + revise',
  HANDOFF: 'expert handoff',
  CONSENSUS: 'multi-agent vote',
};

export function strategyLabel(t: string): string {
  return STRATEGY_LABELS[t] ?? t.toLowerCase().replace(/_/g, ' ');
}
