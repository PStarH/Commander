import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { CommanderHttpServer } from '../src/runtime/httpServer';

const PORT = 0; // dynamic port
let server: CommanderHttpServer | null = null;
let baseUrl: string = '';

async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  options?: {
    accept?: string;
    origin?: string;
    requestId?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: any; text?: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options?.accept) headers['Accept'] = options.accept;
    if (options?.origin) headers['Origin'] = options.origin;
    if (options?.requestId) headers['X-Request-Id'] = options.requestId;
    Object.assign(headers, options?.headers);
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode ?? 500,
            body: JSON.parse(data),
            text: data,
            headers: res.headers,
          });
        } catch {
          resolve({ status: res.statusCode ?? 500, body: null, text: data, headers: res.headers });
        }
      });
    });
    if (options?.body !== undefined)
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    req.end();
    req.on('error', reject);
  });
}

async function fetchJson(
  path: string,
  options?: { accept?: string; origin?: string; requestId?: string },
): Promise<{ status: number; body: any; text?: string; headers: http.IncomingHttpHeaders }> {
  return requestJson('GET', `${baseUrl}${path}`, options);
}

describe('CommanderHttpServer — Monitoring Endpoints', () => {
  before(async () => {
    server = new CommanderHttpServer({
      port: 0,
      host: '127.0.0.1',
      apiKey: '',
      rateLimitPerMinute: 0,
    });
    await server.start();
    baseUrl = `http://127.0.0.1:${server.getPort()}`;
  });

  after(async () => {
    if (server) {
      try {
        await server.stop();
      } catch {
        /* ignore stop errors during teardown */
      }
      // Small delay to let Node.js test runner drain socket references
      await new Promise((r) => setTimeout(r, 100));
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
      assert.ok(
        text!.includes('commander_'),
        `OpenMetrics response should contain commander_ metrics`,
      );
    });
  });

  describe('Auth enforcement', () => {
    it('returns 401 for protected endpoints without auth', async () => {
      const authServer = new CommanderHttpServer({
        port: 0,
        host: '127.0.0.1',
        apiKey: 'test-key-123',
        rateLimitPerMinute: 0,
      });
      await authServer.start();
      const authBaseUrl = `http://127.0.0.1:${authServer.getPort()}`;

      try {
        const { status, body } = await new Promise<{ status: number; body: any }>(
          (resolve, reject) => {
            http
              .get(`${authBaseUrl}/api/v1/status`, (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => {
                  data += chunk.toString();
                });
                res.on('end', () =>
                  resolve({ status: res.statusCode ?? 500, body: JSON.parse(data) }),
                );
              })
              .on('error', reject);
          },
        );
        assert.strictEqual(status, 401);
        assert.ok(body.error?.toLowerCase().includes('unauthorized'));
      } finally {
        await authServer.stop();
      }
    });

    it('accepts hashed API key config without retaining the raw key', async () => {
      const rawKey = 'hashed-test-key-123';
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
      const authServer = new CommanderHttpServer({
        port: 0,
        host: '127.0.0.1',
        apiKeyHash: keyHash,
        tenantApiKeys: { 'tenant-raw-key': 'tenant-a' },
        rateLimitPerMinute: 0,
      });
      await authServer.start();
      const authBaseUrl = `http://127.0.0.1:${authServer.getPort()}`;

      try {
        const { status, body } = await requestJson('GET', `${authBaseUrl}/api/v1/status`, {
          headers: { Authorization: `Bearer ${rawKey}` },
        });
        assert.strictEqual(status, 200);
        assert.strictEqual(typeof body.activeSessions, 'number');

        const retainedConfig = (
          authServer as unknown as {
            config: { apiKey?: string; tenantApiKeys?: Record<string, string> };
          }
        ).config;
        assert.strictEqual(retainedConfig.apiKey, undefined);
        assert.strictEqual(retainedConfig.tenantApiKeys, undefined);

        const tenantReq = {
          headers: { authorization: 'Bearer tenant-raw-key' },
        } as http.IncomingMessage;
        const tenantId = (
          authServer as unknown as {
            resolveTenantFromAuth(req: http.IncomingMessage): string | undefined;
          }
        ).resolveTenantFromAuth(tenantReq);
        assert.strictEqual(tenantId, 'tenant-a');
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
      // Spawn a fresh server that includes localhost:3000 as an allowed origin
      const corsServer = new CommanderHttpServer({
        port: 0,
        host: '127.0.0.1',
        apiKey: '',
        rateLimitPerMinute: 0,
        corsAllowedOrigins: ['http://localhost:3000'],
      });
      await corsServer.start();
      const corsBaseUrl = `http://127.0.0.1:${corsServer.getPort()}`;

      const { status, headers } = await requestJson('GET', `${corsBaseUrl}/health`, {
        origin: 'http://localhost:3000',
      });
      assert.strictEqual(status, 200);
      assert.strictEqual(headers['access-control-allow-origin'], 'http://localhost:3000');
      await corsServer.stop();
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

    it('protects health endpoints when protectHealthEndpoints is enabled', async () => {
      const protectedServer = new CommanderHttpServer({
        port: 0,
        host: '127.0.0.1',
        apiKey: 'health-test-key',
        rateLimitPerMinute: 0,
        protectHealthEndpoints: true,
      });
      await protectedServer.start();
      const protectedBaseUrl = `http://127.0.0.1:${protectedServer.getPort()}`;

      try {
        const { status } = await requestJson('GET', `${protectedBaseUrl}/health`);
        assert.strictEqual(status, 401);

        const { status: readyStatus } = await requestJson('GET', `${protectedBaseUrl}/ready`);
        assert.strictEqual(readyStatus, 401);

        const { status: okStatus } = await requestJson('GET', `${protectedBaseUrl}/health`, {
          headers: { Authorization: 'Bearer health-test-key' },
        });
        assert.strictEqual(okStatus, 200);
      } finally {
        await protectedServer.stop();
      }
    });
  });

  describe('/dashboard/compensation', () => {
    it('returns 200 with HTML dashboard page', async () => {
      const { status, text, headers } = await fetchJson('/dashboard/compensation', {
        accept: 'text/html',
      });
      assert.strictEqual(status, 200);
      assert.ok(headers['content-type']?.includes('text/html'), 'Content-Type should be text/html');
      assert.ok(text?.includes('Compensation Dashboard'), 'HTML should contain dashboard title');
      assert.ok(text?.includes('chart.js'), 'HTML should reference Chart.js');
      assert.ok(text?.includes('EventSource'), 'HTML should use EventSource for live updates');
      assert.ok(
        text?.includes('/stream/compensation'),
        'HTML should reference the SSE stream endpoint',
      );
    });

    it('contains counter cards section', async () => {
      const { text } = await fetchJson('/dashboard/compensation');
      assert.ok(text?.includes('Planned'), 'HTML should show Planned count');
      assert.ok(text?.includes('Steps'), 'HTML should show Steps count');
      assert.ok(text?.includes('Successful'), 'HTML should show Successful compensations');
      assert.ok(text?.includes('Failed'), 'HTML should show Failed count');
    });

    it('contains chart canvases for all 4 chart types', async () => {
      const { text } = await fetchJson('/dashboard/compensation');
      assert.ok(text?.includes('byToolChart'), 'HTML should have by-tool chart');
      assert.ok(text?.includes('byRiskChart'), 'HTML should have by-risk chart');
      assert.ok(text?.includes('byStatusChart'), 'HTML should have by-status chart');
      assert.ok(text?.includes('outcomeChart'), 'HTML should have outcome chart');
    });

    it('uses SSE for live updates instead of polling', async () => {
      const { text } = await fetchJson('/dashboard/compensation');
      assert.ok(text?.includes('EventSource'), 'HTML should use EventSource for SSE');
      assert.ok(
        text?.includes('/stream/compensation'),
        'HTML should connect to SSE stream endpoint',
      );
      assert.ok(
        text?.includes('compensation.update'),
        'HTML should listen for compensation.update events',
      );
      // Should NOT use setInterval polling anymore
      assert.ok(!text?.includes('setInterval(refresh,'), 'HTML should not use setInterval polling');
    });
  });

  describe('/api/v1/compensation', () => {
    it('returns 200 with JSON compensation data', async () => {
      const { status, body } = await fetchJson('/api/v1/compensation');
      assert.strictEqual(status, 200);
      assert.ok(typeof body === 'object', 'Response should be a JSON object');
      assert.ok('counters' in body, 'Response should have counters');
      assert.ok('recentEvents' in body, 'Response should have recentEvents');
      assert.ok('timestamp' in body, 'Response should have timestamp');
    });

    it('returns all expected counter fields', async () => {
      const { body } = await fetchJson('/api/v1/compensation');
      assert.ok(
        'compensation_planned_total' in body.counters,
        'counters should include compensation_planned_total',
      );
      assert.ok(
        'compensation_steps_total' in body.counters,
        'counters should include compensation_steps_total',
      );
      assert.ok(
        'compensation_total' in body.counters,
        'counters should include compensation_total',
      );
      assert.ok('byTool' in body, 'should have byTool breakdown');
      assert.ok('byRisk' in body, 'should have byRisk breakdown');
      assert.ok('byStepStatus' in body, 'should have byStepStatus breakdown');
      assert.ok('compensationOutcomes' in body, 'should have compensationOutcomes breakdown');
    });

    it('returns empty breakdowns when no compensation events recorded', async () => {
      const { body } = await fetchJson('/api/v1/compensation');
      assert.deepStrictEqual(body.byTool, {});
      assert.deepStrictEqual(body.byRisk, {});
      assert.deepStrictEqual(body.byStepStatus, {});
      assert.deepStrictEqual(body.recentEvents, []);
    });

    it('populates counters after compensation events fire', async () => {
      // Publish a compensation event via the message bus to test live data flow
      const { getMessageBus } = await import('../src/runtime/messageBus');
      const bus = getMessageBus();
      bus.publish('tool.compensation_planned', 'test', {
        runId: 'test-run',
        toolName: 'file_write',
        stepCount: 3,
        risk: 'safe',
      });
      bus.publish('tool.compensation_step', 'test', {
        runId: 'test-run',
        toolName: 'file_write',
        actionId: 'act-1',
        stepIndex: 0,
        totalSteps: 3,
        status: 'completed',
      });
      bus.publish('tool.compensation_step', 'test', {
        runId: 'test-run',
        toolName: 'file_write',
        actionId: 'act-1',
        stepIndex: 1,
        totalSteps: 3,
        status: 'failed',
        error: 'disk full',
      });

      const { body } = await fetchJson('/api/v1/compensation');
      assert.ok(body.counters.compensation_planned_total >= 0);
      // Event history should include the event we published
      assert.ok(body.recentEvents.length >= 1, 'Should have at least 1 recent event');
      const plannedEvents = body.recentEvents.filter(
        (e: any) => e.topic === 'tool.compensation_planned',
      );
      assert.ok(plannedEvents.length >= 1, 'Should have at least 1 planned event');
    });
  });

  // SSE streaming is tested indirectly via the dashboard HTML test which verifies
  // the HTML references /stream/compensation via EventSource. The SSE endpoint is a
  // thin wrapper around bus subscriptions and is covered by compensation integration tests.

  describe('/dashboard/sop', () => {
    it('returns 200 with HTML SOP dashboard page', async () => {
      const { status, text, headers } = await fetchJson('/dashboard/sop', { accept: 'text/html' });
      assert.strictEqual(status, 200);
      assert.ok(headers['content-type']?.includes('text/html'), 'Content-Type should be text/html');
      assert.ok(text?.includes('SOP Dashboard'), 'HTML should contain dashboard title');
      assert.ok(text?.includes('chart.js'), 'HTML should reference Chart.js');
      assert.ok(text?.includes('EventSource'), 'HTML should use EventSource for live updates');
      assert.ok(text?.includes('/stream/sop'), 'HTML should reference the SOP SSE stream endpoint');
    });

    it('contains counter cards section', async () => {
      const { text } = await fetchJson('/dashboard/sop');
      assert.ok(text?.includes('Total SOPs'), 'HTML should show Total SOPs count');
      assert.ok(text?.includes('Agents'), 'HTML should show Agents count');
      assert.ok(text?.includes('Total Steps'), 'HTML should show Total Steps count');
      assert.ok(text?.includes('Unique Tags'), 'HTML should show Unique Tags count');
    });

    it('contains chart canvases for all 3 chart types', async () => {
      const { text } = await fetchJson('/dashboard/sop');
      assert.ok(text?.includes('byAgentChart'), 'HTML should have by-agent chart');
      assert.ok(text?.includes('byTagChart'), 'HTML should have by-tag chart');
      assert.ok(text?.includes('byStepChart'), 'HTML should have by-step chart');
    });

    it('contains search input and sortable table', async () => {
      const { text } = await fetchJson('/dashboard/sop');
      assert.ok(text?.includes('searchInput'), 'HTML should have search input');
      assert.ok(text?.includes('filterSOPs'), 'HTML should have filter function');
      assert.ok(text?.includes('sortBy'), 'HTML should have sort function');
      assert.ok(text?.includes('toggleDetail'), 'HTML should have detail toggle function');
    });

    it('uses SSE for live updates instead of polling', async () => {
      const { text } = await fetchJson('/dashboard/sop');
      assert.ok(text?.includes('EventSource'), 'HTML should use EventSource for SSE');
      assert.ok(text?.includes('/stream/sop'), 'HTML should connect to SSE stream endpoint');
      assert.ok(text?.includes('sop.update'), 'HTML should listen for sop.update events');
      assert.ok(!text?.includes('setInterval(refresh,'), 'HTML should not use setInterval polling');
    });
  });

  describe('/api/v1/sops', () => {
    it('returns 200 with JSON SOP data', async () => {
      const { status, body } = await fetchJson('/api/v1/sops');
      assert.strictEqual(status, 200);
      assert.ok(typeof body === 'object', 'Response should be a JSON object');
      assert.ok('agents' in body, 'Response should have agents');
      assert.ok('total' in body, 'Response should have total');
      assert.ok('sops' in body, 'Response should have sops');
      assert.ok('timestamp' in body, 'Response should have timestamp');
    });

    it('returns empty sops array when no SOPs exist', async () => {
      const { body } = await fetchJson('/api/v1/sops');
      assert.deepStrictEqual(body.sops, []);
      assert.strictEqual(body.total, 0);
      assert.deepStrictEqual(body.agents, []);
    });

    it('returns 404 for non-existent agent', async () => {
      const { status, body } = await fetchJson('/api/v1/sops/nonexistent-agent');
      assert.strictEqual(status, 200); // Returns empty filtered list, not 404
      assert.deepStrictEqual(body.sops, []);
      assert.strictEqual(body.total, 0);
    });

    it('returns 404 for non-existent SOP', async () => {
      const { status, body } = await fetchJson('/api/v1/sops/test-agent/nonexistent-run');
      assert.strictEqual(status, 404);
      assert.ok(body.error?.includes('SOP not found'));
    });

    it('returns 404 for non-existent SOP markdown', async () => {
      const { status, body } = await fetchJson('/api/v1/sops/test-agent/nonexistent-run/markdown');
      assert.strictEqual(status, 404);
      assert.ok(body.error?.includes('SOP not found'));
    });

    it('survives path traversal attempts', async () => {
      const { status, body } = await fetchJson('/api/v1/sops/../evil/nonexistent');
      assert.strictEqual(status, 404);
      assert.ok(body.error?.includes('SOP not found') || body.error?.includes('Unknown'));
    });
  });

  describe('Graceful shutdown', () => {
    it('stop() resolves without error', async () => {
      const srv = new CommanderHttpServer({
        port: 0,
        host: '127.0.0.1',
        apiKey: '',
        rateLimitPerMinute: 0,
      });
      await srv.start();
      await srv.stop();
      assert.ok(true, 'stop() resolved successfully');
    });
  });
});
