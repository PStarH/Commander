/**
 * Tests for packages/core/src/observability/normalizeExpected.ts — the
 * shared scoring primitives extracted from the duplicated `normalize()`
 * helper in `evalScorer.ts` and `scripts/benchmark-gaia.ts`.
 *
 * Why this file exists:
 *   The previous design had the SAME normalize() function copy-pasted in
 *   two places, with the SAME ungraded reasoning logic copy-pasted in
 *   two places, and a quote-commented CROSS-FILE CONTRACT warning. The
 *   reviewer's #1 critical finding flagged silent drift between the two
 *   copies as the most material risk: offline benchmark says CORRECT,
 *   production scorer says UNGRADED on the same input, and audits have
 *   no way to explain the discrepancy.
 *
 *   After this refactor, both consumers import the SAME module. These
 *   tests lock down the shared module's contract so any future divergence
 *   attempt would surface here, before either consumer could be touched.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeForMatch,
  classifyExpected,
  classifyExpectedForSubstringMatch,
  isNormalizedSubstringMatch,
  type UngradedReason,
} from '../../src/observability/normalizeExpected';

// ─────────────────────────────────────────────────────────────────────────────
// Module-scope diagnostic helper
// ─────────────────────────────────────────────────────────────────────────────
//
// `safeRepr` is used by the static-drift lockdown's behavioral sweep to format
// the input that triggered a regression, AND by the `describe('safeRepr
// diagnostic helper')` block to assert its own contract. Hoisting to module
// scope (rather than keeping it as a closure inside the lockdown block) is
// deliberate: a closure-bound `safeRepr` would force the diagnostic block to
// re-declare the body word-for-word, and any future maintainer updating one
// copy but not the other would silently invalidate the test contract.
//
// Both blocks now call the SAME module-scope function — single source of
// truth, no drift hazard.

/**
 * Safe stringification for error messages — handles BigInt (which
 * `JSON.stringify` throws on), Symbol (which `JSON.stringify` renders
 * as `undefined`), and functions (same). NEVER throws — critical because
 * the test's failure path should not be masked by a serialization error
 * inside the failure-message-construction path.
 *
 * BigInt special-case: the top-level `typeof input === 'bigint'` branch
 * renders the value as `BigInt(N)` (e.g. `BigInt(0)`) so the type is
 * unambiguous in error messages. Without this, the alternate path — a
 * replacer returning `'0n'` and JSON.stringify wrapping it as `'"0n"'` —
 * would render indistinguishably from a Number's `"0"` once interpolated
 * into the surrounding template literal. The early-return avoids that
 * confusion and gives the regression-debug engineer an unambiguous
 * "classifyExpected(BigInt(0)) returned ..." message.
 */
function safeRepr(input: unknown): string {
  // Top-level BigInt: render as `BigInt(N)` so type reads cleanly.
  if (typeof input === 'bigint') return `BigInt(${String(input)})`;
  try {
    return (
      JSON.stringify(input, (_k, v) =>
        typeof v === 'bigint' ? `${String(v)}n` : v,
      ) ?? String(input)
    );
  } catch {
    return String(input);
  }
}

describe('normalizeForMatch', () => {
  it('returns "" for null', () => {
    expect(normalizeForMatch(null)).toBe('');
  });
  it('returns "" for undefined', () => {
    expect(normalizeForMatch(undefined)).toBe('');
  });
  it('returns "" for empty string', () => {
    expect(normalizeForMatch('')).toBe('');
  });
  it('returns "" for whitespace-only', () => {
    expect(normalizeForMatch('   ')).toBe('');
  });
  it('lowercases uppercase ASCII', () => {
    expect(normalizeForMatch('HELLO')).toBe('hello');
  });
  it('lowercases mixed-case', () => {
    expect(normalizeForMatch('Tim Cook')).toBe('tim cook');
  });
  it('collapses multiple whitespace characters into a single space', () => {
    expect(normalizeForMatch('a   b\t\tc\nd')).toBe('a b c d');
  });
  it('strips trailing period', () => {
    expect(normalizeForMatch('apple.')).toBe('apple');
  });
  it('strips commas, quotes, parens, apostrophes, !, ?', () => {
    expect(normalizeForMatch('"hello, (world)!"')).toBe('hello world');
  });
  it('strips the period-and-combo "\'!?" all-punctuation regression-safety case', () => {
    expect(normalizeForMatch("It's?!")).toBe('its');
  });
  it('preserves hyphens, slashes, and digits', () => {
    expect(normalizeForMatch('order-1/item-A')).toBe('order-1/item-a');
  });
  it('trims surrounding whitespace after collapsing', () => {
    expect(normalizeForMatch('  hello   ')).toBe('hello');
  });
});

describe('classifyExpected', () => {
  // ── Ungraded paths (the historical regression) ──────────────────────
  it('classifies undefined as ungraded (empty_expected_ungraded)', () => {
    expect(classifyExpected(undefined)).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('classifies null as ungraded (empty_expected_ungraded)', () => {
    expect(classifyExpected(null)).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('classifies "" as ungraded (empty_expected_ungraded)', () => {
    expect(classifyExpected('')).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('classifies "   " (whitespace only) as ungraded (empty_expected_ungraded)', () => {
    expect(classifyExpected('   ')).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('classifies "..." (all-punctuation raw) as ungraded (empty_expected_after_normalize) [regression-safety]', () => {
    expect(classifyExpected('...')).toEqual({
      ungraded: true,
      reason: 'empty_expected_after_normalize',
    });
  });
  it('classifies "!?.," (all-punctuation combo) as ungraded (empty_expected_after_normalize)', () => {
    expect(classifyExpected('!?.,')).toEqual({
      ungraded: true,
      reason: 'empty_expected_after_normalize',
    });
  });

  // ── Graded paths ────────────────────────────────────────────────────
  it('classifies "Tim Cook" as graded with normalizedExpected="tim cook"', () => {
    expect(classifyExpected('Tim Cook')).toEqual({
      ungraded: false,
      normalizedExpected: 'tim cook',
    });
  });
  it('classifies "  Tim   Cook  " as graded (whitespace collapse)', () => {
    expect(classifyExpected('  Tim   Cook  ')).toEqual({
      ungraded: false,
      normalizedExpected: 'tim cook',
    });
  });
  it('classifies "Tim Cook\'s keynote." as graded (punctuation stripped)', () => {
    expect(classifyExpected("Tim Cook's keynote.")).toEqual({
      ungraded: false,
      normalizedExpected: 'tim cooks keynote',
    });
  });

  // ── Non-string passthrough (must NOT mark ungraded) ─────────────────
  it('classifies object expected as graded with empty normalized (pass-through to LLM judge)', () => {
    expect(classifyExpected({ outputContains: ['y'] })).toEqual({
      ungraded: false,
      normalizedExpected: '',
    });
  });
  it('classifies number expected as graded with empty normalized (pass-through)', () => {
    expect(classifyExpected(42)).toEqual({
      ungraded: false,
      normalizedExpected: '',
    });
  });
  it('classifies array expected as graded with empty normalized (pass-through)', () => {
    expect(classifyExpected([1, 2, 3])).toEqual({
      ungraded: false,
      normalizedExpected: '',
    });
  });
  it('classifies boolean expected as graded with empty normalized (pass-through)', () => {
    expect(classifyExpected(false)).toEqual({
      ungraded: false,
      normalizedExpected: '',
    });
  });
});

describe('isNormalizedSubstringMatch', () => {
  it('returns true when normalized actual contains normalized expected', () => {
    expect(isNormalizedSubstringMatch('tim cook is the ceo of apple', 'tim cook')).toBe(true);
  });
  it('returns false when normalized actual does NOT contain normalized expected', () => {
    expect(isNormalizedSubstringMatch('sundar pichai is the ceo', 'tim cook')).toBe(false);
  });
  it('returns false when normExpected="" (regression-safety — blocks String.includes("") === true)', () => {
    expect(isNormalizedSubstringMatch('anything goes here', '')).toBe(false);
  });
  it('returns false when normExpected="   " (whitespace-only)', () => {
    expect(isNormalizedSubstringMatch('anything goes here', '   ')).toBe(false);
  });
  it('returns true for exact match', () => {
    expect(isNormalizedSubstringMatch('apple', 'apple')).toBe(true);
  });
  it('returns false when actual is empty', () => {
    expect(isNormalizedSubstringMatch('', 'apple')).toBe(false);
  });
});

/**
 * Consumer-invariant regression table — the historical 69.7% bug surface.
 *
 * If any of these cases mis-classifies, then EITHER the production
 * `EvalScorer` OR the offline `scripts/benchmark-gaia.ts` will produce
 * an "incorrect" verdict that disagrees with the other, and audits will
 * have no way to explain the discrepancy. This is the single test that
 * blocks the regression the code-reviewer flagged as the most material
 * risk of the previously-duplicated design.
 */
describe('consumer-invariant: regression-safety semantic must be stable', () => {
  const REGRESSION_CASES: Array<{ expected: unknown; reason: UngradedReason }> = [
    { expected: undefined, reason: 'empty_expected_ungraded' },
    { expected: null, reason: 'empty_expected_ungraded' },
    { expected: '', reason: 'empty_expected_ungraded' },
    { expected: '   ', reason: 'empty_expected_ungraded' },
    { expected: '\t\n', reason: 'empty_expected_ungraded' },
    { expected: '...', reason: 'empty_expected_after_normalize' },
    { expected: ',', reason: 'empty_expected_after_normalize' },
    { expected: '!?.', reason: 'empty_expected_after_normalize' },
  ];

  for (const c of REGRESSION_CASES) {
    it(`classifies ${JSON.stringify(c.expected)} → ungraded with reason "${c.reason}"`, () => {
      const r = classifyExpected(c.expected);
      expect(r.ungraded).toBe(true);
      if (r.ungraded) {
        expect(r.reason).toBe(c.reason);
      }
    });
  }
});

/**
 * Substring-match-specific classifier.
 *
 * Every literal in the regression-safety invariant table above must also
 * classify as ungraded under this helper (string inputs defer to
 * `classifyExpected()`). Non-string inputs additionally route to
 * `'non_string_expected_not_substring_matchable'` — closing the historical
 * silent-INCORRECT path that masked dataset-shape mismatches as
 * content mismatches in audit logs.
 */
describe('classifyExpectedForSubstringMatch', () => {
  // ── Same as classifyExpected() for string inputs (defer to it) ──────
  it('defers undefined → empty_expected_ungraded (matches classifyExpected)', () => {
    expect(classifyExpectedForSubstringMatch(undefined)).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('defers null → empty_expected_ungraded (matches classifyExpected)', () => {
    expect(classifyExpectedForSubstringMatch(null)).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('defers "" → empty_expected_ungraded (matches classifyExpected)', () => {
    expect(classifyExpectedForSubstringMatch('')).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('defers "   " → empty_expected_ungraded (matches classifyExpected)', () => {
    expect(classifyExpectedForSubstringMatch('   ')).toEqual({
      ungraded: true,
      reason: 'empty_expected_ungraded',
    });
  });
  it('defers "..." → empty_expected_after_normalize (matches classifyExpected)', () => {
    expect(classifyExpectedForSubstringMatch('...')).toEqual({
      ungraded: true,
      reason: 'empty_expected_after_normalize',
    });
  });
  it('defers "Tim Cook" → graded with normalized "tim cook" (matches classifyExpected)', () => {
    expect(classifyExpectedForSubstringMatch('Tim Cook')).toEqual({
      ungraded: false,
      normalizedExpected: 'tim cook',
    });
  });

  // ── Diverges from classifyExpected() on non-string inputs ──────────
  it('non-string object expected → non_string_expected_not_substring_matchable (≠ classifyExpected)', () => {
    expect(
      classifyExpectedForSubstringMatch({ outputContains: ['y'] }),
    ).toEqual({
      ungraded: true,
      reason: 'non_string_expected_not_substring_matchable',
    });
  });
  it('number expected → non_string_expected_not_substring_matchable', () => {
    expect(classifyExpectedForSubstringMatch(42)).toEqual({
      ungraded: true,
      reason: 'non_string_expected_not_substring_matchable',
    });
  });
  it('array expected → non_string_expected_not_substring_matchable', () => {
    expect(classifyExpectedForSubstringMatch([1, 2, 3])).toEqual({
      ungraded: true,
      reason: 'non_string_expected_not_substring_matchable',
    });
  });
  it('boolean expected → non_string_expected_not_substring_matchable', () => {
    expect(classifyExpectedForSubstringMatch(true)).toEqual({
      ungraded: true,
      reason: 'non_string_expected_not_substring_matchable',
    });
  });
  it('null-prototype object (Object.create(null)) → non_string_expected_not_substring_matchable', () => {
    expect(classifyExpectedForSubstringMatch(Object.create(null))).toEqual({
      ungraded: true,
      reason: 'non_string_expected_not_substring_matchable',
    });
  });
});

/**
 * Audit-log equivalence: for STRING inputs, the two classifiers MUST agree.
 * For NON-STRING inputs, they intentionally diverge (this is a documented
 * capability difference, not a bug) — this test asserts that the divergence
 * is observable so an audit can reconcile the two logs by inspecting the
 * literal reason.
 */
describe('audit: classifyExpected vs classifyExpectedForSubstringMatch divergence table', () => {
  it('agree on undefined, null, "", "   ", "...", "Tim Cook"', () => {
    const SEVEN_AGREE_CASES: unknown[] = [
      undefined,
      null,
      '',
      '   ',
      '...',
      'Tim Cook',
    ];
    for (const c of SEVEN_AGREE_CASES) {
      expect(classifyExpectedForSubstringMatch(c)).toEqual(classifyExpected(c));
    }
  });

  it('intentionally diverge on non-string inputs (call-site must pick the right classifier)', () => {
    const DIVERGE_CASES: unknown[] = [
      { outputContains: ['y'] },
      42,
      [1, 2, 3],
      true,
      false,
    ];
    for (const c of DIVERGE_CASES) {
      const general = classifyExpected(c);
      const substring = classifyExpectedForSubstringMatch(c);
      // General returns graded+empty (pass-through to judge).
      expect(general).toEqual({ ungraded: false, normalizedExpected: '' });
      // Substring-matcher refuses with new reason literal.
      expect(substring).toEqual({
        ungraded: true,
        reason: 'non_string_expected_not_substring_matchable',
      });
    }
  });
});

/**
 * STATIC-DRIFT LOCKDOWN
 * ----------------------
 * Locks the dual-classifier invariant: the literal
 * `'non_string_expected_not_substring_matchable'` MUST be produced
 * exclusively by `classifyExpectedForSubstringMatch()`. If a future
 * maintainer accidentally:
 *   • adds a return path in `classifyExpected()` that emits this literal
 *     (e.g. as part of a unified "structured pass-through" refactor),
 *   • duplicates the literal in another producer (silent producer-split),
 *   • removes the only producer (silent consumer break),
 * then any of the four tests below will fail LOUDLY at vitest CI.
 *
 * Four complementary assertions:
 *   1. Quoted-context source negative — `classifyExpected.toString()` MUST NOT
 *      contain the literal in any quote form. Defensive regex with the
 *      character class `['"\``]` covers all of vitest's transform
 *      quote-style choices (`'…'`, `"…"`, template literals).
 *   2. Quoted-context source positive — `classifyExpectedForSubstringMatch.toString()`
 *      MUST contain the literal in some quoted form. Catches
 *      "the producer was deleted".
 *   3. Cross-producer count matrix — the literal appears in EXACTLY ONE
 *      producer source, EXACTLY ONCE. Catches silent duplication
 *      (including within-producer duplication that a non-`g` regex
 *      would miss).
 *   4. Behavioral exhaustive sweep — `classifyExpected()` MUST NOT return
 *      the literal at runtime for any input in the expanded input space,
 *      even ones a future refactor might add. Goes beyond source-search
 *      to catch explicit `as any` escapes. The error message uses the
 *      module-scope `safeRepr` helper that handles BigInt (rendering as
 *      `BigInt(N)`), Symbol, and functions, so the failure mode isn't
 *      masked by a serialization error inside the error path itself.
 */
describe('static-drift lockdown: non_string_expected_not_substring_matchable has exactly one producer', () => {
  const NON_STRING_LITERAL = 'non_string_expected_not_substring_matchable';
  // Quote-tolerant regex — vitest's TypeScript transform may convert the
  // emitted JS from `'` to `"` or backticks (depends on esbuild config).
  // The character class `['"\``]` matches all three forms. No `g` flag
  // (used for boolean `.test()` calls — avoids lastIndex pollution).
  const QUOTED_LITERAL_RE = /['"`]non_string_expected_not_substring_matchable['"`]/;
  // All exported functions in normalizeExpected.ts. Each MUST be examined
  // for the literal; the count matrix below locks the topology.
  const ALL_EXPORTS = [
    classifyExpected,
    classifyExpectedForSubstringMatch,
    normalizeForMatch,
    isNormalizedSubstringMatch,
  ];

  it('classifyExpected.toString() does NOT contain the literal in any quoted form', () => {
    expect(QUOTED_LITERAL_RE.test(classifyExpected.toString())).toBe(false);
  });

  it('classifyExpectedForSubstringMatch.toString() DOES contain the literal in any quoted form', () => {
    expect(QUOTED_LITERAL_RE.test(classifyExpectedForSubstringMatch.toString())).toBe(true);
  });

  it('the literal appears in EXACTLY ONE producer source, EXACTLY ONCE (no silent duplication)', () => {
    // Inline `g`-flag regex literal — JavaScript creates a fresh RegExp
    // object each time a regex literal is evaluated per ECMA-262, so there
    // is no `lastIndex` state pollution across `.match()` calls. The `g`
    // flag is required to count ALL occurrences within a single producer's
    // source (catches WITHIN-producer duplication).
    const occurrences = ALL_EXPORTS.map(
      (fn) =>
        (fn.toString().match(/['"`]non_string_expected_not_substring_matchable['"`]/g) ?? [])
          .length,
    );
    expect(occurrences).toEqual([0, 1, 0, 0]);
  });

  it('classifyExpected() NEVER returns the literal for any input (behavioral exhaustive sweep)', () => {
    // Expanded input set covering every branch path inside classifyExpected,
    // including exotic non-string types that a future refactor might add
    // dedicated branches for. Each input is documented inline.
    const EXHAUSTIVE_INPUTS: unknown[] = [
      // undefined / null                → empty_expected_ungraded
      undefined,
      null,
      // whitespace strings              → empty_expected_ungraded
      '',
      '   ',
      '\t\n',
      // all-punctuation strings         → empty_expected_after_normalize
      '...',
      ',',
      '!?.',
      // clean strings                   → graded
      'Tim Cook',
      "Tim Cook's keynote.",
      // numbers incl. NaN / ±Infinity   → pass-through
      42,
      3.14,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      // bigint                          → pass-through (BigInt-rendered via safeRepr)
      BigInt(0),
      // arrays (non-empty, empty)       → pass-through
      [1, 2, 3],
      [],
      // objects (3 flavors)             → pass-through
      { outputContains: ['y'] },
      {},
      Object.create(null),
      // booleans                        → pass-through
      true,
      false,
      // symbol                          → pass-through (JSON.stringify renders undefined)
      Symbol('x'),
      // function                        → pass-through (JSON.stringify renders undefined)
      () => undefined,
      // Date / Map / Set / RegExp / Error — no dedicated branch in classifyExpected
      // today, but defended against future refactors that might add one.
      new Date(),
      new Map(),
      new Set(),
      /x/,
      new Error('boom'),
    ];

    for (const input of EXHAUSTIVE_INPUTS) {
      const r = classifyExpected(input);
      if (r.ungraded && r.reason === NON_STRING_LITERAL) {
        throw new Error(
          `classifyExpected(${safeRepr(input)}) returned ` +
            `'${NON_STRING_LITERAL}' — this literal must be produced ONLY by ` +
            `classifyExpectedForSubstringMatch.`,
        );
      }
    }
  });
});

/**
 * Stand-alone contract tests for the module-scope `safeRepr()` helper.
 * Asserts that the BigInt polish (`BigInt(N)`) and JSON-fallback paths
 * (Symbol, function, etc.) actually behave as documented, without
 * reproducing the body inline (which would recreate the drift hazard
 * the lockdown's reviewer flagged as ship-blocking).
 *
 * If a future maintainer updates `safeRepr` (module scope), this block
 * will catch rendered-output regressions immediately at vitest CI —
 * the production behavior won't diverge from the test contract.
 */
describe('safeRepr diagnostic helper', () => {
  it('renders BigInt as `BigInt(N)` — distinct from Number "N"', () => {
    expect(safeRepr(BigInt(7))).toBe('BigInt(7)');
    expect(safeRepr(BigInt(0))).toBe('BigInt(0)');
    expect(safeRepr(BigInt(-1))).toBe('BigInt(-1)');
  });

  it('renders Number via JSON.stringify', () => {
    expect(safeRepr(7)).toBe('7');
    expect(safeRepr(0)).toBe('0');
    expect(safeRepr(-1)).toBe('-1');
  });

  it('BigInt vs Number renders are visibly different', () => {
    expect(safeRepr(BigInt(7))).not.toBe(safeRepr(7));
  });

  it('renders Symbol as `Symbol(description)` (not the JSON "undefined")', () => {
    // JSON.stringify(Symbol('x')) returns undefined → ?? falls back to
    // String(input) which yields the symbol description.
    expect(safeRepr(Symbol('x'))).toBe('Symbol(x)');
  });

  it('renders function as source-string (not the JSON "undefined")', () => {
    const sentinel = () => undefined;
    expect(safeRepr(sentinel)).toBe(String(sentinel));
  });

  it('renders object as JSON', () => {
    expect(safeRepr({ a: 1 })).toBe('{"a":1}');
  });

  it('renders null and undefined correctly', () => {
    expect(safeRepr(null)).toBe('null');
    expect(safeRepr(undefined)).toBe(String(undefined));
  });
});
