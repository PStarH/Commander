/**
 * Tests for Streaming SSE Server — gated, per-chunk delivery.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  StreamingSSEServer,
  createGate,
  makeTextSSEChunks,
  makeToolCallSSEChunks,
  type SSEChunk,
} from './streamingSSE';

describe('StreamingSSEServer', () => {
  let server: StreamingSSEServer;

  beforeEach(async () => {
    server = new StreamingSSEServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── Basic streaming ───────────────────────────────────────────────────────

  describe('basic streaming', () => {
    it('streams text content as SSE events', async () => {
      server.enqueueResponse({
        chunks: [
          { data: { choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }] } },
          { data: { choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] } },
          { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
        ],
      });

      const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

      const text = await res.text();
      assert.ok(text.includes('Hello '));
      assert.ok(text.includes('world'));
      assert.ok(text.includes('[DONE]'));
    });

    it('streams tool call chunks', async () => {
      server.enqueueToolCallChunks([{ id: 'call_1', name: 'web_search', arguments: '{"q":"AI"}' }]);

      const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'search' }],
          stream: true,
        }),
      });

      const text = await res.text();
      assert.ok(text.includes('web_search'));
      assert.ok(text.includes('call_1'));
      assert.ok(text.includes('tool_calls'));
    });
  });

  // ── Gated delivery ────────────────────────────────────────────────────────

  describe('gated delivery', () => {
    it('waits for gate before sending chunk', async () => {
      const gate1 = createGate();
      const gate2 = createGate();

      server.enqueueResponse({
        chunks: [
          { data: { content: 'first' }, gate: gate1.promise },
          { data: { content: 'second' }, gate: gate2.promise },
          { data: { content: 'done' } },
        ],
      });

      // Start the request (don't await yet)
      const resPromise = fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });

      // Small delay to let the request start
      await new Promise((r) => setTimeout(r, 50));

      // Resolve gates sequentially
      gate1.resolve();
      await new Promise((r) => setTimeout(r, 50));
      gate2.resolve();

      const res = await resPromise;
      const text = await res.text();

      // Both chunks should be present
      assert.ok(text.includes('first'));
      assert.ok(text.includes('second'));
      assert.ok(text.includes('done'));
    });

    it('tracks active streams', async () => {
      const gate = createGate();

      server.enqueueResponse({
        chunks: [{ data: { content: 'waiting' }, gate: gate.promise }],
      });

      assert.strictEqual(server.activeStreams, 0);

      const resPromise = fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });

      // Wait a bit for the stream to start
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(server.activeStreams, 1);

      gate.resolve();
      await resPromise;

      // Wait for stream to finish
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(server.activeStreams, 0);
    });

    it('supports waitForAllStreams', async () => {
      const gate = createGate();

      server.enqueueResponse({
        chunks: [{ data: { content: 'slow' }, gate: gate.promise }],
      });

      fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });

      await new Promise((r) => setTimeout(r, 50));

      // Resolve after a delay
      setTimeout(() => gate.resolve(), 100);

      // Should wait for the stream to complete
      await server.waitForAllStreams(2000);
      assert.strictEqual(server.activeStreams, 0);
    });
  });

  // ── Request capture ───────────────────────────────────────────────────────

  describe('request capture', () => {
    it('captures requests', async () => {
      server.enqueueResponse({ chunks: [{ data: { content: 'ok' } }] });

      await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
        }),
      });

      const reqs = server.getRequests();
      assert.strictEqual(reqs.length, 1);
      assert.strictEqual(reqs[0].body.model, 'gpt-4');
    });

    it('lastRequest returns most recent', async () => {
      server.enqueueResponse({ chunks: [{ data: { content: 'ok' } }] });
      server.enqueueResponse({ chunks: [{ data: { content: 'ok' } }] });

      await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm1',
          messages: [{ role: 'user', content: 'first' }],
          stream: true,
        }),
      });

      await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'm2',
          messages: [{ role: 'user', content: 'second' }],
          stream: true,
        }),
      });

      assert.strictEqual(server.lastRequest()?.body.model, 'm2');
    });
  });

  // ── Delay simulation ──────────────────────────────────────────────────────

  describe('delay simulation', () => {
    it('applies per-chunk delay', async () => {
      const start = Date.now();

      server.enqueueResponse({
        chunks: [
          { data: { content: 'fast' }, delayMs: 10 },
          { data: { content: 'slow' }, delayMs: 50 },
          { data: { content: 'done' } },
        ],
      });

      const res = await fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });

      await res.text();
      const elapsed = Date.now() - start;

      // Should take at least 60ms (10 + 50)
      assert.ok(elapsed >= 50, `Expected >= 50ms, got ${elapsed}ms`);
    });
  });

  // ── Models endpoint ───────────────────────────────────────────────────────

  describe('models endpoint', () => {
    it('handles /v1/models', async () => {
      const res = await fetch(`${server.baseUrl}/v1/models`);
      assert.strictEqual(res.status, 200);

      const data = await res.json();
      assert.ok(data.data);
      assert.ok(data.data.length > 0);
    });
  });
});

// ── createGate ──────────────────────────────────────────────────────────────

describe('createGate', () => {
  it('creates a resolvable gate', async () => {
    const gate = createGate();
    let resolved = false;

    gate.promise.then(() => {
      resolved = true;
    });

    assert.strictEqual(resolved, false);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(resolved, true);
  });

  it('creates a rejectable gate', async () => {
    const gate = createGate();
    let error: Error | null = null;

    gate.promise.catch((err) => {
      error = err;
    });

    gate.reject(new Error('test error'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(error);
    assert.strictEqual(error!.message, 'test error');
  });
});

// ── Helper functions ────────────────────────────────────────────────────────

describe('SSE chunk helpers', () => {
  describe('makeTextSSEChunks', () => {
    it('creates text chunks with stop', () => {
      const chunks = makeTextSSEChunks('Hello world');
      assert.ok(chunks.length >= 3); // 2 words + stop
      assert.ok(chunks.some((c) => (c.data as any).choices?.[0]?.finish_reason === 'stop'));
    });

    it('splits content into words', () => {
      const chunks = makeTextSSEChunks('one two three');
      const contentChunks = chunks.filter((c) => (c.data as any).choices?.[0]?.delta?.content);
      assert.strictEqual(contentChunks.length, 3);
    });
  });

  describe('makeToolCallSSEChunks', () => {
    it('creates tool call chunks', () => {
      const chunks = makeToolCallSSEChunks([{ id: 'call_1', name: 'web_search', arguments: '{}' }]);

      assert.ok(chunks.length >= 2); // 1 tool call + finish
      const toolChunk = chunks[0];
      const delta = (toolChunk.data as any).choices[0].delta;
      assert.ok(delta.tool_calls);
      assert.strictEqual(delta.tool_calls[0].function.name, 'web_search');
    });

    it('finishes with tool_calls reason', () => {
      const chunks = makeToolCallSSEChunks([{ id: 'call_1', name: 'test', arguments: '{}' }]);

      const finishChunk = chunks[chunks.length - 1];
      assert.strictEqual((finishChunk.data as any).choices[0].finish_reason, 'tool_calls');
    });
  });
});
