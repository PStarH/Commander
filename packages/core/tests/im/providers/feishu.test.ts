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

  it('parses message with invalid JSON content', () => {
    const req = {
      method: 'POST',
      query: {},
      body: {
        event: {
          message: {
            message_id: 'msg-2',
            chat_id: 'chat-1',
            content: 'not-valid-json',
          },
          sender: { sender_id: { open_id: 'user-1' } },
        },
      },
      headers: {},
    };
    const msg = feishuProvider.parseMessage(req);
    // When JSON parse fails, content is used as-is text
    assert.equal(msg.text, 'not-valid-json');
  });

  it('parses message with missing sender fields', () => {
    const req = {
      method: 'POST',
      query: {},
      body: {
        event: {
          message: {
            message_id: 'msg-3',
            chat_id: 'chat-2',
            content: JSON.stringify({ text: 'hello' }),
          },
          sender: {},
        },
      },
      headers: {},
    };
    const msg = feishuProvider.parseMessage(req);
    assert.equal(msg.text, 'hello');
    assert.equal(msg.senderId, 'unknown');
  });

  it('parses message with mentions', () => {
    const req = {
      method: 'POST',
      query: {},
      body: {
        event: {
          message: {
            message_id: 'msg-4',
            chat_id: 'chat-3',
            content: JSON.stringify({ text: 'ping' }),
            mentions: [{ key: 'user_a' }, { key: 'user_b' }],
          },
          sender: { sender_id: { open_id: 'sender-1' } },
        },
      },
      headers: {},
    };
    const msg = feishuProvider.parseMessage(req);
    assert.deepEqual(msg.mentionIds, ['user_a', 'user_b']);
  });

  it('verify with missing header token', () => {
    const req = { method: 'POST', query: {}, body: { event: {} }, headers: {} };
    assert.equal(feishuProvider.verify(req, 'secret-token'), false);
  });

  it('verify with empty body', () => {
    const req = { method: 'POST', query: {}, body: null, headers: {} };
    assert.equal(feishuProvider.verify(req, 'secret-token'), false);
  });
});
