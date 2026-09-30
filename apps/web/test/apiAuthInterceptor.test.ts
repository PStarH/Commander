/**
 * WEB-01 / WEB-02: the global fetch interceptor.
 *
 *  - WEB-01: an injected `init.headers` must not replace a Request's own
 *    headers when the caller did not supply `init.headers`; an explicit caller
 *    Authorization must survive, and the session token is only added when the
 *    effective headers do not already carry one.
 *  - WEB-02: the stored session is cleared only for a 401 from the Commander
 *    API, and only while the token that was sent is still the stored token.
 *
 * The module installs its interceptor at import time, so the synthetic browser
 * environment and fake fetch are installed before `../src/api` is imported.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

function createStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
  };
}

const storage = createStorage();
const browserLocation = {
  origin: 'https://app.commander.example',
  href: 'https://app.commander.example/console',
};

(globalThis as unknown as { localStorage: unknown }).localStorage = storage;
(globalThis as unknown as { location: unknown }).location = browserLocation;
(globalThis as unknown as { window: unknown }).window = {
  dispatchEvent: () => true,
  location: browserLocation,
  history: { replaceState: () => undefined },
};

let responder: (input: RequestInfo | URL, init?: RequestInit) => Response = () =>
  new Response('', { status: 200 });
const seen: Array<{ url: string; headers: Headers }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const request = input instanceof Request ? input : undefined;
  seen.push({
    url: request ? request.url : String(input),
    headers: new Headers(init?.headers ?? request?.headers ?? undefined),
  });
  return responder(input, init);
}) as typeof fetch;

const { API_BASE, getAuthToken, setAuthTokens } = await import('../src/api');

function resetSession(token: string | null): void {
  storage.clear();
  seen.length = 0;
  responder = () => new Response('', { status: 200 });
  if (token) setAuthTokens(token, 'refresh-token');
}

describe('fetch interceptor header handling (WEB-01)', () => {
  beforeEach(() => {
    resetSession('session-token');
  });

  it('preserves a Request Authorization and custom headers when init is absent', async () => {
    const request = new Request(`${API_BASE}/api/secure`, {
      headers: { Authorization: 'Bearer explicit-caller-token', 'X-Custom': 'keep-me' },
    });

    await fetch(request);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers.get('Authorization'), 'Bearer explicit-caller-token');
    assert.equal(seen[0].headers.get('X-Custom'), 'keep-me');
  });

  it('adds the session Authorization to a Request that has none, keeping custom headers', async () => {
    const request = new Request(`${API_BASE}/api/secure`, { headers: { 'X-Custom': 'keep-me' } });

    await fetch(request);

    assert.equal(seen[0].headers.get('Authorization'), 'Bearer session-token');
    assert.equal(seen[0].headers.get('X-Custom'), 'keep-me');
  });

  it('lets explicit init.headers override the Request headers, as Fetch does', async () => {
    const request = new Request(`${API_BASE}/api/secure`, {
      headers: { 'X-Custom': 'from-request' },
    });

    await fetch(request, { headers: { 'X-Other': 'from-init' } });

    assert.equal(seen[0].headers.get('X-Custom'), null);
    assert.equal(seen[0].headers.get('X-Other'), 'from-init');
    assert.equal(seen[0].headers.get('Authorization'), 'Bearer session-token');
  });

  it('never attaches the session token to an unrelated origin', async () => {
    await fetch('https://unrelated.example/collect');

    assert.equal(seen[0].headers.get('Authorization'), null);
  });
});

describe('fetch interceptor session clearing (WEB-02)', () => {
  it('keeps the session on a 401 from an unrelated origin', async () => {
    resetSession('session-a');
    responder = () => new Response('', { status: 401 });

    const response = await fetch('https://unrelated.example/data');

    assert.equal(response.status, 401);
    assert.equal(getAuthToken(), 'session-a');
  });

  it('clears the session on a 401 from the Commander API', async () => {
    resetSession('session-a');
    responder = () => new Response('', { status: 401 });

    const response = await fetch(`${API_BASE}/api/secure`);

    assert.equal(response.status, 401);
    assert.equal(getAuthToken(), null);
  });

  it('keeps a newer session when a delayed 401 arrives for the old token', async () => {
    resetSession('session-old');
    responder = () => {
      // Another tab logs in while this request is in flight.
      setAuthTokens('session-new', 'refresh-token-new');
      return new Response('', { status: 401 });
    };

    await fetch(`${API_BASE}/api/secure`);

    assert.equal(getAuthToken(), 'session-new');
  });

  it('does not clear the session on a non-401 API response', async () => {
    resetSession('session-a');
    responder = () => new Response('', { status: 500 });

    await fetch(`${API_BASE}/api/secure`);

    assert.equal(getAuthToken(), 'session-a');
  });
});
