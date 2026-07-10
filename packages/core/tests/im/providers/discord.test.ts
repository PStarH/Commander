import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { discordProvider } from '../../../src/plugins/im/discord';

describe('Discord provider', () => {
  it('verifies valid signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).slice(12).toString('hex');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"id":"msg-1","type":0,"content":"hello","channel_id":"ch-1"}';
    const signature = crypto
      .sign(null, Buffer.from(timestamp + body), privateKey)
      .toString('hex');
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
});
