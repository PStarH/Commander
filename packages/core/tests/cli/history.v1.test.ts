/**
 * CLI history ↔ GET /v1/runs integration (L3-05 closeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as configResolver from '../../src/config/configResolver';
import {
  cmdHistory,
  fetchV1Runs,
  GatewayListRunsError,
  resolveGatewayApiBase,
  resolveGatewayApiKey,
} from '../../src/cli/commands/history';

let server: Server | null = null;
let baseUrl = '';
let stdout = '';
let stderr = '';
type MockMode = 'ok' | 'unauthorized' | 'non_json' | 'missing_runs';
let mockMode: MockMode = 'ok';

beforeEach(async () => {
  stdout = '';
  stderr = '';
  mockMode = 'ok';
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout += `${args.join(' ')}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr += `${args.join(' ')}\n`;
  });

  const seenHeaders: string[] = [];
  server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/runs')) {
      seenHeaders.push(String(req.headers['x-api-key'] ?? ''));
      (server as Server & { __seenApiKeys?: string[] }).__seenApiKeys = seenHeaders;
      if (mockMode === 'unauthorized') {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }));
        return;
      }
      if (mockMode === 'non_json') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('not-json');
        return;
      }
      if (mockMode === 'missing_runs') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          runs: [
            {
              id: 'run-api-1',
              state: 'SUCCEEDED',
              tenantId: 'tenant-a',
              createdAt: '2026-07-19T01:00:00.000Z',
              updatedAt: '2026-07-19T02:00:00.000Z',
            },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.COMMANDER_API_URL;
  delete process.env.COMMANDER_API_KEY;
  configResolver.resetConfigResolver();
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = null;
  }
});

describe('commander history API mode', () => {
  it('uses COMMANDER_API_URL for the default list path and sends x-api-key', async () => {
    process.env.COMMANDER_API_URL = baseUrl;
    process.env.COMMANDER_API_KEY = 'test-gateway-key';
    expect(resolveGatewayApiBase()).toBe(baseUrl);

    await cmdHistory([]);
    expect(stdout).toContain('RUN HISTORY (/v1)');
    expect(stdout).toContain('run-api-1');
    expect(stdout).toContain('SUCCEEDED');
    expect(stdout).toContain('/v1/runs (durable kernel authority)');
    const keys = (server as Server & { __seenApiKeys?: string[] }).__seenApiKeys ?? [];
    expect(keys).toContain('test-gateway-key');
  });

  it('local SKU path advertises non-/v1 authority', async () => {
    delete process.env.COMMANDER_API_URL;
    await cmdHistory([]);
    expect(stdout).toContain('SESSION HISTORY');
    expect(stdout).toContain('not durable /v1 authority');
    expect(stdout).not.toContain('RUN HISTORY (/v1)');
  });

  it('ignores LLM-style file config apiBase/apiKey (not Gateway credentials)', async () => {
    delete process.env.COMMANDER_API_URL;
    delete process.env.COMMANDER_API_KEY;
    vi.spyOn(configResolver, 'getConfigResolver').mockReturnValue({
      getFileConfig: () => ({
        apiBase: baseUrl,
        apiKey: 'llm-provider-secret',
      }),
      resolve: () => ({} as never),
      reload: () => {},
      detectAvailableProviders: () => [],
    } as never);

    expect(resolveGatewayApiBase()).toBeNull();
    expect(resolveGatewayApiKey()).toBeUndefined();
    await cmdHistory([]);
    expect(stdout).toContain('SESSION HISTORY');
    expect(stdout).toContain('not durable /v1 authority');
    expect(stdout).not.toContain('RUN HISTORY (/v1)');
    const keys = (server as Server & { __seenApiKeys?: string[] }).__seenApiKeys ?? [];
    expect(keys).not.toContain('llm-provider-secret');
  });

  it('keeps view/delete/prune on local StateCheckpointer even in API mode', async () => {
    process.env.COMMANDER_API_URL = baseUrl;
    await cmdHistory(['view', 'missing-run']);
    expect(stdout).not.toContain('RUN HISTORY (/v1)');
    expect(stderr).toContain('Session not found');
  });

  it('surfaces 401 with API-key hint instead of local .commander advice', async () => {
    mockMode = 'unauthorized';
    process.env.COMMANDER_API_URL = baseUrl;
    await cmdHistory([]);
    expect(stderr).toContain('Gateway list runs failed (401)');
    expect(stderr).toContain('COMMANDER_API_KEY');
    expect(stderr).not.toContain('.commander/ directory');
  });

  it('rejects non-JSON and missing runs[] with GatewayListRunsError', async () => {
    mockMode = 'non_json';
    await expect(fetchV1Runs(baseUrl)).rejects.toBeInstanceOf(GatewayListRunsError);
    mockMode = 'missing_runs';
    await expect(fetchV1Runs(baseUrl)).rejects.toMatchObject({
      name: 'GatewayListRunsError',
      kind: 'invalid_json',
    });
  });

  it('maps network failures to GatewayListRunsError', async () => {
    await expect(fetchV1Runs('http://127.0.0.1:1')).rejects.toMatchObject({
      name: 'GatewayListRunsError',
      kind: 'network',
    });
  });
});
