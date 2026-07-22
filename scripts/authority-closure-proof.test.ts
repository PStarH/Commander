import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalJson,
  ed25519Material,
  finalizeResult,
  mergeJwksJson,
  resolveOwnerDsn,
  sha256Hex,
  type AuthorityProofFlags,
} from './authority-closure-proof.js';

const allTrueFlags = (): AuthorityProofFlags => ({
  database: {
    rlsEnabled: true,
    rolesSeparated: true,
    workerDirectInsertRejected: true,
    workerDirectUpdateRejected: true,
    workerCrossTenantRegisterRejected: true,
    peerClaimWithoutSecretRejected: true,
    workerIdentityTakeoverRejected: true,
    workerRevocationDeleteRejected: true,
    claimExecuteRequiresSecret: true,
    workerOutsideAllowlistWriteRejected: true,
  },
  effect: { policyBound: true, actionDigestBound: true, actionDigestRequired: true, fenced: true },
  capability: {
    replayRejected: true,
    revocationObserved: true,
    rotationObserved: true,
    enterpriseRefusesGenerate: true,
  },
});

describe('authority-closure-proof helpers', () => {
  it('resolveOwnerDsn prefers OWNER_DSN over kernel and DATABASE_URL', () => {
    assert.equal(
      resolveOwnerDsn({
        OWNER_DSN: 'postgres://owner:o@127.0.0.1:5433/commander',
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel:k@127.0.0.1:5433/commander',
        DATABASE_URL: 'postgres://db:d@127.0.0.1:5433/commander',
      }),
      'postgres://owner:o@127.0.0.1:5433/commander',
    );
  });

  it('resolveOwnerDsn falls back to COMMANDER_KERNEL_DATABASE_URL then DATABASE_URL then default', () => {
    assert.equal(
      resolveOwnerDsn({
        COMMANDER_KERNEL_DATABASE_URL: 'postgres://kernel:k@127.0.0.1:5433/commander',
        DATABASE_URL: 'postgres://db:d@127.0.0.1:5433/commander',
      }),
      'postgres://kernel:k@127.0.0.1:5433/commander',
    );
    assert.equal(
      resolveOwnerDsn({ DATABASE_URL: 'postgres://db:d@127.0.0.1:5433/commander' }),
      'postgres://db:d@127.0.0.1:5433/commander',
    );
    assert.equal(
      resolveOwnerDsn({}),
      'postgres://commander:commander@127.0.0.1:5433/commander',
    );
  });

  it('canonicalJson sorts object keys stably', () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('sha256Hex is deterministic', () => {
    assert.equal(
      sha256Hex('hello'),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('finalizeResult is PROVEN only when every flag is true and failures empty', () => {
    const proven = finalizeResult({
      gitSha: 'abc123',
      flags: allTrueFlags(),
      failures: [],
      checkedAt: '2026-07-21T00:00:00.000Z',
    });
    assert.equal(proven.passed, true);
    assert.equal(proven.evidenceLevel, 'PROVEN');
    assert.deepEqual(proven.failures, []);
  });

  it('finalizeResult fail-closes on any false flag', () => {
    const flags = allTrueFlags();
    flags.effect.fenced = false;
    const failed = finalizeResult({
      gitSha: 'abc123',
      flags,
      failures: [],
      checkedAt: '2026-07-21T00:00:00.000Z',
    });
    assert.equal(failed.passed, false);
    assert.equal(failed.evidenceLevel, 'FAILED');
    assert.ok(failed.failures.some((f) => f.includes('effect.fenced')));
  });

  it('finalizeResult fail-closes on unknown gitSha', () => {
    const failed = finalizeResult({
      gitSha: 'unknown',
      flags: allTrueFlags(),
      failures: [],
    });
    assert.equal(failed.passed, false);
    assert.equal(failed.evidenceLevel, 'FAILED');
    assert.ok(failed.failures.some((f) => /gitSha/i.test(f)));
  });

  it('finalizeResult fail-closes when failures already present', () => {
    const failed = finalizeResult({
      gitSha: 'abc123',
      flags: allTrueFlags(),
      failures: ['connect refused'],
    });
    assert.equal(failed.passed, false);
    assert.equal(failed.evidenceLevel, 'FAILED');
    assert.deepEqual(failed.failures, ['connect refused']);
  });

  it('mergeJwksJson builds dual JWKS with both kids for rotation proofs', () => {
    const a = ed25519Material('a');
    const b = ed25519Material('b');
    const dual = JSON.parse(mergeJwksJson(a, b)) as { keys: Array<{ kid: string; x: string }> };
    assert.equal(dual.keys.length, 2);
    const kids = dual.keys.map((k) => k.kid).sort();
    assert.deepEqual(kids, ['a', 'b']);
    assert.equal(dual.keys.find((k) => k.kid === 'a')?.x, a.publicJwk.x);
    assert.equal(dual.keys.find((k) => k.kid === 'b')?.x, b.publicJwk.x);
  });
});
