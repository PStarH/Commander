import { describe, it, beforeAll as before, afterAll as after } from 'vitest';
import assert from 'node:assert';
import * as http from 'node:http';
import { CommanderHttpServer } from '../src/runtime/httpServer';

const PORT = 0; // dynamic port
let server: CommanderHttpServer | null = null;
let baseUrl: string = '';

async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  options?: { accept?: string; origin?: string; requestId?: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; body: any; text?: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options?.accept) headers['Accept'] = options.accept;
    if (options?.origin) headers['Origin'] = options.origin;
    if (options?.requestId) headers['X-Request-Id'] = options.requestId;
    Object.assign(headers, options?.headers);
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 500, body: JSON.parse(data), text: data, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode ?? 500, body: null, text: data, headers: res.headers });
        }
      });
    });
    if (options?.body !== undefined) req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
    req.on('error', reject);
  });
}

async function fetchJson(path: string, options?: { accept?: string; origin?: string; requestId?: string }): Promise<{ status: number; body: any; text?: string; headers: http.IncomingHttpHeaders }> {
  return requestJson('GET', `${baseUrl}${path}`, options);
}

describe('CommanderHttpServer — Monitoring Endpoints', () => {
  before(async () => {
    server = new CommanderHttpServer({ port: 0, host: '127.0.0.1', apiKey: '', rateLimitPerMinute: 0 });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  after(async () => {
    if (server) {
      try { await server.stop(); } catch { /* ignore stop errors during teardown */ }
      // Small delay to let Node.js test runner drain socket references
      await new Promise(r => setTimeout(r, 100));
      server = null;
    }
  });

  describe('/health', () => {
    it('returns 200 with uptime and session info', async () => {
      const { status, body } = await fetchJson('/health');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.status, 'ok');
      assert.ok(typeof body.uptime === 'number');
      assert.ok(typeof body.timestamp === 'string');
    });

    it('bypasses authentication', async () => {
      const { status } = await fetchJson('/health');
      assert.strictEqual(status, 200);
    });

    it('returns a request id header and preserves incoming request id', async () => {
      const { status, headers } = await fetchJson('/health', { requestId: 'req-test-123' });
      assert.strictEqual(status, 200);
      assert.strictEqual(headers['x-request-id'], 'req-test-123');
    });
  });

  describe('/ready', () => {
    it('returns 200 with ready status', async () => {
      const { status, body } = await fetchJson('/ready');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.status, 'ready');
      assert.ok(typeof body.uptime === 'number');
      assert.ok(typeof body.memory?.rss === 'number');
    });

    it('is unauthenticated', async () => {
      const { status } = await fetchJson('/ready');
      assert.strictEqual(status, 200);
    });
  });

  describe('/openapi.json', () => {
    it('returns 200 with valid OpenAPI spec', async () => {
      const { status, body } = await fetchJson('/openapi.json');
      assert.strictEqual(status, 200);
      assert.strictEqual(body.openapi, '3.0.3');
      assert.ok(body.info);
      assert.strictEqual(body.info.version, '0.2.0');
      assert.ok(body.paths);
      assert.ok(body.paths['/health']);
      assert.ok(body.paths['/ready']);
      assert.ok(body.paths['/metrics']);
    });

    it('is unauthenticated', async () => {
      const { status } = await fetchJson('/openapi.json');
      assert.strictEqual(status, 200);
    });
  });

  describe('/metrics', () => {
    it('returns 200 with JSON metrics', async () => {
      const { status, body } = await fetchJson('/metrics');
      assert.strictEqual(status, 200);
      assert.ok(typeof body.uptime === 'number');
      assert.ok(body.timestamp);
    });

    it('returns OpenMetrics text format when Accept: text/plain', async () => {
      const { status, text } = await fetchJson('/metrics', { accept: 'text/plain' });
      assert.strictEqual(status, 200);
      assert.ok(text, 'Response body should not be empty');
      assert.ok(text!.includes('commander_'), `OpenMetrics response should contain commander_ metrics`);
    });
  });

  describe('Auth enforcement', () => {
    it('returns 401 for protected endpoints without auth', async () => {
      const authServer = new CommanderHttpServer({ port: 0, host: '127.0.0.1', apiKey: 'test-key-123', rateLimitPerMinute: 0 });
      await authServer.start();
      const authBaseUrl = `http://127.0.0.1:${authServer.getPort()}`;

      try {
        const { status, body } = await new Promise<{ status: number; body: any }>((resolve, reject) => {
          http.get(`${authBaseUrl}/api/v1/status`, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) }));
          }).on('error', reject);
        });
        assert.strictEqual(status, 401);
        assert.ok(body.error?.toLowerCase().includes('unauthorized'));
      } finally {
        await authServer.stop();
      }
    });
  });

  describe('HTTP hardening', () => {
    it('does not emit wildcard CORS by default', async () => {
      const { status, headers } = await fetchJson('/health', { origin: 'https://evil.example' });
      assert.strictEqual(status, 200);
      assert.notStrictEqual(headers['access-control-allow-origin'], '*');
      assert.strictEqual(headers['access-control-allow-origin'], undefined);
    });

    it('allows configured CORS origins', async () => {
      const { status, headers } = await fetchJson('/health', { origin: 'http://localhost:3000' });
      assert.strictEqual(status, 200);
      assert.strictEqual(headers['access-control-allow-origin'], 'http://localhost:3000');
    });

    it('rejects oversized JSON request bodies', async () => {
      const smallServer = new CommanderHttpServer({
        port: 0,
        host: '127.0.0.1',
        apiKey: '',
        rateLimitPerMinute: 0,
        maxBodyBytes: 32,
      });
      await smallServer.start();
      const smallBaseUrl = `http://127.0.0.1:${smallServer.getPort()}`;

      try {
        const { status, body } = await requestJson('POST', `${smallBaseUrl}/api/v1/runtime`, {
          body: { sessionId: 'x'.repeat(128) },
        });
        assert.strictEqual(status, 413);
        assert.ok(body.error.includes('Request body too large'));
      } finally {
        await smallServer.stop();
      }
    });
  });

  describe('Graceful shutdown', () => {
    it('stop() resolves without error', async () => {
      const srv = new CommanderHttpServer({ port: 0, host: '127.0.0.1', apiKey: '', rateLimitPerMinute: 0 });
      await srv.start();
      await srv.stop();
      assert.ok(true, 'stop() resolved successfully');
    });
  });
});
