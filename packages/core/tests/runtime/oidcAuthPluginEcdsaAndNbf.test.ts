/**
 * Regression for IP-04 / IP-05 (oidcAuthPlugin):
 *
 * IP-04 — the plugin advertised ES256/384/512 support, but verified ECDSA
 *   signatures with Node's default DER encoding while JWS (RFC 7518 §3.4)
 *   carries fixed-length R||S, so every legitimate ES* token was rejected.
 *   The declared alg is now also bound to the key type/curve.
 *
 * IP-05 — the "not-before" check read `iat` and never `nbf`, and NumericDate
 *   claims were only cast, never validated, so a string exp/iat/nbf satisfied
 *   arithmetic comparisons.
 *
 * The existing vitest suite never had an ES* case despite its header claiming
 * to cover one, which is why the defect survived.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { OIDCAuthPlugin, type JWKWithKid } from '../../src/runtime/oidcAuthPlugin';

const ISSUER = 'https://test-issuer.okta.com';
const CLIENT_ID = 'test-client-id';

function ecKey(kid: string, curve: 'P-256' | 'P-384' | 'P-521') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: curve });
  const jwk = publicKey.export({ format: 'jwk' }) as JWKWithKid;
  jwk.kid = kid;
  return { publicKey, privateKey, jwk };
}

function rsaKey(kid: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JWKWithKid;
  jwk.kid = kid;
  return { publicKey, privateKey, jwk };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    exp: nowSeconds() + 3600,
    iat: nowSeconds() - 60,
    sub: 'user-abc-123',
    email: 'test@example.com',
    roles: ['operator'],
    ...overrides,
  };
}

/** Sign a real JWS: ECDSA uses ieee-p1363 (R||S), exactly as an IdP emits it. */
function signJwt(
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  alg: string,
  kid: string,
): string {
  const headerStr = base64url(Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })));
  const payloadStr = base64url(Buffer.from(JSON.stringify(payload)));
  const data = `${headerStr}.${payloadStr}`;
  const hash = `sha${alg.slice(2)}`;
  const signature = alg.startsWith('ES')
    ? crypto.sign(hash, Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    : crypto.sign(hash, Buffer.from(data), privateKey);
  return `${data}.${base64url(signature)}`;
}

function pluginFor(jwks: JWKWithKid[], allowedAlgorithms?: string[]): OIDCAuthPlugin {
  return new OIDCAuthPlugin({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    trustedJwks: jwks,
    jwksCacheTtlMs: 5000,
    allowedAlgorithms,
  });
}

describe('OIDCAuthPlugin — ECDSA (ES*) verification', () => {
  for (const [alg, curve] of [
    ['ES256', 'P-256'],
    ['ES384', 'P-384'],
    ['ES512', 'P-521'],
  ] as const) {
    it(`accepts a real ${alg} JWS signed over ${curve}`, async () => {
      const key = ecKey(`ec-${alg}`, curve);
      const jwt = signJwt(basePayload(), key.privateKey, alg, key.jwk.kid!);
      const result = await pluginFor([key.jwk]).authenticate(jwt);
      assert.notEqual(result, null, `${alg} JWS must verify`);
      assert.equal(result!.userId, 'user-abc-123');
    });
  }

  it('rejects an ES256 header whose key uses a different curve', async () => {
    const key = ecKey('ec-p384', 'P-384');
    const jwt = signJwt(basePayload(), key.privateKey, 'ES256', key.jwk.kid!);
    const result = await pluginFor([key.jwk]).authenticate(jwt);
    assert.equal(result, null, 'a P-384 key must not satisfy an ES256 header');
  });

  it('still accepts a valid RS256 JWT', async () => {
    const key = rsaKey('rsa-1');
    const jwt = signJwt(basePayload(), key.privateKey, 'RS256', key.jwk.kid!);
    const result = await pluginFor([key.jwk]).authenticate(jwt);
    assert.notEqual(result, null);
  });

  it('rejects an RS256 header presented with an EC key', async () => {
    const key = ecKey('ec-1', 'P-256');
    const jwt = signJwt(basePayload(), key.privateKey, 'RS256', key.jwk.kid!);
    const result = await pluginFor([key.jwk]).authenticate(jwt);
    assert.equal(result, null);
  });
});

describe('OIDCAuthPlugin — nbf and NumericDate validation', () => {
  it('rejects a signed token whose nbf is in the future', async () => {
    const key = rsaKey('rsa-nbf');
    const jwt = signJwt(
      basePayload({ nbf: nowSeconds() + 8000 }),
      key.privateKey,
      'RS256',
      key.jwk.kid!,
    );
    const result = await pluginFor([key.jwk]).authenticate(jwt);
    assert.equal(result, null, 'a token that is not yet valid must be rejected');
  });

  it('accepts nbf inside the clock-skew window', async () => {
    const key = rsaKey('rsa-nbf-ok');
    const jwt = signJwt(
      basePayload({ nbf: nowSeconds() - 5 }),
      key.privateKey,
      'RS256',
      key.jwk.kid!,
    );
    const result = await pluginFor([key.jwk]).authenticate(jwt);
    assert.notEqual(result, null);
  });

  it('rejects a non-numeric exp string', async () => {
    const key = rsaKey('rsa-exp-str');
    const jwt = signJwt(
      basePayload({ exp: String(nowSeconds() + 3600) }),
      key.privateKey,
      'RS256',
      key.jwk.kid!,
    );
    const result = await pluginFor([key.jwk]).authenticate(jwt);
    assert.equal(result, null, 'a string exp must not pass an arithmetic comparison');
  });

  it('rejects a non-numeric nbf string', async () => {
    const key = rsaKey('rsa-nbf-str');
    const jwt = signJwt(
      basePayload({ nbf: String(nowSeconds() + 8000) }),
      key.privateKey,
      'RS256',
      key.jwk.kid!,
    );
    const result = await pluginFor([key.jwk]).authenticate(jwt);
    assert.equal(result, null);
  });
});
