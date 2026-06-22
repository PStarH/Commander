/**
 * D3.1 hardening — rotation sign-off verifier as a stable library API.
 *
 * Why this exists
 * ───────────────
 * D3.1 promotes the rotation sign-off verifier from a CLI-only artifact
 * (scripts/verify-rotation-signoff.ts, pre-D3.1) to a stable library
 * surface published from `@commander/core`. Consumers (CI gates, alerting
 * dashboards, fork operators) can now import `evaluateSignoff`,
 * `runVerifier`, `parseArgs`, plus the canonical types and policy
 * constants, WITHOUT needing to exec the CLI or reach into deep relative
 * paths under `scripts/`.
 *
 * This test suite pins the library API contract at four layers:
 *
 *   1. Module-shape   — every exported name resolves at the surface.
 *   2. Type-shape     — a typed consumer sample compiles AND runs.
 *   3. Pure-function  — evaluateSignoff / parseArgs shape on circular
 *                        cases (OK empty reasons, dual-clause reasons,
 *                        flag combos).
 *   4. Barrel         — the values surface is reachable via both the main
 *      exposition       barrel (`@commander/core`) and the security barrel
 *                        (`@commander/core/security`).
 *
 * mkRow contract: `error: string | null` (REQUIRED, no `?`). The compile-
 * time guarantee comes from the bare signature on `mkRow`; vitest confirms
 * the runtime propagation behaviour. Mirrors the d26-test factory helper.
 */

import { describe, expect, it } from 'vitest';

// ── Imports from the MAIN barrel ('@commander/core' surface) — proves the
// library's VALUES reach the top-level surface, not just the deep
// `src/security/...` path. The main barrel RENEAMS the type aliases
// (RotationSignoffResult, RotationSignoffRow, …) to avoid colliding with
// the existing `VerifyResult` re-export from capabilityToken — that's why
// we also import the canonical type names from the security barrel
// (where no aliasing is needed for the security namespace).
import {
  evaluateSignoff,
  parseArgs,
  runVerifier,
  formatReport,
  verifySha,
  extractSection,
  parseSignoffTable,
  countColumns,
  POLICY_MIN_VERIFIED_ROWS,
  POLICY_VERSION,
  SHA_RE,
  DEFAULT_DOC_PATH,
} from '../../src';
// Type-only imports. The three types that survive barrel collision
// (`SignoffRow`, `CliArgs`, `RunVerifierOptions`) come from the security
// barrel — they have unique names and re-export cleanly. `VerifyResult`
// is imported DIRECT-from-file because the security barrel already
// exports an unrelated same-named type from `capabilityToken` (see the
// verifier file's "Importing" section for the three alternative
// approaches — value-inference, direct-from-file, or the main-barrel
// alias `RotationSignoffResult`).
import type { SignoffRow, CliArgs, RunVerifierOptions } from '../../src/security';
import type { VerifyResult } from '../../src/security/rotationSignoffVerifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a `SignoffRow` with the fields that matter for the policy evaluator.
 * `error` is `string | null` (NO optional fallback) — every caller must
 * pass `error: null` for a success-path row or `error: '<reason>'` for a
 * failure-path row.
 */
function mkRow(opts: {
  role: string;
  sha?: string;
  verified?: boolean;
  signedAt?: string | null;
  error: string | null;
}): SignoffRow {
  return {
    role: opts.role,
    name: '',
    handle: '',
    fingerprint: '',
    sha: opts.sha ?? '',
    signedAt: opts.signedAt ?? null,
    signedBy: null,
    verified: opts.verified ?? false,
    error: opts.error,
  };
}

// ===========================================================================
// 1. Module-shape: every named export resolves at the surface.
// ===========================================================================

describe('D3.1 hardening — module surface (functions + constants reach the @commander/core export)', () => {
  it('pure functions: types + values resolve as functions', () => {
    expect(typeof evaluateSignoff).toBe('function');
    expect(typeof parseArgs).toBe('function');
    expect(typeof runVerifier).toBe('function');
    expect(typeof formatReport).toBe('function');
    expect(typeof verifySha).toBe('function');
    expect(typeof extractSection).toBe('function');
    expect(typeof parseSignoffTable).toBe('function');
    expect(typeof countColumns).toBe('function');
  });

  it('constants: policy tags + structural constants reach the surface with correct values', () => {
    expect(POLICY_MIN_VERIFIED_ROWS).toBe(4);
    expect(POLICY_VERSION).toBe('D2.9');
    expect(SHA_RE).toBeInstanceOf(RegExp);
    expect(typeof DEFAULT_DOC_PATH).toBe('string');
    expect(DEFAULT_DOC_PATH).toBe('docs/security/keys-rotation.md');
    // SHA regex anchored on both ends, hex only, 7..64 chars.
    expect(SHA_RE.test('abc1234')).toBe(true);
    expect(SHA_RE.test('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(SHA_RE.test('xyz-bad!')).toBe(false);
  });
});

// ===========================================================================
// 2. Type-shape: a typed consumer sample compiles AND runs correctly.
// ===========================================================================

describe('D3.1 hardening — typed consumer sample (VerifyResult reasons[] contract)', () => {
  /**
   * EXAMPLE CONSUMER: a downstream alerting pipeline that consumes
   * `VerifyResult.reasons[]` — a structured signal designed precisely for
   * this pattern (vs regex-parsing `result.report`).
   *
   * This compiles because:
   *   • `result.reasons` is typed as `readonly string[]` at the library
   *     surface (canonical name: `VerifyResult` from `../src/security`).
   *   • The map callback receives each `string` element naturally.
   *   • The returned `AlertEntry` array consumes `result.exitCode`
   *     downstream — both clauses compose end-to-end.
   */
  interface AlertEntry {
    readonly source: 'rotation-verifier';
    readonly reason: string;
    readonly severity: 'critical' | 'low';
  }

  /**
   * Map a `VerifyResult` to an array of `AlertEntry` records, one per
   * discrete reason. Severity policy:
   *   • "policy NOT bound …" / "…unverified SHA…" → 'critical' (any of
   *     these = policy violation; downstream alerting should page).
   *   • Any other reason → 'low' (informational only).
   */
  function consumerAlert(result: VerifyResult): AlertEntry[] {
    return result.reasons.map((reason) => ({
      source: 'rotation-verifier' as const,
      reason,
      severity: reason.includes('NOT bound') || reason.includes('unverified') ? 'critical' : 'low',
    }));
  }

  it('typed consumer compiles AND builds an empty alert array on OK', () => {
    const rows: SignoffRow[] = [
      mkRow({ role: 'CISO', sha: 'abc1234', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'def5678', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: '9abcdef', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'cafe0000', verified: true, error: null }),
    ];
    const result: VerifyResult = evaluateSignoff(rows);
    expect(result.ok).toBe(true);
    // Type-level check at compile time: reasons is readonly string[].
    const _readonlyCheck: readonly string[] = result.reasons;
    expect(_readonlyCheck).toBe(result.reasons);
    // Runtime: consumer stays in sync with reasons[] shape.
    expect(consumerAlert(result)).toEqual([]);
  });

  it('typed consumer emits one alert per discrete reason on dual-clause RED', () => {
    const rows: SignoffRow[] = [
      mkRow({ role: 'CISO', sha: 'abc1234', verified: false, error: 'invalid SHA format' }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const result: VerifyResult = evaluateSignoff(rows);
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBe(2);
    const alerts = consumerAlert(result);
    expect(alerts.length).toBe(2);
    for (const a of alerts) {
      expect(a.source).toBe('rotation-verifier');
      expect(a.severity).toBe('critical');
    }
    expect(alerts[0]?.reason).toMatch(/policy NOT bound/);
    expect(alerts[1]?.reason).toMatch(/unverified SHA/);
  });
});

// ===========================================================================
// 3. Pure-function runtime: evaluateSignoff + parseArgs shape on circular
//    cases. Integration / filesystem cases are covered by the d26 file.
// ===========================================================================

describe('D3.1 hardening — runtime: evaluateSignoff reasons[] shape', () => {
  it('OK case: 4 verified rows → reasons: []', () => {
    const rows: SignoffRow[] = [
      mkRow({ role: 'CISO', sha: 'a1', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'b2', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'c3', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'd4', verified: true, error: null }),
    ];
    const r: VerifyResult = evaluateSignoff(rows);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.reasons).toEqual([]);
    expect(r.reasons.length).toBe(0);
  });

  it('RED single-clause case: 0 verified rows → reasons has 1 element', () => {
    const r: VerifyResult = evaluateSignoff([mkRow({ role: 'CISO', error: null })]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
  });

  it('RED dual-clause: 0 verified + 1 failed → reasons has 2 separate (NOT joined) elements', () => {
    const r: VerifyResult = evaluateSignoff([
      mkRow({ role: 'CISO', sha: 'bad', verified: false, error: 'invalid' }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ]);
    expect(r.reasons.length).toBe(2);
    expect(r.reasons[0]).toMatch(/policy NOT bound/);
    expect(r.reasons[1]).toMatch(/1 unverified SHA/);
    // Critically: NOT joined — each clause is its own array element.
    expect(r.reasons[0]?.includes('unverified SHA')).toBe(false);
    expect(r.reasons[1]?.includes('policy NOT bound')).toBe(false);
  });
});

describe('D3.1 hardening — runtime: parseArgs shape & defaults', () => {
  it('empty argv → defaults: DEFAULT_DOC_PATH / json: false / quiet: false', () => {
    const a: CliArgs = parseArgs([]);
    expect(a.docPath).toBe(DEFAULT_DOC_PATH);
    expect(a.json).toBe(false);
    expect(a.quiet).toBe(false);
  });

  it('--json only → json: true, rest default', () => {
    const a: CliArgs = parseArgs(['--json']);
    expect(a.json).toBe(true);
    expect(a.quiet).toBe(false);
    expect(a.docPath).toBe(DEFAULT_DOC_PATH);
  });

  it('--quiet only → quiet: true, rest default', () => {
    const a: CliArgs = parseArgs(['--quiet']);
    expect(a.quiet).toBe(true);
    expect(a.json).toBe(false);
    expect(a.docPath).toBe(DEFAULT_DOC_PATH);
  });

  it('--doc=<path> only → docPath resolves to <path>, rest default', () => {
    const a: CliArgs = parseArgs(['--doc=/tmp/custom-fork.md']);
    expect(a.docPath).toBe('/tmp/custom-fork.md');
    expect(a.json).toBe(false);
    expect(a.quiet).toBe(false);
  });

  it('--json + --quiet + --doc=<path>: all three flags combine', () => {
    const a: CliArgs = parseArgs(['--json', '--quiet', '--doc=./fork.md']);
    expect(a.json).toBe(true);
    expect(a.quiet).toBe(true);
    expect(a.docPath).toBe('./fork.md');
  });

  it('caller-supplied defaultDocPath overrides the library DEFAULT_DOC_PATH', () => {
    const a: CliArgs = parseArgs([], '/opt/fork/keys-rotation.md');
    expect(a.docPath).toBe('/opt/fork/keys-rotation.md');
    expect(a.json).toBe(false);
    expect(a.quiet).toBe(false);
  });

  it('extra positional args are ignored — only recognised flags are surfaced', () => {
    const a: CliArgs = parseArgs(['--json', 'positional-arg', '--unknown-flag', '--quiet']);
    expect(a.json).toBe(true);
    expect(a.quiet).toBe(true);
    expect(a.docPath).toBe(DEFAULT_DOC_PATH);
  });
});

// ===========================================================================
// 4. Barrel exposition: the surface is reachable via both layers.
// ===========================================================================

describe('D3.1 hardening — barrel exposition: surface reachable via both layers', () => {
  // Type-level checks: declaring the types as bindings proves the runtime
  // symbol is callable AND compiling the type binding proves the
  // TypeScript type is well-defined (no `any`, no missing exports).
  it('the main `@commander/core` barrel re-exports the values surface', () => {
    expect(typeof evaluateSignoff).toBe('function');
    expect(typeof parseArgs).toBe('function');
    expect(typeof runVerifier).toBe('function');
    // POLICY_VERSION is a string-literal type — bind it and check the value.
    const v: typeof POLICY_VERSION = POLICY_VERSION;
    expect(v).toBe('D2.9');
  });

  it('the security barrel exposes the canonical-type names that survive collision avoidance', () => {
    // Type-only — must compile AND not throw at runtime.
    // SignoffRow/CliArgs/RunVerifierOptions: from security barrel — unique
    // names, no collision with capabilityToken.
    const _rows: SignoffRow[] = [];
    const _args: CliArgs = parseArgs([]);
    const _opts: RunVerifierOptions = { repoRoot: process.cwd() };
    expect(_rows.length).toBe(0);
    expect(_args.json).toBe(false);
    expect(_opts.repoRoot).toBe(process.cwd());

    // VerifyResult is intentionally NOT re-exported from the security barrel
    // (collision with capabilityToken's same-named type); it's imported
    // direct-from-verifier-file at the top of this test file. The stronger
    // version of this test exercises the *empty-reasons-on-OK* contract:
    // 4 verified rows → ok=true → reasons:[] (covers the OK branch that the
    // earlier empty-rows fixture couldn't reach because empty input yields
    // verified=0 < min=4 → a single "policy NOT bound" reason instead).
    const _result: VerifyResult = evaluateSignoff([
      mkRow({ role: 'CISO', sha: 'a1', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'b2', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'c3', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'd4', verified: true, error: null }),
    ]);
    expect(_result.ok).toBe(true);
    expect(_result.exitCode).toBe(0);
    expect(_result.reasons).toEqual([]);
  });

  it('the runVerifier options surface is library-grade (repoRoot wired through)', () => {
    // Just confirming RunVerifierOptions is callable from the type surface;
    // actual filesystem tests live in the d26 file (integration).
    const opts: RunVerifierOptions = { repoRoot: process.cwd() };
    expect(opts.repoRoot).toBe(process.cwd());
  });
});
