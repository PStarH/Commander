import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { teamsProvider } from '../../../src/plugins/im/teams';

describe('Teams provider', () => {
  it('verifies valid signature', () => {
    const secret = 'secret';
    const body = '{"text":"hello"}';
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');
    const req = { method: 'POST', query: {}, body, headers: { authorization: signature } };
    assert.equal(teamsProvider.verify(req, secret), true);
  });

  it('rejects invalid signature', () => {
    const req = { method: 'POST', query: {}, body: '{}', headers: { authorization: 'bad' } };
    assert.equal(teamsProvider.verify(req, 'secret'), false);
  });

  it('parses activity', () => {
    const req = {
      method: 'POST',
      query: {},
      body: {
        id: 'a-1',
        type: 'message',
        text: 'hello teams',
        from: { id: 'user-1' },
        conversation: { id: 'conv-1' },
        serviceUrl: 'https://service.example',
      },
      headers: {},
    };
    const msg = teamsProvider.parseMessage(req);
    assert.equal(msg.text, 'hello teams');
    assert.equal(msg.conversationId, 'conv-1');
  });

  it('strips @mention', () => {
    assert.equal(teamsProvider.stripMention('<at>Bot</at> hello'), 'hello');
  });
});
