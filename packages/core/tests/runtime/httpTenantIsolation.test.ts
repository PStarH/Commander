import assert from 'node:assert/strict';
import * as http from 'node:http';
import { describe, it } from 'node:test';
import { getCurrentTenantId } from '../../src/runtime/tenantContext';
import { CommanderHttpServer } from '../../src/runtime/httpServer';
import type { Tool } from '../../src/runtime/types';

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

function request(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  key: string,
  body?: unknown,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            parsed = null;
          }
          resolve({ status: response.statusCode ?? 500, body: parsed, text });
        });
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.end(JSON.stringify(body));
    else request.end();
  });
}

function objectBody(result: HttpResult): Record<string, unknown> {
  assert.equal(typeof result.body, 'object');
  assert.notEqual(result.body, null);
  return result.body as Record<string, unknown>;
}

function textContent(result: HttpResult): string {
  const body = objectBody(result);
  const content = body.result;
  assert.equal(typeof content, 'object');
  assert.notEqual(content, null);
  const items = (content as Record<string, unknown>).content;
  assert.ok(Array.isArray(items));
  const text = (items[0] as Record<string, unknown> | undefined)?.text;
  assert.equal(typeof text, 'string');
  return text as string;
}

describe('HTTP tenant-only authentication and isolation', () => {
  it('scopes monitoring, runtime, SSE, and MCP requests to the bearer tenant key', async () => {
    const server = new CommanderHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: 'owner-only-key',
      tenantApiKeys: {
        'tenant-a-key': 'tenant-a',
        'tenant-b-key': 'tenant-b',
      },
      oidcEnabled: false,
      rateLimitPerMinute: 0,
    });
    const tenantProbe: Tool = {
      definition: {
        name: 'tenant_probe',
        description: 'Return the tenant bound to the current request.',
        inputSchema: { type: 'object', properties: {} },
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      riskLevel: 'low',
      execute: async () => JSON.stringify({ tenantId: getCurrentTenantId() }),
    };
    server.registerMCPServer(
      'tenant-isolation-test',
      new Map([[tenantProbe.definition.name, tenantProbe]]),
    );
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;

    try {
      for (const path of [
        '/api/v1/status',
        '/api/v1/bus',
        '/api/v1/compensation',
        '/api/v1/sops',
      ]) {
        const response = await request('GET', `${baseUrl}${path}`, 'tenant-a-key');
        assert.equal(response.status, 200, path);
      }

      const sessionA = await request('POST', `${baseUrl}/api/v1/runtime`, 'tenant-a-key', {
        sessionId: 'tenant-a-session',
        provider: 'ollama',
      });
      const sessionB = await request('POST', `${baseUrl}/api/v1/runtime`, 'tenant-b-key', {
        sessionId: 'tenant-b-session',
        provider: 'ollama',
      });
      assert.equal(sessionA.status, 201);
      assert.equal(sessionB.status, 201);

      const statusA = objectBody(await request('GET', `${baseUrl}/api/v1/status`, 'tenant-a-key'));
      const statusB = objectBody(await request('GET', `${baseUrl}/api/v1/status`, 'tenant-b-key'));
      assert.equal(statusA.activeSessions, 1);
      assert.equal(statusB.activeSessions, 1);

      for (const path of ['/api/v1/runtime/tenant-a-session', '/api/v1/stream/tenant-a-session']) {
        const response = await request('GET', `${baseUrl}${path}`, 'tenant-b-key');
        assert.equal(response.status, 403, path);
        assert.match(response.text, /Cross-tenant access denied/);
      }
      const deniedDelete = await request(
        'DELETE',
        `${baseUrl}/api/v1/runtime/tenant-a-session`,
        'tenant-b-key',
      );
      assert.equal(deniedDelete.status, 403);

      const initialize = await request('POST', `${baseUrl}/api/v1/mcp`, 'tenant-a-key', {
        jsonrpc: '2.0',
        id: 'initialize-a',
        method: 'initialize',
      });
      assert.equal(initialize.status, 200);
      const mcpA = await request('POST', `${baseUrl}/api/v1/mcp`, 'tenant-a-key', {
        jsonrpc: '2.0',
        id: 'call-a',
        method: 'tools/call',
        params: { name: 'tenant_probe', arguments: {} },
      });
      const mcpB = await request('POST', `${baseUrl}/api/v1/mcp`, 'tenant-b-key', {
        jsonrpc: '2.0',
        id: 'call-b',
        method: 'tools/call',
        params: { name: 'tenant_probe', arguments: {} },
      });
      assert.deepEqual(JSON.parse(textContent(mcpA)), { tenantId: 'tenant-a' });
      assert.deepEqual(JSON.parse(textContent(mcpB)), { tenantId: 'tenant-b' });

      const deletedA = await request(
        'DELETE',
        `${baseUrl}/api/v1/runtime/tenant-a-session`,
        'tenant-a-key',
      );
      assert.equal(deletedA.status, 200);
    } finally {
      await server.stop();
    }
  });

  // EH-01: session creation used to `runtimes.set(id, …)` unconditionally
  // after resolving the *caller's* tenant, so tenant B could replace tenant A's
  // runtime by guessing the id. Creation now refuses a duplicate id.
  it('refuses to let another tenant replace an existing runtime session', async () => {
    const server = new CommanderHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: 'owner-only-key',
      tenantApiKeys: {
        'tenant-a-key': 'tenant-a',
        'tenant-b-key': 'tenant-b',
      },
      oidcEnabled: false,
      rateLimitPerMinute: 0,
    });
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;

    try {
      const created = await request('POST', `${baseUrl}/api/v1/runtime`, 'tenant-a-key', {
        sessionId: 'contested-session',
        provider: 'ollama',
      });
      assert.equal(created.status, 201);

      const hijack = await request('POST', `${baseUrl}/api/v1/runtime`, 'tenant-b-key', {
        sessionId: 'contested-session',
        provider: 'ollama',
      });
      assert.equal(hijack.status, 409);

      // The owner is refused identically, so the status code is not an
      // ownership oracle.
      const ownerDuplicate = await request('POST', `${baseUrl}/api/v1/runtime`, 'tenant-a-key', {
        sessionId: 'contested-session',
        provider: 'ollama',
      });
      assert.equal(ownerDuplicate.status, 409);

      // Tenant A still owns the original session; tenant B still cannot reach it.
      const ownerRead = await request(
        'GET',
        `${baseUrl}/api/v1/runtime/contested-session`,
        'tenant-a-key',
      );
      assert.equal(ownerRead.status, 200);
      const crossTenantRead = await request(
        'GET',
        `${baseUrl}/api/v1/runtime/contested-session`,
        'tenant-b-key',
      );
      assert.equal(crossTenantRead.status, 403);
    } finally {
      await server.stop();
    }
  });

  it('generates an unguessable session id when the caller omits one', async () => {
    const server = new CommanderHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: 'owner-only-key',
      tenantApiKeys: { 'tenant-a-key': 'tenant-a' },
      oidcEnabled: false,
      rateLimitPerMinute: 0,
    });
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.getPort()}`;

    try {
      const first = await request('POST', `${baseUrl}/api/v1/runtime`, 'tenant-a-key', {
        provider: 'ollama',
      });
      const second = await request('POST', `${baseUrl}/api/v1/runtime`, 'tenant-a-key', {
        provider: 'ollama',
      });
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);

      const firstId = objectBody(first).sessionId;
      const secondId = objectBody(second).sessionId;
      assert.equal(typeof firstId, 'string');
      assert.notEqual(firstId, secondId);
      // `session_<Date.now()>` was guessable and collision-prone.
      assert.match(
        String(firstId),
        /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      await server.stop();
    }
  });
});
