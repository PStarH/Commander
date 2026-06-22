import { describe, it, expect } from 'vitest';
import { STRATEGY_LABELS, strategyLabel } from '../../src/ultimate/orchestrationLabels';
import type { OrchestrationTopology } from '../../src/ultimate/types';

// ----------------------------------------------------------------------------
// Test-only snapshot of the canonical 14 labels.
//
// Any intentional UX rename must update THREE things in the same PR:
//   1. This const (below)
//   2. STRATEGY_LABELS in src/ultimate/orchestrationLabels.ts
//   3. Any customer-facing docs/screenshots that print strategy names
//
// The two-way lock (test const ↔ live map) guarantees that the moment
// either side drifts, the test fails — so callers can never silently
// ship a UX-affecting rename.
// ----------------------------------------------------------------------------
const CANONICAL_LABELS: Record<OrchestrationTopology, string> = {
  // Canonical (Anthropic-aligned 5)
  SINGLE: 'one agent',
  CHAIN: 'step-by-step chain',
  DISPATCH: 'fan-out by capability',
  ORCHESTRATOR: 'lead + subagents',
  REVIEW: 'critique and revise',
  // Legacy aliases (2-minor-version deprecation window per the
  // OrchestrationTopology JSDoc in src/ultimate/types.ts)
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

describe('orchestrationLabels', () => {
  describe('STRATEGY_LABELS map (single source of truth)', () => {
    it('contains exactly the 14 canonical OrchestrationTopology keys', () => {
      const expectedKeys = Object.keys(CANONICAL_LABELS).sort();
      const actualKeys = Object.keys(STRATEGY_LABELS).sort();
      expect(actualKeys).toEqual(expectedKeys);
    });

    it.each(Object.entries(CANONICAL_LABELS))('snapshot — %s maps to %s', (key, expected) => {
      expect(STRATEGY_LABELS[key]).toBe(expected);
    });

    it('exhaustiveness — every OrchestrationTopology union member has an entry', () => {
      // Iterates Object.keys(CANONICAL_LABELS) (NOT a hand-maintained
      // array) so adding a new value to OrchestrationTopology forces
      // CANONICAL_LABELS — typed `Record<OrchestrationTopology, string>`
      // — to add a matching key at compile time. Once CANONICAL_LABELS
      // is updated, this loop inherits the new key automatically and
      // verifies STRATEGY_LABELS has a corresponding runtime entry.
      // Without the type-level lock on CANONICAL_LABELS, this loop
      // could silently stop covering new enum values.
      for (const member of Object.keys(CANONICAL_LABELS) as OrchestrationTopology[]) {
        expect(STRATEGY_LABELS).toHaveProperty(member);
      }
      // Belt-and-suspenders: STRATEGY_LABELS map size must equal the
      // typed CANONICAL_LABELS so neither side can silently grow alone.
      expect(Object.keys(STRATEGY_LABELS).sort()).toEqual(Object.keys(CANONICAL_LABELS).sort());
    });
  });

  describe('strategyLabel()', () => {
    it('returns the canonical label for known values', () => {
      expect(strategyLabel('SINGLE')).toBe('one agent');
      expect(strategyLabel('CHAIN')).toBe('step-by-step chain');
      expect(strategyLabel('DISPATCH')).toBe('fan-out by capability');
      expect(strategyLabel('ORCHESTRATOR')).toBe('lead + subagents');
      expect(strategyLabel('REVIEW')).toBe('critique and revise');
      // Spot-check legacy aliases too
      expect(strategyLabel('PARALLEL')).toBe('fan-out workers');
      expect(strategyLabel('CONSENSUS')).toBe('multi-agent vote');
      expect(strategyLabel('EVALUATOR_OPTIMIZER')).toBe('critic + revise');
    });

    it('falls back to lowercase + underscore-to-space for unknown values', () => {
      expect(strategyLabel('UNKNOWN_STRATEGY')).toBe('unknown strategy');
      expect(strategyLabel('NEW_THING')).toBe('new thing');
      expect(strategyLabel('A_B_C')).toBe('a b c');
      expect(strategyLabel('ALREADY_LOWER')).toBe('already lower');
      // Edge cases
      expect(strategyLabel('')).toBe('');
      expect(strategyLabel('single')).toBe('single');
    });

    it('every OrchestrationTopology union value renders to a non-empty string', () => {
      // Belt-and-suspenders: even if a label is set to '' (which the
      // snapshot wouldn't catch because both sides agree), the operator
      // log would print a blank. Guard against that here. Iterates
      // CANONICAL_LABELS keys (compile-time exhaustive derivation) so
      // a new enum value lands in this loop automatically.
      for (const t of Object.keys(CANONICAL_LABELS) as OrchestrationTopology[]) {
        const label = strategyLabel(t);
        expect(label.length).toBeGreaterThan(0);
        expect(label.trim().length).toBeGreaterThan(0);
      }
    });

    it('is referentially stable — same input returns the same output', () => {
      const first = strategyLabel('HIERARCHICAL');
      const second = strategyLabel('HIERARCHICAL');
      expect(first).toBe(second);
      expect(first).toBe('tree of reviewers');
    });
  });
});
