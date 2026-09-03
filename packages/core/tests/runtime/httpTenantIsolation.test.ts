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
  return text;
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
});
