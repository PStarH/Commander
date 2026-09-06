import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';

import { createOnboardingRouter } from '../src/onboardingEndpoints';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

describe('onboarding first-user security boundaries', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;
  let principal: Pick<NonNullable<Request['user']>, 'id' | 'username' | 'role'> | null = null;
  let writes: Array<Record<string, unknown>>;
  let providerFetches = 0;
  let providerFetch: typeof fetch;
  const originalFetch = globalThis.fetch;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  const originalGoogleBaseUrl = process.env.GOOGLE_BASE_URL;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL;

  before(async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = principal;
      next();
    });
    app.use(
      createOnboardingRouter({
        async writeConfig(updates) {
          writes.push(updates);
        },
      }),
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    restoreEnv('GOOGLE_API_KEY', originalGoogleKey);
    restoreEnv('GOOGLE_BASE_URL', originalGoogleBaseUrl);
    restoreEnv('OPENAI_API_KEY', originalOpenAiKey);
    restoreEnv('OPENAI_BASE_URL', originalOpenAiBaseUrl);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function reset(fetchImpl: typeof fetch): void {
    principal = null;
    writes = [];
    providerFetches = 0;
    providerFetch = fetchImpl;
    globalThis.fetch = async (...args) => {
      providerFetches += 1;
      return providerFetch(...args);
    };
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
  }

  it('rejects test-provider callers before attempting a provider request', async () => {
    reset(async () => new Response('{}'));
    process.env.OPENAI_API_KEY = 'operator-secret';

    let response = await postJson('/api/onboarding/test-provider', { provider: 'openai' });
    assert.equal(response.status, 401);
    assert.equal(providerFetches, 0);

    principal = { id: 'viewer-1', username: 'viewer', role: 'viewer' };
    response = await postJson('/api/onboarding/test-provider', { provider: 'openai' });
    assert.equal(response.status, 403);
    assert.equal(providerFetches, 0);
  });

  it('sends Google credentials in a header and redacts provider response bodies', async () => {
    reset(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      assert.ok(!url.includes('operator-secret'));
      assert.ok(!url.includes('?key='));
      assert.equal(headers.get('x-goog-api-key'), 'operator-secret');
      return new Response('upstream detail: operator-secret', { status: 401 });
    });
    principal = { id: 'admin-1', username: 'admin', role: 'admin' };
    process.env.GOOGLE_API_KEY = 'operator-secret';
    process.env.GOOGLE_BASE_URL = 'https://provider.example/v1beta';

    const response = await postJson('/api/onboarding/test-provider', { provider: 'google' });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error, 'Provider request failed (HTTP 401)');
    assert.equal(providerFetches, 1);
  });

  it('does not return raw network error messages from provider tests', async () => {
    reset(async () => {
      throw new Error('socket failure with operator-secret');
    });
    principal = { id: 'admin-1', username: 'admin', role: 'admin' };
    process.env.OPENAI_API_KEY = 'operator-secret';

    const response = await postJson('/api/onboarding/test-provider', { provider: 'openai' });
    assert.equal(response.status, 200);
    assert.equal(response.body.error, 'Unable to reach provider');
  });

  it('does not persist submitted provider API keys', async () => {
    reset(async () => new Response('{}'));
    principal = { id: 'admin-1', username: 'admin', role: 'admin' };

    const response = await postJson('/api/onboarding/save-config', {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'operator-secret',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(writes, [{ provider: 'openai', model: 'gpt-4o' }]);
  });

  it('reports first-task provider failures without a simulated task result', async () => {
    reset(async () => new Response('provider internals: operator-secret', { status: 503 }));
    principal = { id: 'admin-1', username: 'admin', role: 'admin' };
    process.env.OPENAI_API_KEY = 'operator-secret';

    const response = await postJson('/api/onboarding/run-first-task', { task: 'say hello' });
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, {
      success: false,
      error: 'Provider request failed (HTTP 503)',
    });
    assert.equal(providerFetches, 1);
  });

  function postJson(path: string, body: unknown): Promise<JsonResponse> {
    const target = new URL(path, baseUrl);
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        target,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(raw) as Record<string, unknown>,
            });
          });
        },
      );
      request.once('error', reject);
      request.end(payload);
    });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
