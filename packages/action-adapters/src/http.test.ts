import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adapterFetch } from './http.js';

describe('adapterFetch', () => {
  it('does not follow redirects', async () => {
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return new Response('', { status: 302, headers: { location: 'https://evil.example' } });
    };
    await assert.rejects(() => adapterFetch(fetchImpl, 'https://api.example/resource'));
    assert.equal(callCount, 1);
  });

  it('passes through abort signal', async () => {
    const controller = new AbortController();
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.signal, controller.signal);
      assert.equal(init?.redirect, 'manual');
      return new Response('{}', { status: 200 });
    };
    await adapterFetch(fetchImpl, 'https://api.example/resource', { signal: controller.signal });
  });
});
