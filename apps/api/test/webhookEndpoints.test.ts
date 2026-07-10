import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createWebhookRouter, type IMWebhookConfig } from '../src/webhookEndpoints';
import {
  getIMProviderRegistry,
  resetIMProviderRegistry,
  getIMContextStore,
  resetIMContextStore,
  type IMProvider,
  type IMIncomingRequest,
  type IMMessage,
  type IMReply,
} from '@commander/core';
import { dingtalkProvider } from '@commander/core/plugins/im/dingtalk';
import { getSharedRuntime } from '../src/sharedRuntime';

function dingtalkSign(timestamp: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
}

const fakeProvider: IMProvider = {
  id: 'fake',
  name: 'Fake',
  verify: () => true,
  parseMessage: (req: IMIncomingRequest): IMMessage => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return {
      text: String(body.text ?? ''),
      senderId: String(body.senderId ?? 'unknown'),
      conversationId: String(body.conversationId ?? 'unknown'),
    };
  },
  formatReply: (reply: IMReply) => ({ body: { text: reply.text } }),
  stripMention: (t: string) => t,
  sendMessage: async () => {},
};

describe('IM Webhook Endpoints', () => {
  let app: express.Express;
  let server: ReturnType<typeof app.listen>;
  let port: number;
  let tmpDir: string;
  let authEnabled = true;
  const routerRef = { current: null as ReturnType<typeof createWebhookRouter> | null };

  before(async () => {
    tmpDir = path.join(os.tmpdir(), `commander-im-webhook-test-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
    process.env.COMMANDER_WEBHOOKS_FILE = path.join(tmpDir, '.commander', 'webhooks.json');

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (authEnabled) {
        (req as any).user = { id: 'admin-1', role: 'admin' };
      }
      next();
    });

    routerRef.current = createWebhookRouter();
    app.use(routerRef.current);

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

  beforeEach(() => {
    resetIMProviderRegistry();
    getIMProviderRegistry().register(dingtalkProvider);
    resetIMContextStore();
    authEnabled = true;
  });

  function request(path: string, init?: RequestInit) {
    return fetch(`http://127.0.0.1:${port}${path}`, init);
  }

  async function createWebhook(
    body: Record<string, unknown>,
  ): Promise<{ config: IMWebhookConfig; secret: string }> {
    const createRes = await request('/api/webhook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(createRes.status, 201);
    const { webhook } = (await createRes.json()) as { webhook: IMWebhookConfig };
    return { config: webhook, secret: webhook.secret };
  }

  it('GET /api/webhook/config requires authentication', async () => {
    authEnabled = false;
    const res = await request('/api/webhook/config');
    assert.equal(res.status, 401);
  });

  it('POST /api/webhook/config requires authentication', async () => {
    authEnabled = false;
    const res = await request('/api/webhook/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'dingtalk', name: 'test', agentId: 'agent-commander' }),
    });
    assert.equal(res.status, 401);
  });

  it('DELETE /api/webhook/config/:id requires authentication', async () => {
    authEnabled = false;
    const res = await request('/api/webhook/config/some-id', { method: 'DELETE' });
    assert.equal(res.status, 401);
  });

  it('creates and lists an IM webhook with encrypted secret', async () => {
    process.env.COMMANDER_MASTER_KEY = 'a-very-long-master-key-for-testing-32';
    const { config } = await createWebhook({
      platform: 'dingtalk',
      name: 'test-bot',
      agentId: 'agent-commander',
    });
    assert.equal(config.platform, 'dingtalk');
    assert.ok(config.secret);

    const listRes = await request('/api/webhook/config');
    assert.equal(listRes.status, 200);
    const { webhooks } = (await listRes.json()) as { webhooks: IMWebhookConfig[] };
    assert.ok(webhooks.some((w) => w.id === config.id));

    const raw = fs.readFileSync(path.join(tmpDir, '.commander', 'webhooks.json'), 'utf-8');
    assert.ok(raw.includes('enc:v1:'), 'secret should be encrypted on disk');

    await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
  });

  it('disabled webhook rejects incoming callbacks', async () => {
    const { config, secret } = await createWebhook({
      platform: 'dingtalk',
      name: 'disabled-bot',
      agentId: 'agent-commander',
      enabled: false,
    });

    const timestamp = String(Date.now());
    const sign = dingtalkSign(timestamp, secret);
    const res = await request(
      `/api/webhook/dingtalk/${config.id}?timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: 'hello' } }),
      },
    );
    assert.equal(res.status, 401);

    await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
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
    const { config } = await createWebhook({
      platform: 'dingtalk',
      name: 'sig-bot',
      agentId: 'agent-commander',
      enabled: true,
    });

    const res = await request(
      `/api/webhook/dingtalk/${config.id}?timestamp=1&sign=invalid`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: 'hello' } }),
      },
    );
    assert.equal(res.status, 401);

    await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
  });

  it('acknowledges a valid DingTalk callback asynchronously', async () => {
    const { config, secret } = await createWebhook({
      platform: 'dingtalk',
      name: 'ack-bot',
      agentId: 'agent-commander',
      enabled: true,
    });

    const timestamp = String(Date.now());
    const sign = dingtalkSign(timestamp, secret);
    const res = await request(
      `/api/webhook/dingtalk/${config.id}?timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: 'hello' },
          senderStaffId: 'user-1',
          conversationId: 'conv-1',
        }),
      },
    );
    assert.equal(res.status, 200);
    const reply = (await res.json()) as { text?: { content?: string } };
    assert.equal(reply.text?.content, 'Received, processing...');

    await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
  });

  it('handles /reset command', async () => {
    const { config, secret } = await createWebhook({
      platform: 'dingtalk',
      name: 'reset-bot',
      agentId: 'agent-commander',
      enabled: true,
    });

    const timestamp = String(Date.now());
    const sign = dingtalkSign(timestamp, secret);
    const res = await request(
      `/api/webhook/dingtalk/${config.id}?timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: '/reset' },
          senderStaffId: 'user-1',
          conversationId: 'conv-1',
        }),
      },
    );
    assert.equal(res.status, 200);
    const reply = (await res.json()) as { text?: { content?: string } };
    assert.equal(reply.text?.content, '上下文已重置');

    await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
  });

  it('handles /status command', async () => {
    const { config, secret } = await createWebhook({
      platform: 'dingtalk',
      name: 'status-bot',
      agentId: 'agent-commander',
      enabled: true,
    });

    const timestamp = String(Date.now());
    const sign = dingtalkSign(timestamp, secret);
    const res = await request(
      `/api/webhook/dingtalk/${config.id}?timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: '/status' },
          senderStaffId: 'user-1',
          conversationId: 'conv-1',
        }),
      },
    );
    assert.equal(res.status, 200);
    const reply = (await res.json()) as { text?: { content?: string } };
    assert.equal(reply.text?.content, '就绪');

    await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
  });

  it('persists conversation context across messages', async () => {
    const { config, secret } = await createWebhook({
      platform: 'dingtalk',
      name: 'ctx-bot',
      agentId: 'agent-commander',
      enabled: true,
    });

    const timestamp = String(Date.now());
    const sign = dingtalkSign(timestamp, secret);
    await request(
      `/api/webhook/dingtalk/${config.id}?timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: 'first message' },
          senderStaffId: 'user-1',
          conversationId: 'conv-1',
        }),
      },
    );

    const ctx = await getIMContextStore().getContext('dingtalk', 'conv-1', 'user-1');
    assert.ok(ctx);
    assert.equal(ctx.messages.length, 1);
    assert.equal(ctx.messages[0].role, 'user');
    assert.equal(ctx.messages[0].text, 'first message');

    await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
  });

  it('pushes proactive reply via provider sendMessage', async () => {
    let sendCalled = false;
    let sentText = '';
    const provider: IMProvider = {
      ...fakeProvider,
      sendMessage: async (_conversationId: string, reply: IMReply) => {
        sendCalled = true;
        sentText = reply.text;
      },
    };
    resetIMProviderRegistry();
    getIMProviderRegistry().register(provider);

    const { config } = await createWebhook({
      platform: 'fake',
      name: 'proactive-bot',
      agentId: 'agent-commander',
      enabled: true,
      outbound: { token: 'fake-token' },
    });

    const runtime = getSharedRuntime();
    const originalExecute = runtime.execute.bind(runtime);
    runtime.execute = async () => ({
      status: 'success',
      summary: 'Proactive result',
      steps: [],
      toolCalls: [],
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      durationMs: 0,
    });

    try {
      const res = await request(`/api/webhook/fake/${config.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: 'hello',
          senderId: 'user-1',
          conversationId: 'conv-1',
        }),
      });
      assert.equal(res.status, 200);
      const reply = (await res.json()) as { text?: string };
      assert.equal(reply.text, 'Received, processing...');

      // Wait for the asynchronous Promise.then chain to dispatch the reply.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sendCalled, true);
      assert.equal(sentText, 'Proactive result');
    } finally {
      runtime.execute = originalExecute;
      await request(`/api/webhook/config/${encodeURIComponent(config.id)}`, { method: 'DELETE' });
    }
  });
});
