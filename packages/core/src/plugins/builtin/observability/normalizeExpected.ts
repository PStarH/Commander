/**
 * Re-export of canonical `observability/normalizeExpected.ts` (was a verbatim duplicate).
 * Collapsed 2026-07-15 for PRINCIPLES §3 / DRY.
 */
export {
  normalizeForMatch,
  classifyExpected,
  classifyExpectedForSubstringMatch,
  isNormalizedSubstringMatch,
  type UngradedReason,
  type UngradedClassification,
  type GradedClassification,
  type ExpectedClassification,
} from '../../../observability/normalizeExpected';
