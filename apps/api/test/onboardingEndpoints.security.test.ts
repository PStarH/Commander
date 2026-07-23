import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';

import { createOnboardingRouter } from '../src/onboardingEndpoints';

describe('onboarding provider configuration authorization', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let baseUrl: string;
  let principal: Pick<NonNullable<Request['user']>, 'id' | 'username' | 'role'> | null;
  let apiKeyId: string | undefined;
  let scopes: string[];
  const writes: Array<Record<string, unknown>> = [];

  before(async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = principal;
      req.apiKeyId = apiKeyId;
      req.apiScopes = scopes;
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
    await new Promise<void>((resolve) => server.on('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  async function saveConfig() {
    return fetch(`${baseUrl}/api/onboarding/save-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'secret' }),
    });
  }

  it('rejects unauthenticated and low-privilege callers without writing', async () => {
    principal = null;
    apiKeyId = undefined;
    scopes = [];
    assert.equal((await saveConfig()).status, 401);

    principal = { id: 'user-1', username: 'user', role: 'viewer' };
    apiKeyId = undefined;
    scopes = ['read', 'write'];
    assert.equal((await saveConfig()).status, 403);
    assert.equal(writes.length, 0);
  });

  it('allows administrator JWTs and admin-scoped API keys', async () => {
    principal = { id: 'admin-1', username: 'admin', role: 'admin' };
    apiKeyId = undefined;
    scopes = [];
    assert.equal((await saveConfig()).status, 200);

    principal = null;
    apiKeyId = 'admin-key';
    scopes = ['admin'];
    assert.equal((await saveConfig()).status, 200);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0], { provider: 'openai', model: 'gpt-4o', apiKey: 'secret' });
  });
});
