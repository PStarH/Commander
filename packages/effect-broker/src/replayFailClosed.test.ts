/**
 * AUDIT-F2: replay protection must fail closed on nonce-less capability
 * grants in production profiles. Before the fix the consume() was gated on
 * `grant.nonce` being present, so a correctly-signed nonce-less grant could
 * be replayed unlimited times until expiry.
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';

const envSnap: Record<string, string | undefined> = {};
for (const k of [
  'NODE_ENV',
  'COMMANDER_ENV',
  'COMMANDER_PROFILE',
  'COMMANDER_CELL_TIER',
  'COMMANDER_REQUIRE_WORKLOAD_BINDING',
]) {
  envSnap[k] = process.env[k];
}
afterEach(() => {
  for (const [k, v] of Object.entries(envSnap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function prodEnv() {
  delete process.env.NODE_ENV;
  process.env.COMMANDER_ENV = 'production';
}

function devEnv() {
  delete process.env.NODE_ENV;
  delete process.env.COMMANDER_ENV;
  delete process.env.COMMANDER_PROFILE;
  delete process.env.COMMANDER_CELL_TIER;
  delete process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING;
}

const { EffectBroker, EffectBrokerError, CapabilityTokenVerifier } = await import('./index.js');
// Type-only import: erased at compile time, so it does not load the module
// before the env mutations above.
import type { EffectBrokerOptions, EffectKernelPort, EffectExecutor, AuditSink } from './index.js';

const ISSUER = 'commander.test';
const AUDIENCE = 'commander.test.worker';
const KEY_ID = 'k1';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Mint a grant directly (bypassing CapabilityTokenIssuer.issue(), which always
 * defaults a nonce) so the nonce-less case can actually be constructed.
 */
function signGrant(grant: Record<string, unknown>, privateKey: KeyObject): string {
  const header = { alg: 'EdDSA', typ: 'CAP', kid: KEY_ID };
  const signingInput = `${encode(header)}.${encode(grant)}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

function makeGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    jti: randomUUID(),
    tenantId: 'tenant-a',
    runId: 'run-1',
    stepId: 'step-1',
    effectTypes: ['http.request'],
    issuer: ISSUER,
    audience: AUDIENCE,
    keyId: KEY_ID,
    issuedAt: new Date(now - 1_000).toISOString(),
    notBefore: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    ...overrides,
  };
}

function makeVerifier(replay?: { consume(key: string, expiresAt: string): boolean }): {
  verifier: InstanceType<typeof CapabilityTokenVerifier>;
  privateKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    verifier: new CapabilityTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      publicKeys: new Map([[KEY_ID, publicKey]]),
      ...(replay ? { replay } : {}),
    }),
  };
}

describe('capability grant replay protection (AUDIT-F2)', () => {
  test('rejects a signed nonce-less grant in the production profile', async () => {
    prodEnv();
    const { verifier, privateKey } = makeVerifier();
    const token = signGrant(makeGrant({ nonce: undefined }), privateKey);

    // Guard the fixture: the payload really carries no nonce.
    assert.equal(decodePayload(token).nonce, undefined);

    await assert.rejects(
      () => verifier.verify(token),
      /replay nonce required in production profile/,
      'a nonce-less grant must be rejected outright in production',
    );
  });

  test('accepts the same nonce-less grant outside the production profile', async () => {
    devEnv();
    const { verifier, privateKey } = makeVerifier();
    const grant = makeGrant({ nonce: undefined });
    const token = signGrant(grant, privateKey);

    const verified = await verifier.verify(token);
    assert.equal(verified.jti, grant.jti, 'non-production keeps the legacy permissive path');
  });

  test('rejects a replayed nonce', async () => {
    devEnv();
    const consumed = new Set<string>();
    const { verifier, privateKey } = makeVerifier({
      consume(key) {
        if (consumed.has(key)) return true;
        consumed.add(key);
        return false;
      },
    });
    const grant = makeGrant({ nonce: 'nonce-1' });
    const token = signGrant(grant, privateKey);

    const first = await verifier.verify(token);
    assert.equal(first.jti, grant.jti);
    assert.deepEqual(
      [...consumed],
      [`${grant.jti}:nonce-1`],
      'the replay marker must be keyed on jti + nonce',
    );

    await assert.rejects(() => verifier.verify(token), /replayed/);
  });
});

describe('production profile detection (AUDIT-F3)', () => {
  /**
   * The production gate is a constructor precondition, so it is observed by
   * constructing with the real positional signature and asserting the exact
   * error code. The previous version passed one bogus object cast `as never`
   * and matched a four-way permissive regex, so it stayed green for several
   * failure modes that have nothing to do with production detection.
   */
  function expectConstructCode(options: EffectBrokerOptions, code: string): void {
    prodEnv();
    const { publicKey } = generateKeyPairSync('ed25519');
    const tokens = new CapabilityTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      publicKeys: new Map([[KEY_ID, publicKey]]),
    });
    // The ports below are never reached: the production precondition throws in
    // the constructor before any of them is touched.
    assert.throws(
      () =>
        new EffectBroker(
          tokens,
          {
            evaluate: async () => ({
              effect: 'deny',
              decisionId: 'unused',
              reason: 'unused',
              policySnapshotId: 'unused',
            }),
          },
          {} as unknown as EffectKernelPort,
          {} as unknown as EffectExecutor,
          {} as unknown as AuditSink,
          options,
        ),
      (err: unknown) => err instanceof EffectBrokerError && err.code === code,
      `expected ${code}`,
    );
  }

  test('COMMANDER_ENV=production forces worker affinity (baseline hole: broker treated it as dev)', () => {
    expectConstructCode({}, 'WORKER_AFFINITY_REQUIRED_IN_PROD');
  });

  test('COMMANDER_ENV=production refuses request binding disabled', () => {
    expectConstructCode({ requireRequestBinding: false }, 'REQUEST_BINDING_DISABLED_IN_PROD');
  });
});
