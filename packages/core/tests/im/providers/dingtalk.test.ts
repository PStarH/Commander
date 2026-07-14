import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { dingtalkProvider } from '../../../src/plugins/im/dingtalk';

describe('DingTalk provider', () => {
  it('verifies valid signature', () => {
    const secret = 'test-secret';
    const timestamp = String(Date.now());
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}\n${secret}`)
      .digest('base64');
    const req = {
      method: 'POST',
      query: { timestamp, sign: expected },
      body: {},
      headers: {},
    };
    assert.equal(dingtalkProvider.verify(req, secret), true);
  });

  it('rejects invalid signature', () => {
    const req = {
      method: 'POST',
      query: { timestamp: '1', sign: 'invalid' },
      body: {},
      headers: {},
    };
    assert.equal(dingtalkProvider.verify(req, 'secret'), false);
  });

  it('parses text message', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { msgtype: 'text', text: { content: 'hello world' } },
      headers: {},
    };
    const msg = dingtalkProvider.parseMessage(req);
    assert.equal(msg.text, 'hello world');
  });

  it('strips @bot mention', () => {
    assert.equal(dingtalkProvider.stripMention('@assistant hello'), 'hello');
  });

  it('formats reply', () => {
    const reply = dingtalkProvider.formatReply({ text: 'reply text' });
    assert.deepEqual(reply.body, { msgtype: 'text', text: { content: 'reply text' } });
  });

  it('rejects request with missing query params', () => {
    const req = { method: 'POST', query: {}, body: {}, headers: {} };
    assert.equal(dingtalkProvider.verify(req, 'secret'), false);
  });

  it('parses markdown message', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { msgtype: 'markdown', markdown: { text: '# Heading\nSome text' } },
      headers: {},
    };
    const msg = dingtalkProvider.parseMessage(req);
    assert.equal(msg.text, '# Heading\nSome text');
    assert.equal(msg.metadata?.msgtype, 'markdown');
  });

  it('parses message with missing text content', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { msgtype: 'text', text: {} },
      headers: {},
    };
    const msg = dingtalkProvider.parseMessage(req);
    assert.equal(msg.text, '');
  });

  it('parses message with unknown msgtype', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { msgtype: 'action_card' },
      headers: {},
    };
    const msg = dingtalkProvider.parseMessage(req);
    assert.equal(msg.text, '');
    assert.equal(msg.metadata?.msgtype, 'action_card');
  });

  it('parses message with empty body', () => {
    const req = { method: 'POST', query: {}, body: null, headers: {} };
    const msg = dingtalkProvider.parseMessage(req);
    assert.equal(msg.text, '');
    assert.equal(msg.senderId, 'unknown');
  });
});
