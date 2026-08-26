/**
 * JWT hygiene regression tests — issuer/audience/key-id claims (WS3 §4.2).
 *
 * Verifies that tokens minted by the API carry a type-appropriate `aud` and a
 * stable `iss`/`kid`, that tokens signed for a foreign issuer or audience are
 * rejected at verification, and that legacy tokens (no iss/aud) still verify
 * so a rolling upgrade does not lock out existing sessions.
 *
 * JWT_SECRET must be set before importing jwtMiddleware (captured at module
 * load), mirroring refreshTokenRotation.test.ts.
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const originalJwt = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-jwt-secret-for-jwt-hygiene';

const { signAccessToken, signRefreshToken, verifyToken, JWT_SECRET } =
  await import('../src/jwtMiddleware');

const user = {
  id: 'user-hygiene-1',
  username: 'hygiene-user',
  role: 'viewer' as const,
};

after(() => {
  if (originalJwt === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalJwt;
  }
});

/** Sign a token with the same secret as the module, but arbitrary claims. */
function signManual(payload: object, options: jwt.SignOptions = {}): string {
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', ...options });
}

test('signAccessToken embeds issuer, access audience and key id', () => {
  const token = signAccessToken(user);
  const decoded = jwt.decode(token, { complete: true });
  assert.ok(decoded, 'token should decode');
  const payload = decoded!.payload as jwt.JwtPayload;
  assert.equal(payload.type, 'access');
  assert.equal(payload.iss, 'commander');
  assert.equal(payload.aud, 'commander-api');
  assert.equal(decoded!.header.kid, 'commander-hs256-v1');
});

test('signRefreshToken embeds the refresh audience', () => {
  const token = signRefreshToken(user);
  const decoded = jwt.decode(token) as jwt.JwtPayload;
  assert.equal(decoded.type, 'refresh');
  assert.equal(decoded.iss, 'commander');
  assert.equal(decoded.aud, 'commander-refresh');
  assert.ok(decoded.jti, 'refresh token carries a jti');
});

test('verifyToken accepts a well-formed access token', () => {
  const token = signAccessToken(user);
  const decoded = verifyToken(token);
  assert.ok(decoded, 'should verify');
  assert.equal(decoded!.type, 'access');
});

test('verifyToken rejects a token signed for a foreign issuer', () => {
  const token = signManual(
    { id: user.id, username: user.username, role: user.role, type: 'access' },
    { issuer: 'attacker', audience: 'commander-api' },
  );
  assert.equal(verifyToken(token), null);
});

test('verifyToken rejects an access token carrying the refresh audience', () => {
  const token = signManual(
    { id: user.id, username: user.username, role: user.role, type: 'access' },
    { issuer: 'commander', audience: 'commander-refresh' },
  );
  assert.equal(verifyToken(token), null);
});

test('verifyToken rejects a refresh token carrying the access audience', () => {
  const token = signManual(
    { id: user.id, username: user.username, role: user.role, type: 'refresh', jti: 'j-1' },
    { issuer: 'commander', audience: 'commander-api' },
  );
  assert.equal(verifyToken(token), null);
});

test('verifyToken accepts a legacy token without iss/aud claims', () => {
  const token = signManual({
    id: user.id,
    username: user.username,
    role: user.role,
    type: 'access',
  });
  const decoded = verifyToken(token);
  assert.ok(decoded, 'legacy token should still verify');
  assert.equal(decoded!.type, 'access');
});
