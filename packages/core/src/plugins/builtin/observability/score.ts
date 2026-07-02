/**
 * Shared offline-benchmark scoring primitives — extracted from
 * `scripts/benchmark-gaia.ts` so they can be imported by both the CLI
 * benchmark AND vitest runtime tests without triggering that script's
 * bottom-of-file `main().then(process.exit)` auto-execution hazard.
 *
 * CROSS-FILE CONTRACT — READ BEFORE EDITING:
 *   This module is the SINGLE source of truth for the offline benchmark's
 *   3-way scoring verdict (CORRECT / INCORRECT / UNGRADED) and its
 *   asymmetric parameter types. Both consumers import from here:
 *
 *     1. `scripts/benchmark-gaia.ts` — the offline ATR/ExecutionScheduler-
 *        pinned benchmark. Drives the 10-task SYNTHETIC_TASKS dry-run.
 *     2. `packages/core/tests/observability/evalScorer.test.ts` — runtime
 *        tests that lock down the asymmetric parameter types invariant
 *        documented on `score()` below.
 *
 *   Neither consumer may redefine these types locally — re-define here,
 *   both consumers will pick up the change.
 *
 *   Underlying primitives (`normalizeForMatch`, `classifyExpectedForSubstringMatch`,
 *   `isNormalizedSubstringMatch`) live in `./normalizeExpected.ts` and are
 *   shared with the production `EvalScorer`. This module composes them.
 */

import { normalizeForMatch } from './normalizeExpected';
import { classifyExpectedForSubstringMatch } from './normalizeExpected';
import { isNormalizedSubstringMatch } from './normalizeExpected';

export type Verdict = 'CORRECT' | 'INCORRECT' | 'UNGRADED';

export interface ScoreResult {
  verdict: Verdict;
  reason: string;
  /** What we matched against (post-normalization). Empty if UNGRADED. */
  normalizedExpected?: string;
  normalizedActual?: string;
}

/**
 * Score an agent output against a dataset ground-truth value.
 *
 * Three-way contract:
 *   • CORRECT    — normalized output contains the normalized expected value
 *   • INCORRECT  — output is non-empty but does not match the ground truth
 *   • UNGRADED   — the substring-match classifier refused to grade (missing
 *                  ground truth, all-punctuation after normalization, OR a
 *                  non-string `expected` that substring matching cannot
 *                  match without coercion).
 *
 * Both `classifyExpectedForSubstringMatch()` and `isNormalizedSubstringMatch()`
 * are imported from `packages/core/src/observability/normalizeExpected.ts` —
 * the EXACT same primitives used by the production `EvalScorer` in
 * `packages/core/src/observability/evalScorer.ts`. The shared module is the
 * single source of truth; this scorer cannot drift from production scoring
 * on STRING inputs. Non-string `expected` is a documented capability
 * difference: production forwards it to the LLM judge (via the general
 * `classifyExpected()`), this substring matcher refuses it with reason
 * `'non_string_expected_not_substring_matchable'`.
 *
 * ASYMMETRIC PARAMETER TYPES BY DESIGN:
 *   • `expected` is widened to `unknown` so the offline benchmark can
 *     accept GAIA dataset rows whose `expected` is structured (e.g. the
 *     rubric-style `{ outputContains: [...] }` payloads the production
 *     EvalScorer also accepts). A narrowed `expected: string` at the
 *     `score()` call site would either force callers to stringify (which
 *     discards structured info) or fail to compile; widening preserves
 *     the original shape so `classifyExpectedForSubstringMatch()` can
 *     emit `non_string_expected_not_substring_matchable` at runtime.
 *   • `actual` stays `string | undefined | null` to match the
 *     `SYNTHETIC_TASKS.mockOutput: string` fixture contract. Widening
 *     `actual` to `unknown` would propagate to the `score()` body, where
 *     `normalizeForMatch(actual ?? '')` requires `string | null |
 *     undefined` and would fail to type-check — so the asymmetry mirrors
 *     the shared module's accepted input shape rather than defending
 *     against a specific runtime incident.
 */
export function score(expected: unknown, actual: string | undefined | null): ScoreResult {
  const normActual = normalizeForMatch(actual ?? '');
  const classification = classifyExpectedForSubstringMatch(expected);
  if (classification.ungraded) {
    return {
      verdict: 'UNGRADED',
      reason: classification.reason,
      normalizedActual: normActual,
    };
  }
  if (isNormalizedSubstringMatch(normActual, classification.normalizedExpected)) {
    return {
      verdict: 'CORRECT',
      reason: 'normalized_substring_match',
      normalizedExpected: classification.normalizedExpected,
      normalizedActual: normActual,
    };
  }
  return {
    verdict: 'INCORRECT',
    reason: 'normalized_substring_no_match',
    normalizedExpected: classification.normalizedExpected,
    normalizedActual: normActual,
  };
}
