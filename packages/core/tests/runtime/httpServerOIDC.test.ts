/**
 * Integration tests for HTTP Server OIDC Authentication Plugin.
 *
 * Tests that the OIDC auth plugin can be registered with the HTTP server
 * and the auth flow works correctly (API key → OIDC fall-through).
 *
 * Uses node:test to match existing httpServer.test.ts style.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { CommanderHttpServer } from '../../src/runtime/httpServer';
import { OIDCAuthPlugin, type JWKWithKid } from '../../src/runtime/oidcAuthPlugin';

// ── Helpers ──────────────────────────────────────────────────────────

/** Generate RSA key pair for JWT signing */
function generateTestKeys(): { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject; jwk: JWKWithKid } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubKeyObj = crypto.createPublicKey(publicKey);
  const jwk = pubKeyObj.export({ format: 'jwk' }) as JWKWithKid;
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  return { publicKey: pubKeyObj, privateKey: crypto.createPrivateKey(privateKey), jwk };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function createSignedJWT(
  payload: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  kid: string = 'test-key-1',
): string {
  const header = { alg: 'RS256', kid, typ: 'JWT' };
  const data = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const signature = crypto.sign('sha256', Buffer.from(data), privateKey);
  return `${data}.${base64url(signature)}`;
}

function validTokenPayload(): Record<string, unknown> {
  return {
    iss: 'https://test-issuer.okta.com',
    aud: 'test-client-id',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 60,
    sub: 'user-abc-123',
    email: 'test@example.com',
    roles: ['operator'],
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CommanderHttpServer — OIDC Authentication Integration', () => {
  const testKeys = generateTestKeys();
  let server: CommanderHttpServer | null = null;
  let baseUrl: string = '';

  before(async () => {
    // Create OIDC plugin with the test keys
    const oidcPlugin = new OIDCAuthPlugin({
      issuer: 'https://test-issuer.okta.com',
      clientId: 'test-client-id',
      trustedJwks: [testKeys.jwk],
      adminRoles: ['admin'],
      operatorRoles: ['operator', 'developer'],
    });

    // Create HTTP server with API key auth + OIDC plugin
    server = new CommanderHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: 'primary-api-key',
      rateLimitPerMinute: 0,
    });

    server.registerAuthPlugin(oidcPlugin);
    await server.start();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  after(async () => {
    if (server) {
      try { await server.stop(); } catch { /* ignore stop errors */ }
      await new Promise(r => setTimeout(r, 100));
      server = null;
    }
  });

  // ── API Key Auth Still Works ──────────────────────────────────────

  describe('API key auth works alongside OIDC', () => {
    it('authenticates with valid API key', async () => {
      const { status, body } = await requestJson('GET', `${baseUrl}/api/v1/status`, {
        headers: { Authorization: 'Bearer primary-api-key' },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(typeof body.activeSessions, 'number');
    });

    it('rejects invalid API key when OIDC token also not provided', async () => {
      const { status } = await requestJson('GET', `${baseUrl}/api/v1/status`);
      assert.strictEqual(status, 401);
    });

    it('rejects invalid Bearer token format', async () => {
      const { status } = await requestJson('GET', `${baseUrl}/api/v1/status`, {
        headers: { Authorization: 'Bearer definitely-not-valid' },
      });
      assert.strictEqual(status, 401);
    });
  });

  // ── OIDC Auth ─────────────────────────────────────────────────────

  describe('OIDC authentication', () => {
    it('authenticates with a valid OIDC JWT', async () => {
      const jwt = createSignedJWT(validTokenPayload(), testKeys.privateKey);
      const { status, body } = await requestJson('GET', `${baseUrl}/api/v1/status`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(typeof body.activeSessions, 'number');
    });

    it('rejects expired OIDC JWT', async () => {
      const jwt = createSignedJWT({
        ...validTokenPayload(),
        exp: Math.floor(Date.now() / 1000) - 120, // expired 2 min ago
      }, testKeys.privateKey);
      const { status } = await requestJson('GET', `${baseUrl}/api/v1/status`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      assert.strictEqual(status, 401);
    });

    it('rejects OIDC JWT with wrong issuer', async () => {
      const jwt = createSignedJWT({
        ...validTokenPayload(),
        iss: 'https://attacker.com',
      }, testKeys.privateKey);
      const { status } = await requestJson('GET', `${baseUrl}/api/v1/status`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      assert.strictEqual(status, 401);
    });

    it('rejects tampered OIDC JWT', async () => {
      const jwt = createSignedJWT(validTokenPayload(), testKeys.privateKey);
      const parts = jwt.split('.');
      const tamperedPayload = base64url(Buffer.from(JSON.stringify({ ...validTokenPayload(), role: 'admin' })));
      const tamperedJwt = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
      const { status } = await requestJson('GET', `${baseUrl}/api/v1/status`, {
        headers: { Authorization: `Bearer ${tamperedJwt}` },
      });
      assert.strictEqual(status, 401);
    });
  });

  // ── Health/Ready Bypass Auth ──────────────────────────────────────

  describe('auth bypass endpoints still work', () => {
    it('/health bypasses auth with OIDC plugin registered', async () => {
      const { status } = await requestJson('GET', `${baseUrl}/health`);
      assert.strictEqual(status, 200);
    });

    it('/ready bypasses auth with OIDC plugin registered', async () => {
      const { status } = await requestJson('GET', `${baseUrl}/ready`);
      assert.strictEqual(status, 200);
    });

    it('/openapi.json bypasses auth with OIDC plugin registered', async () => {
      const { status } = await requestJson('GET', `${baseUrl}/openapi.json`);
      assert.strictEqual(status, 200);
    });
  });
});

// ── HTTP Request Helper ──────────────────────────────────────────────

async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  options?: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    Object.assign(headers, options?.headers);
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 500, body: { error: data } });
        }
      });
    });
    if (options?.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
    req.on('error', reject);
  });
}
