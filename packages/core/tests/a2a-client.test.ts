/**
 * A2AClient — outbound A2A protocol client behaviour.
 *
 * Contract note (why this file uses a public hostname and a stubbed transport)
 * ---------------------------------------------------------------------------
 * `A2AClient` enforces two constructor-time invariants:
 *   1. the base URL must be `http(s)` and must not resolve to a private /
 *      internal / metadata address (`isSafeA2AUrl`), and
 *   2. an `authToken` of at least 16 characters is mandatory.
 *
 * A test that points the client at `http://127.0.0.1:<port>` therefore cannot
 * construct a client at all. That is the intended security posture, not a bug.
 * These tests use a public-looking hostname so construction succeeds, and then
 * route the transport to a loopback server by replacing
 * `policy.ssrfCheckedFetch` with a shim that forwards to the captured native
 * `fetch`. The production guard is never weakened — the shim lives only in the
 * test process, and the last two cases assert the guard itself still fires.
 *
 * The previous revision of this file constructed `A2AClient` with a loopback
 * URL and no/short token. Every case failed at construction *before* reaching
 * its `server.close()`, so the listening socket leaked and the whole
 * `node:test` suite hung. Servers are now registered centrally and closed in
 * `afterEach`, and the constructor throws are asserted rather than avoided.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { A2AClient, A2ARpcError } from '../src/mcp/a2aClient';
import {
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
} from '../src/mcp/a2aCompliance';
import type { A2AAgentCard } from '../src/mcp/a2aCompliance';
import {
  getOutboundNetworkPolicy,
  resetOutboundNetworkPolicy,
} from '../src/security/outboundNetworkPolicy';

/** Public-looking hostname: passes `isSafeA2AUrl`, never actually resolved. */
const PUBLIC_BASE = 'https://a2a-client-test.invalid';
/** Must be >= 16 characters or the constructor rejects it. */
const AUTH_TOKEN = 'test-a2a-token-0123456789abcdef';

const originalFetch = globalThis.fetch;

const activeServers = new Set<Server>();

interface Harness {
  port: number;
  /** Resolves when the server has closed and its sockets are torn down. */
  close: () => Promise<void>;
}

/**
 * Start a loopback server, register it for teardown, and point the outbound
 * policy's transport at it. The recorded port is threaded into the shim so
 * path/query and `init` (method, headers, body, abort signal) are preserved.
 */
async function startHarness(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Harness> {
  const server = createServer(handler);
  activeServers.add(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server failed to listen on an ephemeral TCP port');
  }
  const port = address.port;

  const policy = getOutboundNetworkPolicy();
  policy.ssrfCheckedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const requested = new URL(
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
    );
    return originalFetch(`http://127.0.0.1:${port}${requested.pathname}${requested.search}`, init);
  }) as typeof policy.ssrfCheckedFetch;

  return {
    port,
    close: async () => {
      // Destroy keep-alive sockets first: `server.close()` alone waits for them
      // and would reintroduce the open-handle hang this file previously caused.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      activeServers.delete(server);
    },
  };
}

afterEach(async () => {
  resetOutboundNetworkPolicy();
  for (const server of [...activeServers]) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    activeServers.delete(server);
  }
});

function makeClient(port: number, timeoutMs?: number): A2AClient {
  void port;
  return new A2AClient(PUBLIC_BASE, AUTH_TOKEN, timeoutMs);
}

describe('A2AClient', () => {
  it('rejects a private/internal base URL at construction', () => {
    for (const url of [
      'http://127.0.0.1:8080',
      'http://127.1.2.3:8080',
      'http://localhost:8080',
      'http://localhost.:8080',
      'http://api.localhost:8080',
      'http://10.0.0.5:8080',
      'http://192.168.1.10:8080',
      'http://172.16.0.9:8080',
      'http://169.254.169.254',
      'http://0.0.0.0:8080',
      'http://[::1]:8080',
      'http://[::ffff:127.0.0.1]:8080',
      'http://metadata.google.internal',
      'ftp://public.example.test',
    ]) {
      assert.throws(
        () => new A2AClient(url, AUTH_TOKEN),
        /must not point to private\/internal IP ranges/,
        `expected ${url} to be rejected`,
      );
    }
  });

  it('requires an auth token of at least 16 characters', () => {
    assert.throws(
      () => new A2AClient(PUBLIC_BASE, ''),
      /requires an authToken of at least 16 characters/,
    );
    assert.throws(
      () => new A2AClient(PUBLIC_BASE, 'my-secret-token'),
      /requires an authToken of at least 16 characters/,
    );
    // Exactly 16 characters is accepted.
    assert.doesNotThrow(() => new A2AClient(PUBLIC_BASE, 'a'.repeat(16)));
  });

  it('throws A2ARpcError on JSON-RPC error response', async () => {
    const harness = await startHarness((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32001, message: 'Task not found' },
        }),
      );
    });

    try {
      const client = makeClient(harness.port);
      await assert.rejects(
        () => client.getTask('nonexistent'),
        (err: unknown) => {
          assert.ok(err instanceof A2ARpcError);
          assert.strictEqual((err as A2ARpcError).code, -32001);
          return true;
        },
      );
    } finally {
      await harness.close();
    }
  });

  it('throws on non-200 HTTP response', async () => {
    const harness = await startHarness((_req, res) => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });

    try {
      const client = makeClient(harness.port);
      await assert.rejects(
        () => client.getAgentCard(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok((err as Error).message.includes('500'));
          return true;
        },
      );
    } finally {
      await harness.close();
    }
  });

  it('fetches Agent Card from well-known endpoint', async () => {
    const expectedCard: A2AAgentCard = {
      name: 'RemoteAgent',
      description: 'Remote test agent',
      version: '1.0.0',
      supportedInterfaces: [
        { url: 'https://remote.example.test', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      capabilities: {},
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    };

    let requestedPath: string | undefined;
    const harness = await startHarness((req, res) => {
      requestedPath = req.url;
      const matched = req.url === AGENT_CARD_WELL_KNOWN_PATH;
      res.writeHead(matched ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(matched ? JSON.stringify(expectedCard) : 'Not found');
    });

    try {
      const client = makeClient(harness.port);
      const card = await client.getAgentCard();
      assert.strictEqual(requestedPath, AGENT_CARD_WELL_KNOWN_PATH);
      assert.strictEqual(card.name, 'RemoteAgent');
      assert.strictEqual(card.version, '1.0.0');
    } finally {
      await harness.close();
    }
  });

  it('constructs proper JSON-RPC request for sendMessage', async () => {
    let capturedBody = '';
    const harness = await startHarness((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        capturedBody = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              id: 'a2a_test_1',
              contextId: 'ctx_1',
              status: { state: 'SUBMITTED', timestamp: new Date().toISOString() },
            },
          }),
        );
      });
    });

    try {
      const client = makeClient(harness.port);
      await client.sendMessage({
        messageId: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Do something' }],
      });

      const sent = JSON.parse(capturedBody);
      assert.strictEqual(sent.jsonrpc, '2.0');
      assert.strictEqual(sent.method, 'message/send');
      assert.strictEqual(sent.params.message.parts[0].text, 'Do something');
    } finally {
      await harness.close();
    }
  });

  it('sends A2A-Version header', async () => {
    let capturedVersion = '';
    const harness = await startHarness((req, res) => {
      capturedVersion = (req.headers[A2A_VERSION_HEADER.toLowerCase()] as string) ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });

    try {
      const client = makeClient(harness.port);
      await client.getAgentCard();
      assert.strictEqual(capturedVersion, A2A_PROTOCOL_VERSION);
    } finally {
      await harness.close();
    }
  });

  it('sends Bearer auth token when configured', async () => {
    let capturedAuth = '';
    const harness = await startHarness((req, res) => {
      capturedAuth = req.headers.authorization ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });

    try {
      const client = makeClient(harness.port);
      await client.getAgentCard();
      assert.strictEqual(capturedAuth, `Bearer ${AUTH_TOKEN}`);
    } finally {
      await harness.close();
    }
  });

  it('times out on slow responses', async () => {
    const harness = await startHarness((_req, res) => {
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      }, 2000).unref();
    });

    try {
      const client = makeClient(harness.port, 100);
      const start = Date.now();
      await assert.rejects(
        () => client.getAgentCard(),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        },
      );
      assert.ok(Date.now() - start < 3000, 'Should timeout before the 2s server delay');
    } finally {
      await harness.close();
    }
  });
});
