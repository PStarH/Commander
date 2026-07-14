/**
 * Policy Bundle Rollback / Downgrade Attack Tests
 *
 * This suite covers attack vectors that the basic m4-security-closure tests
 * do not exercise:
 *
 *  a) Rollback / downgrade attack — a run pinned to a restrictive v2 bundle
 *     must never resolve to a permissive v1 bundle.
 *  b) Key rotation — after rotating the signing key, bundles signed with the
 *     old key must be rejected on retrieval.
 *  c) Cryptographically-valid-but-stale replay — an attacker possesses a
 *     validly-signed older bundle, but pinning prevents downgrade.
 *  d) Cross-tenant pin forgery — tenant-B cannot resolve a run pinned by
 *     tenant-A.
 *  e) Decision log replay after revocation — the audit trail preserves both
 *     the original allow and the subsequent deny, with deny being current.
 *  f) Pin expiry / unpin — unpinning and re-pinning to a new version works.
 */

import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';

import {
  SignedPolicyBundleManager,
  SignedPolicyBundleError,
  resetSignedPolicyBundleManager,
  type PolicyBundlePayload,
} from '../../src/security/signedPolicyBundle';

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** A simple allow/deny rule set used throughout the tests. */
interface ToolRuleSet {
  allow: string[];
  deny: string[];
}

const KEY_1 = 'k1'.repeat(32); // 64 chars — satisfies the >= 32 requirement
const KEY_2 = 'k2'.repeat(32);
const KEY_ID_1 = 'key-1';
const KEY_ID_2 = 'key-2';

/** Permissive rules — allows shell_execute. */
const PERMISSIVE_RULES: ToolRuleSet = {
  allow: ['shell_execute', 'file_read', 'file_write'],
  deny: [],
};

/** Restrictive rules — denies shell_execute. */
const RESTRICTIVE_RULES: ToolRuleSet = {
  allow: ['file_read', 'file_write'],
  deny: ['shell_execute'],
};

function makePayload(
  version: number,
  rules: ToolRuleSet,
  snapshotId?: string,
): PolicyBundlePayload {
  return {
    name: 'default',
    version,
    snapshotId: snapshotId ?? `ps_v${version}`,
    effectDefaults: { allow: false, requireApproval: false },
    rules,
    schemaVersion: '1.0',
    publishedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('SignedPolicyBundle — rollback / downgrade attack defense', () => {
  let manager: SignedPolicyBundleManager;

  beforeEach(() => {
    manager = new SignedPolicyBundleManager({
      signingKey: KEY_1,
      keyId: KEY_ID_1,
    });
  });

  afterEach(() => {
    resetSignedPolicyBundleManager();
  });

  // ── (a) Rollback / downgrade attack ──────────────────────────────────

  it('run pinned to restrictive v2 cannot be downgraded to permissive v1', () => {
    // Publish v1 — permissive (allows shell_execute)
    manager.publish(makePayload(1, PERMISSIVE_RULES, 'ps_v1'));

    // Publish v2 — restrictive (denies shell_execute)
    manager.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_v2'));

    // Pin the run to the restrictive v2 snapshot
    manager.pin('run-rollback', 'tenant-a', 'ps_v2');

    // Attacker attempts a rollback: resolve the run hoping for the permissive v1
    const resolved = manager.resolveForRun('run-rollback');

    // Must resolve to v2 (restrictive), NOT v1 (permissive)
    assert.equal(resolved.version, 2, 'should resolve to pinned v2, not v1');
    assert.equal(resolved.snapshotId, 'ps_v2');

    // Verify the resolved bundle denies shell_execute
    const rules = resolved.rules as ToolRuleSet;
    assert.ok(rules.deny.includes('shell_execute'), 'v2 rules must deny shell_execute');
    assert.ok(!rules.allow.includes('shell_execute'), 'v2 rules must NOT allow shell_execute');
  });

  // ── (b) Key rotation — old key rejected after rotation ──────────────

  it('rejects bundle signed with old key after key rotation', () => {
    // Publish v1 with key-1
    manager.publish(makePayload(1, PERMISSIVE_RULES, 'ps_v1_kr'));

    // Rotate to key-2
    manager.setActiveKey(KEY_2, KEY_ID_2);

    // Publish v2 with key-2
    manager.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_v2_kr'));

    // Retrieving v1 (signed with old key-1) must fail
    assert.throws(
      () => manager.retrieve('ps_v1_kr'),
      (err: SignedPolicyBundleError) =>
        err.code === 'KEY_MISMATCH' || err.code === 'SIGNATURE_INVALID',
      'v1 signed with old key should be rejected after rotation',
    );

    // Retrieving v2 (signed with new key-2) must succeed
    const v2 = manager.retrieve('ps_v2_kr');
    assert.equal(v2.version, 2);
    assert.equal(v2.keyId, KEY_ID_2);
  });

  // ── (c) Cryptographically-valid-but-stale bundle replay ─────────────

  it('pinning prevents replay of a validly-signed stale bundle', () => {
    // Publish v1 (permissive) and v2 (restrictive) with the same key
    manager.publish(makePayload(1, PERMISSIVE_RULES, 'ps_v1_replay'));
    manager.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_v2_replay'));

    // Pin the run to v2
    manager.pin('run-replay', 'tenant-a', 'ps_v2_replay');

    // The v1 bundle is validly signed — an attacker might try to swap it in.
    // But resolveForRun uses the pin, which points to v2's snapshotId.
    // Even though v1 is in the store and cryptographically valid, the pin
    // ensures v2 is returned.
    const v1Bundle = manager.retrieve('ps_v1_replay');
    assert.equal(v1Bundle.version, 1, 'v1 should be retrievable and valid');

    const resolved = manager.resolveForRun('run-replay');
    assert.equal(resolved.version, 2, 'pinned run must resolve to v2, not v1');
    assert.equal(resolved.snapshotId, 'ps_v2_replay');

    // Confirm the resolved bundle is restrictive
    const rules = resolved.rules as ToolRuleSet;
    assert.ok(rules.deny.includes('shell_execute'));
  });

  // ── (d) Cross-tenant pin forgery ─────────────────────────────────────

  it('denies cross-tenant access to a pinned run', () => {
    // Tenant-A publishes and pins a bundle
    manager.publish(makePayload(1, RESTRICTIVE_RULES, 'ps_v1_xtenant'));
    manager.pin('run-xtenant', 'tenant-a', 'ps_v1_xtenant');

    // Tenant-B attempts to resolve tenant-A's run — must fail
    assert.throws(
      () => manager.resolveForRun('run-xtenant', 'tenant-b'),
      (err: SignedPolicyBundleError) => err.code === 'TENANT_MISMATCH',
      'tenant-B must not resolve tenant-A pinned run',
    );

    // Tenant-A can still resolve its own run
    const resolved = manager.resolveForRun('run-xtenant', 'tenant-a');
    assert.equal(resolved.snapshotId, 'ps_v1_xtenant');
  });

  // ── (e) Decision log replay after revocation ────────────────────────

  it('decision log preserves both allow and subsequent revocation in order', async () => {
    // Publish v1 and log an "allow" decision
    manager.publish(makePayload(1, PERMISSIVE_RULES, 'ps_v1_log'));
    manager.pin('run-log', 'tenant-a', 'ps_v1_log');

    await manager.logDecision({
      decisionId: 'pd_allow_1',
      tenantId: 'tenant-a',
      runId: 'run-log',
      stepId: 'step-1',
      effect: 'allow',
      reason: 'v1 rule allows shell_execute',
      snapshotId: 'ps_v1_log',
      packVersion: 1,
      riskScore: 10,
      latencyMs: 2,
    });

    // Publish v2 that revokes the previous decision (denies shell_execute)
    manager.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_v2_log'));

    await manager.logDecision({
      decisionId: 'pd_deny_2',
      tenantId: 'tenant-a',
      runId: 'run-log',
      stepId: 'step-2',
      effect: 'deny',
      reason: 'v2 revokes shell_execute',
      snapshotId: 'ps_v2_log',
      packVersion: 2,
      riskScore: 80,
      latencyMs: 3,
    });

    // Query the decision log — both entries should be present in order
    const decisions = await manager.queryDecisions({ runId: 'run-log' });
    assert.equal(decisions.length, 2, 'should have both decision log entries');

    // First entry: the original allow
    assert.equal(decisions[0].effect, 'allow');
    assert.equal(decisions[0].snapshotId, 'ps_v1_log');
    assert.equal(decisions[0].packVersion, 1);

    // Second entry: the revocation deny
    assert.equal(decisions[1].effect, 'deny');
    assert.equal(decisions[1].snapshotId, 'ps_v2_log');
    assert.equal(decisions[1].packVersion, 2);

    // The current effective decision is the latest (deny), not the original allow
    const current = decisions[decisions.length - 1];
    assert.equal(current.effect, 'deny', 'current effective decision must be deny (v2 revocation)');
  });

  // ── (f) Pin expiry / unpin ──────────────────────────────────────────

  it('unpin and re-pin to a new version resolves the new version', () => {
    // Publish v1 and v2
    manager.publish(makePayload(1, PERMISSIVE_RULES, 'ps_v1_unpin'));
    manager.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_v2_unpin'));

    // Pin to v1
    manager.pin('run-unpin', 'tenant-a', 'ps_v1_unpin');
    let resolved = manager.resolveForRun('run-unpin');
    assert.equal(resolved.version, 1, 'initially pinned to v1');

    // Unpin the run (simulates pin expiry or run completion)
    manager.unpin('run-unpin');
    assert.equal(manager.getPin('run-unpin'), null, 'run should be unpinned');

    // After unpinning, resolveForRun falls back to latest (v2)
    resolved = manager.resolveForRun('run-unpin');
    assert.equal(resolved.version, 2, 'unpinned run falls back to latest v2');

    // Re-pin to v2 explicitly
    manager.pin('run-unpin', 'tenant-a', 'ps_v2_unpin');
    resolved = manager.resolveForRun('run-unpin');
    assert.equal(resolved.version, 2, 're-pinned to v2');
    assert.equal(resolved.snapshotId, 'ps_v2_unpin');

    // Verify the re-pinned bundle is restrictive
    const rules = resolved.rules as ToolRuleSet;
    assert.ok(rules.deny.includes('shell_execute'));
  });
});

// ──────────────────────────────────────────────────────────────────────────
// MCP-13: asymmetric (Ed25519) signing
// ──────────────────────────────────────────────────────────────────────────

describe('SignedPolicyBundle — Ed25519 asymmetric signing (MCP-13)', () => {
  function ed25519Pems(): { privateKeyPem: string; publicKeyPem: string } {
    const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  }

  it('a verify-only replica (public key only) accepts a bundle signed by the private-key signer', () => {
    const { privateKeyPem, publicKeyPem } = ed25519Pems();
    const signer = new SignedPolicyBundleManager({
      algorithm: 'ed25519',
      ed25519PrivateKeyPem: privateKeyPem,
      keyId: 'ed-key-1',
    });
    const verifier = new SignedPolicyBundleManager({
      algorithm: 'ed25519',
      ed25519PublicKeyPem: publicKeyPem,
      keyId: 'ed-key-1',
    });

    const bundle = signer.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_ed_ok'));
    assert.equal(bundle.algorithm, 'ed25519');
    // Verifier holds no signing secret, yet verification succeeds.
    verifier.verifyAndLoad(bundle);
    // The public verification key is exportable for distribution.
    assert.ok(verifier.getPublicKeyPem()?.includes('BEGIN PUBLIC KEY'));
  });

  it('rejects a tampered payload under Ed25519', () => {
    const { privateKeyPem, publicKeyPem } = ed25519Pems();
    const signer = new SignedPolicyBundleManager({
      algorithm: 'ed25519',
      ed25519PrivateKeyPem: privateKeyPem,
      keyId: 'ed-key-1',
    });
    const verifier = new SignedPolicyBundleManager({
      algorithm: 'ed25519',
      ed25519PublicKeyPem: publicKeyPem,
      keyId: 'ed-key-1',
    });
    const bundle = signer.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_ed_tamper'));
    // Flip a policy field after signing.
    const tampered = { ...bundle, rules: PERMISSIVE_RULES };
    assert.throws(
      () => verifier.verifyAndLoad(tampered),
      (e: unknown) =>
        e instanceof SignedPolicyBundleError && e.code === 'SIGNATURE_INVALID',
    );
  });

  it('a wrong public key does not verify', () => {
    const signerKeys = ed25519Pems();
    const otherKeys = ed25519Pems();
    const signer = new SignedPolicyBundleManager({
      algorithm: 'ed25519',
      ed25519PrivateKeyPem: signerKeys.privateKeyPem,
      keyId: 'ed-key-1',
    });
    const wrongVerifier = new SignedPolicyBundleManager({
      algorithm: 'ed25519',
      ed25519PublicKeyPem: otherKeys.publicKeyPem,
      keyId: 'ed-key-1',
    });
    const bundle = signer.publish(makePayload(2, RESTRICTIVE_RULES, 'ps_ed_wrongkey'));
    assert.throws(
      () => wrongVerifier.verifyAndLoad(bundle),
      (e: unknown) =>
        e instanceof SignedPolicyBundleError && e.code === 'SIGNATURE_INVALID',
    );
  });

  it('HMAC mode never exposes a public key', () => {
    const hmac = new SignedPolicyBundleManager({ signingKey: KEY_1, keyId: KEY_ID_1 });
    assert.equal(hmac.getAlgorithm(), 'hmac-sha256');
    assert.equal(hmac.getPublicKeyPem(), null);
  });
});
