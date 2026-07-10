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
});
