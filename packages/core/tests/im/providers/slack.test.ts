import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { slackProvider } from '../../../src/plugins/im/slack';

describe('Slack provider', () => {
  it('verifies valid signature', () => {
    const secret = 'signing-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"event":{"type":"message","text":"hello"}}';
    const expected = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    const req = {
      method: 'POST',
      query: {},
      body,
      headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': expected },
    };
    assert.equal(slackProvider.verify(req, secret), true);
  });

  it('rejects invalid signature', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '{}',
      headers: { 'x-slack-request-timestamp': '1', 'x-slack-signature': 'bad' },
    };
    assert.equal(slackProvider.verify(req, 'secret'), false);
  });

  it('parses message', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { event: { type: 'message', text: 'hello', user: 'U1', channel: 'C1', ts: '123' } },
      headers: {},
    };
    const msg = slackProvider.parseMessage(req);
    assert.equal(msg.text, 'hello');
    assert.equal(msg.conversationId, 'C1');
  });

  it('strips @mention', () => {
    assert.equal(slackProvider.stripMention('<@U123> hello'), 'hello');
  });

  it('rejects request with missing signature headers', () => {
    const req = { method: 'POST', query: {}, body: '{}', headers: {} };
    assert.equal(slackProvider.verify(req, 'secret'), false);
  });

  it('rejects request with missing timestamp only', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '{}',
      headers: { 'x-slack-signature': 'v0=some' },
    };
    assert.equal(slackProvider.verify(req, 'secret'), false);
  });

  it('parses message with missing event fields', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { event: {} },
      headers: {},
    };
    const msg = slackProvider.parseMessage(req);
    assert.equal(msg.text, '');
    assert.equal(msg.senderId, 'unknown');
    assert.equal(msg.conversationId, 'unknown');
  });

  it('parses message with empty body', () => {
    const req = { method: 'POST', query: {}, body: null, headers: {} };
    const msg = slackProvider.parseMessage(req);
    assert.equal(msg.text, '');
  });

  it('verify handles object body by stringifying', () => {
    const secret = 'signing-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyObj = { event: { type: 'message', text: 'test' } };
    const rawBody = JSON.stringify(bodyObj);
    const expected = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
    const req = {
      method: 'POST',
      query: {},
      body: bodyObj,
      headers: { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': expected },
    };
    assert.equal(slackProvider.verify(req, secret), true);
  });

  it('formatReply returns Slack-compatible body', () => {
    const result = slackProvider.formatReply({ text: 'hello world' });
    assert.deepEqual(result.body, { text: 'hello world' });
  });

  it('sendMessage throws when token is missing', async () => {
    await assert.rejects(
      () => slackProvider.sendMessage('C1', { text: 'hello' }, {}),
      /token missing/,
    );
  });

  it('sendMessage throws when token is undefined', async () => {
    await assert.rejects(
      () => slackProvider.sendMessage('C1', { text: 'hello' }, { token: undefined }),
      /token missing/,
    );
  });

  // PL-16: Slack reports API-level failures as HTTP 200 + {ok:false,error}, so a
  // status-only check resolved the promise and the dispatcher recorded the
  // notification as delivered when Slack had rejected it.
  it('sendMessage rejects an HTTP 200 response whose body is {ok:false}', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    })) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => slackProvider.sendMessage('C1', { text: 'hello' }, { token: 'xoxb-test' }),
        /channel_not_found/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sendMessage resolves on an HTTP 200 response whose body is {ok:true}', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ts: '123.456' }),
    })) as unknown as typeof fetch;
    try {
      await assert.doesNotReject(() =>
        slackProvider.sendMessage('C1', { text: 'hello' }, { token: 'xoxb-test' }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
