import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import {
  createSettingsRouter,
  redactSettings,
  REDACTED_SETTING_VALUE,
  validateSettings,
} from '../src/settingsEndpoints.js';

async function requestPut(role: string): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { role: string } }).user = { role };
    next();
  });
  app.use(createSettingsRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini' }),
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('LM-29 settings secret ownership and redaction', () => {
  it('redacts every secret-bearing URL field, regardless of path layout', () => {
    const settings = redactSettings({
      model: 'gpt-4o',
      notifications: {
        webhookUrl: 'https://hooks.example.test/v1/tenants/acme/keys/secret-after-prefix',
        slackWebhook: 'https://slack.example.test/services/T000/B000/secret-token',
      },
    });

    assert.equal(settings.notifications?.webhookUrl, REDACTED_SETTING_VALUE);
    assert.equal(settings.notifications?.slackWebhook, REDACTED_SETTING_VALUE);
    assert.equal(
      JSON.stringify(settings).includes('secret-after-prefix'),
      false,
      'the returned DTO must not contain a later path secret',
    );
    assert.equal(JSON.stringify(settings).includes('secret-token'), false);
  });

  it('rejects redacted placeholders on write instead of overwriting the secret', () => {
    const result = validateSettings({
      notifications: { webhookUrl: REDACTED_SETTING_VALUE },
    });
    assert.ok('error' in result);
    assert.match(result.error, /omit it to keep the existing secret/);
  });

  it('requires exact super-admin ownership for process-wide settings writes', async () => {
    const admin = await requestPut('admin');
    assert.equal(admin.status, 403);
    assert.match(await admin.text(), /Super-admin privileges required/);

    const viewer = await requestPut('viewer');
    assert.equal(viewer.status, 403);
  });
});
