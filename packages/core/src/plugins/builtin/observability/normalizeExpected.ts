/**
 * Shared scoring primitives for dataset `expected` values.
 *
 * CROSS-FILE CONTRACT — READ BEFORE EDITING:
 *   The helpers in this file are the SINGLE source of truth for what
 *   "post-normalize empty" means across the Commander codebase. They are
 *   consumed by:
 *
 *     1. `packages/core/src/observability/evalScorer.ts` — the live
 *        production scorer. Uses `classifyExpected()` to short-circuit
 *        the LLM judge when ground truth is missing. Without this guard,
 *        `safeJson(undefined)` renders `null` into the judge prompt and
 *        the LLM marks every response correct (CHANGELOG.md line 87).
 *
 *     2. `scripts/benchmark-gaia.ts` — the offline ATR/ExecutionScheduler-
 *        pinned benchmark. Uses `classifyExpected()` + `normalizeForMatch()`
 *        + `isNormalizedSubstringMatch()` for deterministic substring
 *        matching. Without the post-normalize guard, `String.includes('')`
 *        returns true and the regression slips back in.
 *
 *   Both consumers MUST agree on:
 *     • the normalization rules here
 *     • the two ungraded reasons (`empty_expected_ungraded`,
 *       `empty_expected_after_normalize`)
 *     • the fact that non-string `expected` values are NOT ungraded (they
 *       are passed through to the LLM judge in production, and never
 *       occur in benchmark-gaia's typed synthetic-task fixture).
 *
 *   If you need to extend normalization (e.g. strip HTML tags, Unicode
 *   folding, etc.), update THIS file and both call sites in the same
 *   commit, and add a regression test under
 *   `packages/core/tests/observability/normalizeExpected.test.ts`.
 */

/**
 * Reason a dataset `expected` value is ungraded.
 *
 * Stable string union — production scorers, the benchmark script, and
 * aggregation layers depend on these exact literals for telemetry routing
 * and exit-code mapping.
 *
 * Every literal has exactly one producer:
 *   • `empty_expected_ungraded`           ← `classifyExpected()`
 *   • `empty_expected_after_normalize`   ← `classifyExpected()`
 *   • `non_string_expected_not_substring_matchable` ← `classifyExpectedForSubstringMatch()`
 */
export type UngradedReason =
  | 'empty_expected_ungraded'
  | 'empty_expected_after_normalize'
  | 'non_string_expected_not_substring_matchable';

export interface UngradedClassification {
  ungraded: true;
  reason: UngradedReason;
}
export interface GradedClassification {
  ungraded: false;
  /**
   * Post-normalize expected value.
   *
   * Non-empty when `expected` was a non-empty string that survived
   * normalization. Empty string IFF `expected` was a non-string value
   * (object, number, array, boolean) — the pass-through signal. Substring-
   * match consumers MUST treat empty `normalizedExpected` as ungraded
   * (and emit `'non_string_expected_not_substring_matchable'`).
   */
  normalizedExpected: string;
}

export type ExpectedClassification = UngradedClassification | GradedClassification;

/**
 * Normalize a string for expected/actual alignment.
 *
 * Returns empty string iff `text` is nullish/empty/whitespace/all-punctuation.
 *
 * Byte-identical to the (now-deleted) inline `normalize()` helpers in
 * `evalScorer.ts` and `scripts/benchmark-gaia.ts`. If you change this
 * function, change it ONCE — both consumers will pick up the new
 * behavior automatically through the import.
 */
export function normalizeForMatch(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?'"()]/g, '')
    .trim();
}

/**
 * Classify a dataset `expected` value for general-purpose (LLM-judge) use.
 *
 * UNGRADED iff ANY of:
 *   1. `expected` is `undefined` or `null`
 *   2. `expected` is a string whose raw content is whitespace-only
 *   3. `expected` is a non-empty string that reduces to empty after
 *      `normalizeForMatch()` (the all-punctuation `'...'` case)
 *
 * GRADED with `normalizedExpected: ''` (pass-through signal) iff
 *   `expected` is a non-string value. The production `EvalScorer`
 *   interprets this as "send the structured expectation to the LLM judge".
 *   This IS a documented capability of the production scorer: structured
 *   expectations like `{ outputContains: ['42'] }` are forward-compatible
 *   with rubric-style judging.
 *
 *   Substring-match consumers (the offline benchmark) MUST NOT call this
 *   function directly for non-string inputs — they should use
 *   `classifyExpectedForSubstringMatch` instead, which converts the
 *   pass-through into an ungraded verdict with a specific reason literal.
 */
export function classifyExpected(expected: unknown): ExpectedClassification {
  if (expected === undefined || expected === null) {
    return { ungraded: true, reason: 'empty_expected_ungraded' };
  }
  if (typeof expected === 'string') {
    if (expected.trim() === '') {
      return { ungraded: true, reason: 'empty_expected_ungraded' };
    }
    const normExpected = normalizeForMatch(expected);
    if (normExpected === '') {
      return { ungraded: true, reason: 'empty_expected_after_normalize' };
    }
    return { ungraded: false, normalizedExpected: normExpected };
  }
  // Non-string — pass through. Producer (typically an LLM judge) chooses.
  return { ungraded: false, normalizedExpected: '' };
}

/**
 * Substring-match-specific classifier.
 *
 * Wraps `classifyExpected()` and ALSO marks non-string `expected` as
 * UNGRADED (with reason `'non_string_expected_not_substring_matchable'`).
 * Use this when the consumer IS a substring-inclusion matcher, NOT when
 * the consumer forwards the value to an LLM judge (use `classifyExpected`
 * there so the judge can interpret structured expectations).
 *
 * Why a separate classifier: substring matching cannot match non-string
 * targets without coercion. Without this check, a substring matcher
 * would silently emit INCORRECT for a `{ outputContains: ['42'] }`
 * expectation — masking a dataset-shape mismatch as a content mismatch
 * in audit logs and creating a cross-consumer divergence with the LLM
 * judge path (which would have produced a reasoned judge verdict).
 *
 * Every literal in the `UngradedReason` union has exactly one producer;
 * `non_string_expected_not_substring_matchable` is produced ONLY here.
 */
export function classifyExpectedForSubstringMatch(expected: unknown): ExpectedClassification {
  if (expected === undefined || expected === null) {
    return { ungraded: true, reason: 'empty_expected_ungraded' };
  }
  if (typeof expected !== 'string') {
    return { ungraded: true, reason: 'non_string_expected_not_substring_matchable' };
  }
  // String inputs: defer to the general-purpose classifier for the
  // standard empty / whitespace / post-normalize-empty handling.
  return classifyExpected(expected);
}

/**
 * Deterministic substring-inclusion match over two pre-normalized strings.
 *
 * Defensive: returns false (NOT true) when `normExpected === ''`. This
 * blocks the historical regression where `String.prototype.includes('')`
 * returned true for any actual text. The empty-normalized case occurs
 * only for non-string `expected` values (post-classifyExpected), which
 * we conservatively refuse to match.
 */
export function isNormalizedSubstringMatch(normActual: string, normExpected: string): boolean {
  if (normExpected === '') return false;
  return normActual.includes(normExpected);
}
