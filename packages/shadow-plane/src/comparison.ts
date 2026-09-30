import type { ShadowProductionDecision } from './contracts.js';
import type { ShadowHypotheticalDecision } from './evaluator.js';

export type ShadowComparison = 'match' | 'mismatch' | 'uncomparable';

export function compareShadowDecision(
  production: ShadowProductionDecision,
  hypothetical: ShadowHypotheticalDecision,
): ShadowComparison {
  if (production === 'unknown' || hypothetical === 'insufficient_evidence') {
    return 'uncomparable';
  }
  return production === hypothetical ? 'match' : 'mismatch';
}
