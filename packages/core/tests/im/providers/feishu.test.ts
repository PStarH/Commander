import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { feishuProvider } from '../../../src/plugins/im/feishu';

describe('Feishu provider', () => {
  it('verifies valid token', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { header: { token: 'secret-token' }, event: { message: {} } },
      headers: {},
    };
    assert.equal(feishuProvider.verify(req, 'secret-token'), true);
  });

  it('rejects invalid token', () => {
    const req = { method: 'POST', query: {}, body: { header: { token: 'bad' } }, headers: {} };
    assert.equal(feishuProvider.verify(req, 'secret-token'), false);
  });

  it('parses message content', () => {
    const req = {
      method: 'POST',
      query: {},
      body: {
        event: {
          message: {
            message_id: 'msg-1',
            chat_id: 'chat-1',
            content: JSON.stringify({ text: 'hello feishu' }),
          },
          sender: { sender_id: { open_id: 'user-1' } },
        },
      },
      headers: {},
    };
    const msg = feishuProvider.parseMessage(req);
    assert.equal(msg.text, 'hello feishu');
    assert.equal(msg.conversationId, 'chat-1');
  });

  it('strips @mention', () => {
    assert.equal(feishuProvider.stripMention('hello @_user_123'), 'hello');
  });
});
