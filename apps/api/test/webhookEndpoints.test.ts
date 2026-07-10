import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createWebhookRouter, type IMWebhookConfig } from '../src/webhookEndpoints';
import { getIMProviderRegistry } from '@commander/core';
import { dingtalkProvider } from '@commander/core/plugins/im/dingtalk';

describe('IM Webhook Endpoints', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let port: number;
  let tmpDir: string;
  let authEnabled = true;

  before(async () => {
    tmpDir = path.join(os.tmpdir(), `commander-im-webhook-test-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
    process.env.COMMANDER_WEBHOOKS_FILE = path.join(tmpDir, '.commander', 'webhooks.json');

    getIMProviderRegistry().reset();
    getIMProviderRegistry().register(dingtalkProvider);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (authEnabled) {
        (req as any).user = { id: 'admin-1', role: 'admin' };
      }
      next();
    });
    app.use(createWebhookRouter());

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function request(path: string, init?: RequestInit) {
    return fetch(`http://127.0.0.1:${port}${path}`, init);
  }

  it('GET /api/webhook/config requires authentication', async () => {
    authEnabled = false;
    const res = await request('/api/webhook/config');
    assert.equal(res.status, 401);
    authEnabled = true;
  });

  it('POST /api/webhook/config requires authentication', async () => {
    authEnabled = false;
    const res = await request('/api/webhook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'dingtalk', name: 'test', agentId: 'agent-commander' }),
    });
    assert.equal(res.status, 401);
    authEnabled = true;
  });

  it('DELETE /api/webhook/config/:id requires authentication', async () => {
    authEnabled = false;
    const res = await request('/api/webhook/config/some-id', { method: 'DELETE' });
    assert.equal(res.status, 401);
    authEnabled = true;
  });

  it('creates and lists an IM webhook with encrypted secret', async () => {
    process.env.COMMANDER_MASTER_KEY = 'a-very-long-master-key-for-testing-32';
    const createRes = await request('/api/webhook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'dingtalk', name: 'test-bot', agentId: 'agent-commander' }),
    });
    assert.equal(createRes.status, 201);
    const { webhook } = (await createRes.json()) as { webhook: IMWebhookConfig };
    assert.equal(webhook.platform, 'dingtalk');
    assert.ok(webhook.secret);

    const listRes = await request('/api/webhook/config');
    assert.equal(listRes.status, 200);
    const { webhooks } = (await listRes.json()) as { webhooks: IMWebhookConfig[] };
    assert.ok(webhooks.some((w) => w.id === webhook.id));

    const raw = fs.readFileSync(path.join(tmpDir, '.commander', 'webhooks.json'), 'utf-8');
    assert.ok(raw.includes('enc:v1:'), 'secret should be encrypted on disk');

    // cleanup
    const delRes = await request(`/api/webhook/config/${encodeURIComponent(webhook.id)}`, {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);
  });

  it('disabled webhook rejects incoming callbacks', async () => {
    const createRes = await request('/api/webhook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'dingtalk',
        name: 'disabled-bot',
        agentId: 'agent-commander',
        enabled: false,
      }),
    });
    const { webhook } = (await createRes.json()) as { webhook: IMWebhookConfig };

    const res = await request(
      `/api/webhook/dingtalk/${webhook.id}?timestamp=1&sign=invalid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: 'hello' } }),
      },
    );
    assert.equal(res.status, 401);

    // cleanup
    await request(`/api/webhook/config/${encodeURIComponent(webhook.id)}`, { method: 'DELETE' });
  });

  it('rejects unknown IM provider with 404', async () => {
    const res = await request('/api/webhook/unknown/config-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });

  it('rejects DingTalk callback with invalid signature', async () => {
    const createRes = await request('/api/webhook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: 'dingtalk',
        name: 'sig-bot',
        agentId: 'agent-commander',
        enabled: true,
      }),
    });
    const { webhook } = (await createRes.json()) as { webhook: IMWebhookConfig };

    const res = await request(
      `/api/webhook/dingtalk/${webhook.id}?timestamp=1&sign=invalid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: 'hello' } }),
      },
    );
    assert.equal(res.status, 401);

    // cleanup
    await request(`/api/webhook/config/${encodeURIComponent(webhook.id)}`, { method: 'DELETE' });
  });
});
