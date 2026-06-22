/**
 * hardeningSprint.d1.test.ts — D1 launch gate.
 *
 * Security Hardening Sprint (docs/security/hardening-sprint.md), Day 1:
 * "Audit-chain prod-key fail-fast + git clean". Verifies that all three
 * master-key resolvers refuse to start when NODE_ENV=production and the
 * corresponding env var is missing, empty, or shorter than 32 chars.
 *
 * Doc citation: docs/security/hardening-sprint.md §3 Phase A D1 + §7 Box 2+
 * D1.In + D1.Out. The Verify command in §3 runs the production audit CLI
 * with no key set; this file pins down the per-module contract that makes
 * that command fail loudly with the documented env-var name.
 *
 * Three modules covered (one test each):
 *   1. AuditChainLedger  → COMMANDER_AUDIT_CHAIN_KEY
 *   2. CapabilityToken   → COMMANDER_CAPABILITY_TOKEN_KEY
 *   3. FederatedIdentity → COMMANDER_FEDERATION_KEY
 *
 * Each module exposes `resolveMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer`.
 * Acceptance: throws an Error whose message names the exact env var, the
 * module name in brackets `[moduleName]`, the substring "must be set",
 * and "(>= 32 chars)".
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';

import {
  AUDIT_CHAIN_KEY_ENV,
  resolveMasterKey as resolveAuditChainKey,
} from '../../src/security/auditChainLedger';
import {
  CAPABILITY_TOKEN_KEY_ENV,
  resolveMasterKey as resolveCapabilityTokenKey,
} from '../../src/security/capabilityToken';
import {
  FEDERATION_KEY_ENV,
  resolveFederationKey,
} from '../../src/security/federatedIdentity';

describe('D1 hardening sprint — production fail-fast', () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    // Snapshot caller-provided env so beforeEach/afterEach don't leak.
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    else delete process.env.NODE_ENV;
  });

  describe('AuditChainLedger.resolveMasterKey', () => {
    it('throws with documented env-var name in production when key is missing', () => {
      assert.throws(
        () =>
          resolveAuditChainKey({
            [AUDIT_CHAIN_KEY_ENV]: '',
            NODE_ENV: 'production',
          }),
        (err: Error) => {
          // Must reference the exact env var name an operator needs to set.
          assert.match(err.message, new RegExp(AUDIT_CHAIN_KEY_ENV));
          // Must tag the producing module so logs are unambiguous.
          assert.match(err.message, /\[auditChainLedger\]/);
          // Must state the failure reason a security auditor expects to see.
          assert.match(err.message, /must be set/);
          assert.match(err.message, /\(>= 32 chars\)/);
          assert.match(err.message, /production/);
          return true;
        },
      );
    });

    it('throws in production when key is present but shorter than 32 chars', () => {
      assert.throws(
        () =>
          resolveAuditChainKey({
            [AUDIT_CHAIN_KEY_ENV]: 'too-short',
            NODE_ENV: 'production',
          }),
        (err: Error) => {
          assert.match(err.message, new RegExp(AUDIT_CHAIN_KEY_ENV));
          assert.match(err.message, /\[auditChainLedger\]/);
          assert.match(err.message, /\(>= 32 chars\)/);
          return true;
        },
      );
    });

    it('falls back to dev key in non-production without raising', () => {
      const buf = resolveAuditChainKey({
        [AUDIT_CHAIN_KEY_ENV]: '',
        NODE_ENV: 'development',
      });
      assert.equal(buf.length, 32, 'dev fallback is 32 bytes (SHA-256)');
    });
  });

  describe('CapabilityTokenIssuer.resolveMasterKey', () => {
    it('throws with documented env-var name in production when key is missing', () => {
      assert.throws(
        () =>
          resolveCapabilityTokenKey({
            [CAPABILITY_TOKEN_KEY_ENV]: '',
            NODE_ENV: 'production',
          }),
        (err: Error) => {
          assert.match(err.message, new RegExp(CAPABILITY_TOKEN_KEY_ENV));
          assert.match(err.message, /\[capabilityToken\]/);
          assert.match(err.message, /must be set/);
          assert.match(err.message, /\(>= 32 chars\)/);
          assert.match(err.message, /production/);
          return true;
        },
      );
    });

    it('throws in production when key is shorter than 32 chars', () => {
      assert.throws(
        () =>
          resolveCapabilityTokenKey({
            [CAPABILITY_TOKEN_KEY_ENV]: 'short-key',
            NODE_ENV: 'production',
          }),
        (err: Error) => {
          assert.match(err.message, new RegExp(CAPABILITY_TOKEN_KEY_ENV));
          assert.match(err.message, /\[capabilityToken\]/);
          assert.match(err.message, /\(>= 32 chars\)/);
          return true;
        },
      );
    });

    it('uses an env-set key in non-production without warnings shape regression', () => {
      const fixed = 'env-key-must-be-at-least-32-characters-long-XYZX';
      const buf = resolveCapabilityTokenKey({
        [CAPABILITY_TOKEN_KEY_ENV]: fixed,
        NODE_ENV: 'development',
      });
      assert.equal(buf.length, fixed.length, 'env-set key passes through unchanged');
    });
  });

  describe('FederatedIdentity.resolveFederationKey', () => {
    it('throws with documented env-var name in production when key is missing', () => {
      assert.throws(
        () =>
          resolveFederationKey({
            [FEDERATION_KEY_ENV]: '',
            NODE_ENV: 'production',
          }),
        (err: Error) => {
          assert.match(err.message, new RegExp(FEDERATION_KEY_ENV));
          assert.match(err.message, /\[federatedIdentity\]/);
          assert.match(err.message, /must be set/);
          assert.match(err.message, /\(>= 32 chars\)/);
          assert.match(err.message, /production/);
          return true;
        },
      );
    });

    it('throws in production when key is shorter than 32 chars', () => {
      assert.throws(
        () =>
          resolveFederationKey({
            [FEDERATION_KEY_ENV]: 'tiny',
            NODE_ENV: 'production',
          }),
        (err: Error) => {
          assert.match(err.message, new RegExp(FEDERATION_KEY_ENV));
          assert.match(err.message, /\[federatedIdentity\]/);
          assert.match(err.message, /\(>= 32 chars\)/);
          return true;
        },
      );
    });

    it('falls back to dev key in non-production', () => {
      const buf = resolveFederationKey({
        [FEDERATION_KEY_ENV]: '',
        NODE_ENV: 'test',
      });
      assert.equal(buf.length, 32, 'dev fallback is 32 bytes');
    });
  });
});
