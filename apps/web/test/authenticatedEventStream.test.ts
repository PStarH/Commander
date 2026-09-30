import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openAuthenticatedEventStream } from '../src/lib/authenticatedEventStream';

describe('authenticated event stream', () => {
  it('uses the Bearer header and parses SSE without putting credentials in the URL', async () => {
    const originalFetch = globalThis.fetch;
    let seenUrl = '';
    let seenHeaders: Headers | undefined;
    const events: Array<{ name: string; data: string; id?: string }> = [];
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('id: 7\nevent: snapshot\ndata: {"ok":true}\n\n'));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;

    try {
      const stream = openAuthenticatedEventStream(
        'https://api.example.test/projects/p1/events',
        'jwt-secret-value',
        {
          onEvent: (name, data, id) => events.push({ name, data, id }),
        },
      );
      await stream.ready;
      assert.equal(seenUrl.includes('jwt-secret-value'), false);
      assert.equal(seenHeaders?.get('authorization'), 'Bearer jwt-secret-value');
      assert.deepEqual(events, [{ name: 'snapshot', data: '{"ok":true}', id: '7' }]);
      stream.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed without a token', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const stream = openAuthenticatedEventStream('https://api.example.test/events', null);
      await assert.rejects(stream.ready, /Authentication required/);
      assert.equal(called, false);
      stream.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
