import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { A2AClient, A2ARpcError } from '../src/mcp/a2aClient';
import {
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
} from '../src/mcp/a2aCompliance';
import type { A2AAgentCard } from '../src/mcp/a2aCompliance';

describe('A2AClient', () => {
  it('throws A2ARpcError on JSON-RPC error response', async () => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32001, message: 'Task not found' },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const client = new A2AClient(`http://127.0.0.1:${port}`);
    try {
      await client.getTask('nonexistent');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof A2ARpcError);
      assert.strictEqual((err as A2ARpcError).code, -32001);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('throws on non-200 HTTP response', async () => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const client = new A2AClient(`http://127.0.0.1:${port}`);
    try {
      await client.getAgentCard();
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes('500'));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches Agent Card from well-known endpoint', async () => {
    const expectedCard: A2AAgentCard = {
      name: 'RemoteAgent',
      description: 'Remote test agent',
      version: '1.0.0',
      supportedInterfaces: [
        { url: 'http://127.0.0.1:0', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      capabilities: {},
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(req.url === AGENT_CARD_WELL_KNOWN_PATH ? 200 : 404, {
        'Content-Type': 'application/json',
      });
      res.end(req.url === AGENT_CARD_WELL_KNOWN_PATH ? JSON.stringify(expectedCard) : 'Not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const client = new A2AClient(`http://127.0.0.1:${port}`);
    const card = await client.getAgentCard();
    assert.strictEqual(card.name, 'RemoteAgent');
    assert.strictEqual(card.version, '1.0.0');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('constructs proper JSON-RPC request for sendMessage', async () => {
    let capturedBody = '';
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const client = new A2AClient(`http://127.0.0.1:${port}`);
    await client.sendMessage({
      messageId: 'msg-1',
      role: 'user',
      parts: [{ type: 'text', text: 'Do something' }],
    });

    const sent = JSON.parse(capturedBody);
    assert.strictEqual(sent.jsonrpc, '2.0');
    assert.strictEqual(sent.method, 'message/send');
    assert.strictEqual(sent.params.message.parts[0].text, 'Do something');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends A2A-Version header', async () => {
    let capturedVersion = '';
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      capturedVersion = (req.headers[A2A_VERSION_HEADER.toLowerCase()] as string) ?? '';
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const client = new A2AClient(`http://127.0.0.1:${port}`);
    await client.getAgentCard();
    assert.strictEqual(capturedVersion, A2A_PROTOCOL_VERSION);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends Bearer auth token when configured', async () => {
    let capturedAuth = '';
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      capturedAuth = req.headers.authorization ?? '';
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const client = new A2AClient(`http://127.0.0.1:${port}`, 'my-secret-token');
    await client.getAgentCard();
    assert.strictEqual(capturedAuth, 'Bearer my-secret-token');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('times out on slow responses', async () => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      }, 2000);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;

    const client = new A2AClient(`http://127.0.0.1:${port}`, undefined, 100);
    const start = Date.now();
    try {
      await client.getAgentCard();
      assert.fail('Should have timed out');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(Date.now() - start < 3000, 'Should timeout before the 2s server delay');
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
