import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import type { AuthPlugin } from '../../src/runtime/authPlugin';
import { CommanderHttpServer } from '../../src/runtime/httpServer';

async function request(
  method: 'GET' | 'POST',
  url: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 500, text }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(JSON.stringify(options.body));
    req.end();
  });
}

describe('embedded operations authorization', () => {
  it('requires authentication for operations reads, mutations, and the SOP dashboard', async () => {
    const server = new CommanderHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: 'ops-owner-key',
      oidcEnabled: false,
      rateLimitPerMinute: 0,
    });
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;

    try {
      for (const path of ['/slo', '/alerts', '/incidents', '/dashboard/sop']) {
        const denied = await request('GET', `${baseUrl}${path}`);
        assert.equal(denied.status, 401, `${path} must reject anonymous reads`);
      }

      const deniedMutation = await request('POST', `${baseUrl}/alerts/rules`, {
        body: { name: 'anonymous-rule' },
      });
      assert.equal(deniedMutation.status, 401);

      const authorization = { Authorization: 'Bearer ops-owner-key' };
      assert.equal(
        (await request('GET', `${baseUrl}/alerts`, { headers: authorization })).status,
        200,
      );
      const dashboard = await request('GET', `${baseUrl}/dashboard/sop`, {
        headers: authorization,
      });
      assert.equal(dashboard.status, 200);
      assert.match(dashboard.text, /SOP Dashboard/);
    } finally {
      await server.stop();
    }
  });

  it('allows viewer reads but requires an operator role for mutations', async () => {
    const rolePlugin: AuthPlugin = {
      name: 'test-role-plugin',
      async authenticate(token) {
        if (token !== 'viewer-token' && token !== 'operator-token') return null;
        return {
          userId: token,
          username: token,
          role: token === 'operator-token' ? 'operator' : 'viewer',
        };
      },
    };
    const server = new CommanderHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: 'ops-owner-key',
      oidcEnabled: false,
      rateLimitPerMinute: 0,
    });
    server.registerAuthPlugin(rolePlugin);
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;
    const rule = {
      name: 'role-gated-rule',
      description: 'security regression',
      metric: 'security_test_metric',
      condition: 'gt',
      threshold: 1,
      severity: 'warning',
      channels: [],
      forDurationMs: 0,
      autoResolveAfterMs: 5000,
      enabled: true,
    };

    try {
      const viewer = { Authorization: 'Bearer viewer-token' };
      assert.equal((await request('GET', `${baseUrl}/alerts`, { headers: viewer })).status, 200);
      assert.equal(
        (await request('POST', `${baseUrl}/alerts/rules`, { headers: viewer, body: rule })).status,
        403,
      );
      assert.equal(
        (
          await request('POST', `${baseUrl}/alerts/rules`, {
            headers: { Authorization: 'Bearer operator-token' },
            body: rule,
          })
        ).status,
        201,
      );
    } finally {
      await server.stop();
    }
  });
});
