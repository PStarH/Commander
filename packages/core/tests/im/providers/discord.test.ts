import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { discordProvider } from '../../../src/plugins/im/discord';

describe('Discord provider', () => {
  it('verifies valid signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey
      .export({ type: 'spki', format: 'der' })
      .slice(12)
      .toString('hex');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"id":"msg-1","type":0,"content":"hello","channel_id":"ch-1"}';
    const signature = crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
    const req = {
      method: 'POST',
      query: {},
      body,
      headers: {
        'x-signature-timestamp': timestamp,
        'x-signature-ed25519': signature,
      },
    };
    assert.equal(discordProvider.verify(req, rawPublicKey), true);
  });

  it('rejects missing signature headers', () => {
    const req = { method: 'POST', query: {}, body: '{}', headers: {} };
    assert.equal(discordProvider.verify(req, 'public-key'), false);
  });

  it('parses message', () => {
    const req = {
      method: 'POST',
      query: {},
      body: {
        id: 'msg-1',
        type: 0,
        content: 'hello discord',
        channel_id: 'ch-1',
        member: { user: { id: 'user-1' } },
      },
      headers: {},
    };
    const msg = discordProvider.parseMessage(req);
    assert.equal(msg.text, 'hello discord');
    assert.equal(msg.conversationId, 'ch-1');
  });

  it('strips @mention', () => {
    assert.equal(discordProvider.stripMention('<@123> hello'), 'hello');
    assert.equal(discordProvider.stripMention('<@!123> hello'), 'hello');
  });

  it('formats reply', () => {
    const reply = discordProvider.formatReply({ text: 'reply' });
    assert.deepEqual(reply.body, { content: 'reply', flags: 64 });
  });

  it('rejects invalid Ed25519 signature', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '{}',
      headers: {
        'x-signature-timestamp': '123456',
        'x-signature-ed25519':
          '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      },
    };
    assert.equal(discordProvider.verify(req, '00'.repeat(32)), false);
  });

  it('parses message with user at top level (no member wrapper)', () => {
    const req = {
      method: 'POST',
      query: {},
      body: {
        id: 'msg-2',
        content: 'direct message',
        channel_id: 'dm-1',
        user: { id: 'user-dm' },
      },
      headers: {},
    };
    const msg = discordProvider.parseMessage(req);
    assert.equal(msg.text, 'direct message');
    assert.equal(msg.senderId, 'user-dm');
    assert.equal(msg.conversationId, 'dm-1');
  });

  it('parses message with missing channel_id', () => {
    const req = {
      method: 'POST',
      query: {},
      body: { id: 'msg-3', content: 'hello', member: { user: { id: 'u1' } } },
      headers: {},
    };
    const msg = discordProvider.parseMessage(req);
    assert.equal(msg.conversationId, 'unknown');
  });

  it('parses message with empty body', () => {
    const req = { method: 'POST', query: {}, body: null, headers: {} };
    const msg = discordProvider.parseMessage(req);
    assert.equal(msg.text, '');
    assert.equal(msg.senderId, 'unknown');
  });

  it('stripMention removes nickname variant', () => {
    assert.equal(discordProvider.stripMention('<@!456> hi there'), 'hi there');
  });

  it('stripMention with no mention returns original text', () => {
    assert.equal(discordProvider.stripMention('just text'), 'just text');
  });
});
