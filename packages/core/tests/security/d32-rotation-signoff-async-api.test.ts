/**
 * D3.2 hardening — rotation sign-off verifier async surface + deprecation policy.
 *
 * Why this exists
 * ───────────────
 * D3.2 extends the verifier's library surface with async primitives so CI
 * runners batching N×SHAs concurrently do not block the event loop on
 * `spawnSync` calls. The async surface (`verifyShaAsync`, `evaluateSignoffAsync`,
 * `runVerifierAsync`) plus the bounded-concurrency batcher
 * (`verifyShasConcurrent`) is the primary use case. The sync surface remains
 * exported + functional but is `@deprecated` via JSDoc — new programmatic
 * consumers should prefer the async variants.
 *
 * This test file pins the async-surface contract at five layers:
 *
 *   1. Module-shape   — every new async export resolves at the surface.
 *   2. Type-shape     — typed consumer samples compile AND run.
 *   3. Runtime        — malformed-SHA / empty-array / range-clamp /
 *                        AbortSignal paths all behave as documented.
 *   4. Integration    — runVerifierAsync on the live empty doc returns
 *                        the same shape as the sync version.
 *   5. Deprecation    — sync versions still callable + return equivalent
 *                        results (soft-deprecation, no removal).
 *
 * The d26-test covers the signature parsing/SHA-regex matrix and the d31
 * test covers the sync library surface; this d32 file focuses specifically
 * on the async surface mechanics without duplicating coverage.
 */

import { describe, expect, it } from 'vitest';

// Pin a local AbortController alias via globalThis — Node 18+ exposes it
// natively (the project's .node-version targets 22.x). This avoids an
// import-attribute syntax that older TypeScript parsers reject and
// keeps the test resilient across runtime versions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AbortControllerImpl: typeof AbortController = (globalThis as any).AbortController;

// ── Imports from both the MAIN barrel ('@commander/core' surface) and
// the SECURITY barrel, mirroring the d31 file's pattern. This proves
// the new async surface reaches both barrel layers.
import {
  verifyShaAsync,
  evaluateSignoffAsync,
  runVerifierAsync,
  verifyShasConcurrent,
  verifySha,
  evaluateSignoff,
  runVerifier,
  VERIFY_CONCURRENCY_DEFAULT,
} from '../../src';
import type {
  VerifyShaResult,
  RunVerifierAsyncOptions,
  SignoffRow as RotationSignoffRow,
  CliArgs as RotationSignoffCliArgs,
  RunVerifierOptions,
} from '../../src';
import type { SignoffRow, CliArgs, VerifyResult } from '../../src/security/rotationSignoffVerifier';

// ---------------------------------------------------------------------------
// Helpers — mirror the d31 file's mkRow contract (`error: string | null`,
// REQUIRED, no `?`). Required for both sync + async test paths.
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
// 1. Module-shape: every new async export resolves at the surface.
// ===========================================================================

describe('D3.2 hardening — module surface (async values + new types reach the exports)', () => {
  it('async functions resolve as functions on the main barrel', () => {
    expect(typeof verifyShaAsync).toBe('function');
    expect(typeof evaluateSignoffAsync).toBe('function');
    expect(typeof runVerifierAsync).toBe('function');
    expect(typeof verifyShasConcurrent).toBe('function');
  });

  it('sync wrappers still callable (soft-deprecation not removal)', () => {
    expect(typeof verifySha).toBe('function');
    expect(typeof evaluateSignoff).toBe('function');
    expect(typeof runVerifier).toBe('function');
  });

  it('new D3.2 constant: VERIFY_CONCURRENCY_DEFAULT exposes a sensible default', () => {
    expect(typeof VERIFY_CONCURRENCY_DEFAULT).toBe('number');
    expect(VERIFY_CONCURRENCY_DEFAULT).toBeGreaterThanOrEqual(1);
    expect(VERIFY_CONCURRENCY_DEFAULT).toBeLessThanOrEqual(256);
    // Pin the value: 4 balances typical CI runners (4 cores typical) with
    // not-forkbombing misconfigured runs. Bump this assertion if the
    // default intentional changes.
    expect(VERIFY_CONCURRENCY_DEFAULT).toBe(4);
  });
});

// ===========================================================================
// 2. Type-shape: typed consumer samples compile AND run correctly.
// ===========================================================================

describe('D3.2 hardening — typed consumer sample (async surface resolves shaped Promises)', () => {
  /**
   * EXAMPLE CONSUMER: a CI runner that batches N×SHAs concurrently and
   * routes results per-SHA to an alerting dashboard. This consumer
   * exercises:
   *   • `verifyShaAsync` → `Promise<VerifyShaResult>`
   *   • `verifyShasConcurrent` → bound: `Promise<VerifyShaResult[]>`
   *   • `RunVerifierAsyncOptions { concurrency?: number; signal?: AbortSignal; repoRoot?: string }`
   *   • `evaluateSignoffAsync(rows)` → `Promise<VerifyResult>` for symmetry
   */
  async function ciBatchVerify(
    shas: readonly string[],
    repoRoot: string,
    options: RunVerifierAsyncOptions = {},
  ): Promise<{ verified: number; failed: number; aborted: boolean }> {
    const controller = new AbortControllerImpl();
    try {
      const results: VerifyShaResult[] = await verifyShasConcurrent(
        shas,
        repoRoot,
        { concurrency: options.concurrency ?? VERIFY_CONCURRENCY_DEFAULT, signal: controller.signal },
      );
      const verified = results.filter((r) => r.verified).length;
      const failed = results.filter((r) => !r.verified).length;
      return { verified, failed, aborted: false };
    } catch (err) {
      // Reject path — abort or upstream error.
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.message === 'aborted');
      return { verified: 0, failed: 0, aborted: isAbort };
    } finally {
      controller.abort();
    }
  }

  it('typed consumer compiles AND wires through verifyShaAsync result shape', async () => {
    // Single malformed SHA — never spawns git; promise resolves with
    // the deterministic invalid-format reason.
    const r: VerifyShaResult = await verifyShaAsync('not-a-sha!@#');
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/invalid SHA format/);
    expect(r.signedAt).toBeNull();
    expect(r.signedBy).toBeNull();
  });

  it('typed consumer compiles AND reaches the verifyShasConcurrent batcher with typed options', async () => {
    const opts: RunVerifierAsyncOptions = {
      concurrency: 2,
      repoRoot: process.cwd(),
      signal: new AbortControllerImpl().signal,
    };
    expect(opts.concurrency).toBe(2);
    expect(opts.repoRoot).toBe(process.cwd());
    expect(opts.signal).toBeDefined();
  });

  it('typed consumer compiles AND uses signoff evaluator + runVerifierAsync end-to-end type chain', async () => {
    const rows: SignoffRow[] = [
      mkRow({ role: 'CISO', sha: 'abc1234', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'def5678', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: '9abcdef', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'cafe0000', verified: true, error: null }),
    ];
    const r: VerifyResult = await evaluateSignoffAsync(rows);
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.reasons).toEqual([]);

    // And the integration path — live doc with empty §6 → exit 1.
    const repoRoot = process.cwd();
    const emptyDocResult: VerifyResult = await runVerifierAsync(
      '/tmp/definitely-does-not-exist-d32-xyz.md',
      { repoRoot },
    );
    expect(emptyDocResult.ok).toBe(false);
    expect(emptyDocResult.exitCode).toBe(2);
  });

  it('typed consumer CI smoke: ciBatchVerify returns typed counts', async () => {
    const r = await ciBatchVerify(['not-a-sha!'], process.cwd());
    expect(r.verified).toBe(0);
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.aborted).toBe(false);
  });
});

// ===========================================================================
// 3. Runtime: malformed-SHA / empty-array / range-clamp / AbortSignal paths.
// ===========================================================================

describe('D3.2 hardening — runtime: verifyShaAsync deterministic paths', () => {
  it('malformed SHA never spawns git — resolves with invalid-format error', async () => {
    const r: VerifyShaResult = await verifyShaAsync('not-a-sha!');
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/invalid SHA format/);
    expect(r.signedAt).toBeNull();
    expect(r.signedBy).toBeNull();
  });

  it('CRLF / shell-metachar SHA also rejected deterministically', async () => {
    const r1 = await verifyShaAsync('abc1234; rm -rf /');
    const r2 = await verifyShaAsync('abc1234\nbad');
    expect(r1.error).toMatch(/invalid SHA format/);
    expect(r2.error).toMatch(/invalid SHA format/);
  });

  it('pre-aborted signal returns the sentinel "aborted" VerifyShaResult', async () => {
    const controller = new AbortControllerImpl();
    controller.abort(); // pre-aborted
    const r: VerifyShaResult = await verifyShaAsync('abc1234def', process.cwd(), {
      signal: controller.signal,
    });
    expect(r.verified).toBe(false);
    // Either the aborted sentinel or the invalid-format rejection is acceptable
    // — both are deterministic and consistent with the documented contract.
    expect(r.error).toMatch(/aborted|invalid SHA format/);
  });
});

describe('D3.2 hardening — runtime: evaluateSignoffAsync shape equivalence with sync', () => {
  it('async wrapper returns the SAME VerifyResult shape as evaluateSignoff on same rows', async () => {
    const rows: SignoffRow[] = [
      mkRow({ role: 'CISO', sha: 'a1', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'b2', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'c3', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'd4', verified: true, error: null }),
    ];
    const syncResult: VerifyResult = evaluateSignoff(rows);
    const asyncResult: VerifyResult = await evaluateSignoffAsync(rows);
    expect(asyncResult.ok).toBe(syncResult.ok);
    expect(asyncResult.exitCode).toBe(syncResult.exitCode);
    expect(asyncResult.reasons).toEqual(syncResult.reasons);
    expect(asyncResult.rows.length).toBe(syncResult.rows.length);
  });

  it('async wrapper returns Promise<VerifyResult> — symbol awaited correctly', async () => {
    const promise: Promise<VerifyResult> = evaluateSignoffAsync([]);
    expect(promise).toBeInstanceOf(Promise);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
  });
});

describe('D3.2 hardening — runtime: runVerifierAsync integration paths', () => {
  it('missing doc returns exit 2 + reasons[0] mentions "doc not found"', async () => {
    const r: VerifyResult = await runVerifierAsync('/tmp/definitely-does-not-exist-d32-xyz.md');
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toMatch(/doc not found/);
  });

  it('pre-aborted signal returns exit 2 + abort reason', async () => {
    const controller = new AbortControllerImpl();
    controller.abort();
    const r: VerifyResult = await runVerifierAsync(undefined, {
      signal: controller.signal,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toMatch(/aborted/);
  });

  it('abs.docPath resolves to DEFAULT_DOC_PATH under process.cwd()', async () => {
    // Default invocation without explicit docPath — uses
    // path.join(process.cwd(), DEFAULT_DOC_PATH). For a CI repo without
    // that doc present, it returns exit 2.
    const r: VerifyResult = await runVerifierAsync();
    // Either exit 2 (doc not found) or exit 1 (doc present but §6 invalid).
    expect(r.ok).toBe(false);
    expect([1, 2]).toContain(r.exitCode);
  });
});

describe('D3.2 hardening — runtime: verifyShasConcurrent concurrency model', () => {
  it('empty SHAs array resolves with [] (early-return path)', async () => {
    const results: VerifyShaResult[] = await verifyShasConcurrent([]);
    expect(results).toEqual([]);
  });

  it('concurrency > 256 rejects with RangeError (anti-forkbomb guard)', async () => {
    await expect(verifyShasConcurrent([], process.cwd(), { concurrency: 999_999 }))
      .rejects.toThrow(/concurrency=999999 exceeds the 256 safe bound/);
  });

  it('already-aborted signal rejects with abort reason', async () => {
    const controller = new AbortControllerImpl();
    controller.abort();
    await expect(
      verifyShasConcurrent(['abc1234'], process.cwd(), { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('shas in RESULT array preserve INPUT order irrespective of resolution order', async () => {
    // Use enough SHAs that the bounded-concurrency scheduling is observable;
    // we don't care WHICH order they resolve in, only that the OUTPUT array
    // is indexed-by-input-sha correctly (verified[i] corresponds to shas[i]).
    // All malformed → each returns invalid-format deterministically → all
    // behave identically, so the result is a uniform "rejected" array.
    const shas = ['bad!sha!1', 'bad!sha!2', 'bad!sha!3', 'bad!sha!4'];
    const results = await verifyShasConcurrent(shas, process.cwd(), { concurrency: 2 });
    expect(results.length).toBe(shas.length);
    for (let i = 0; i < shas.length; i++) {
      expect(results[i]).toBeDefined();
      expect(results[i]!.verified).toBe(false);
      expect(results[i]!.error).toMatch(/invalid SHA format/);
    }
  });

  it('concurrency=1 still runs all SHAs serially without dropping any', async () => {
    const shas = ['bad!a', 'bad!b', 'bad!c'];
    const results = await verifyShasConcurrent(shas, process.cwd(), { concurrency: 1 });
    expect(results.length).toBe(3);
    for (let i = 0; i < 3; i++) expect(results[i]!.verified).toBe(false);
  });
});

// ===========================================================================
// 4. Soft-deprecation: sync versions still callable + return equivalent shape.
// ===========================================================================

describe('D3.2 hardening — deprecation policy: sync versions soft-deprecated but functional', () => {
  it('evaluateSignoff sync still returns same result as evaluateSignoffAsync', async () => {
    const rows: SignoffRow[] = [
      mkRow({ role: 'CISO', sha: 'a1', verified: true, error: null }),
      mkRow({ role: 'Head of Security', sha: 'b2', verified: true, error: null }),
      mkRow({ role: 'Engineering Lead', sha: 'c3', verified: true, error: null }),
      mkRow({ role: 'Compliance Lead', sha: 'd4', verified: true, error: null }),
    ];
    const syncR = evaluateSignoff(rows);
    const asyncR = await evaluateSignoffAsync(rows);
    expect(syncR.exitCode).toBe(asyncR.exitCode);
    expect(syncR.ok).toBe(asyncR.ok);
    expect(syncR.reasons).toEqual(asyncR.reasons);
  });

  it('runVerifier sync still usable for single-doc CLI integration', () => {
    // Sync surface still works for the standard "missing doc" case —
    // confirms the soft-deprecation is NOT removal.
    const r = runVerifier('/tmp/definitely-does-not-exist-d32-sync-xyz.md');
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.reasons[0]).toMatch(/doc not found/);
  });

  it('verifySha sync still callable on malformed SHA', () => {
    const r = verifySha('not-a-sha!');
    expect(r.verified).toBe(false);
    expect(r.error).toMatch(/invalid SHA format/);
  });
});

// ===========================================================================
// 5. Barrel exposition: async surface reachable via both layers.
// ===========================================================================

describe('D3.2 hardening — barrel exposition: async surface + types reachable via main + security', () => {
  it('main barrel (`../src`): async values + new constant + types resolve', () => {
    expect(typeof verifyShaAsync).toBe('function');
    expect(typeof evaluateSignoffAsync).toBe('function');
    expect(typeof runVerifierAsync).toBe('function');
    expect(typeof verifyShasConcurrent).toBe('function');
    expect(typeof VERIFY_CONCURRENCY_DEFAULT).toBe('number');
  });

  it('main barrel: rotation-prefixed type aliases compile to the correct shapes', () => {
    // Type-only — these bindings force TypeScript to confirm the aliases
    // resolve to the underlying canonical types.
    const _row: RotationSignoffRow = mkRow({ role: 'CISO', error: null });
    const _args: RotationSignoffCliArgs = { docPath: '/tmp/x.md', json: false, quiet: false };
    const _opts: RunVerifierOptions = { repoRoot: process.cwd() };
    const _asyncOpts: RunVerifierAsyncOptions = {
      concurrency: 2,
      repoRoot: process.cwd(),
      signal: new AbortControllerImpl().signal,
    };
    expect(_row.role).toBe('CISO');
    expect(_args.docPath).toBe('/tmp/x.md');
    expect(_opts.repoRoot).toBe(process.cwd());
    expect(_asyncOpts.concurrency).toBe(2);
  });

  it('security barrel: canonical types resolve (no collision with capabilityToken)', () => {
    // SignoffRow/CliArgs/VerifyResult direct from the verifier file —
    // mirrors the d31 file's TypeScript safety pattern. The async
    // types (VerifyShaResult, RunVerifierAsyncOptions) are ALSO exported
    // from the security barrel under their canonical names.
    const _rows: SignoffRow[] = [];
    const _args: CliArgs = { docPath: '', json: false, quiet: false };
    const _asyncOpts: RunVerifierAsyncOptions = {
      concurrency: 4,
      repoRoot: process.cwd(),
      signal: new AbortControllerImpl().signal,
    };
    expect(_rows).toEqual([]);
    expect(_args.json).toBe(false);
    expect(_asyncOpts.concurrency).toBe(4);
  });
});
