import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { wecomProvider } from '../../../src/plugins/im/wecom';

describe('WeCom provider', () => {
  it('verifies valid signature', () => {
    const token = 'test-token';
    const timestamp = '123456';
    const nonce = 'nonce';
    const encrypt = 'encrypt-data';
    const signature = crypto
      .createHash('sha1')
      .update([token, timestamp, nonce, encrypt].sort().join(''))
      .digest('hex');
    const req = {
      method: 'POST',
      query: { msg_signature: signature, timestamp, nonce },
      body: `<xml><Encrypt>${encrypt}</Encrypt></xml>`,
      headers: {},
    };
    assert.equal(wecomProvider.verify(req, token), true);
  });

  it('rejects invalid signature', () => {
    const req = {
      method: 'POST',
      query: { msg_signature: 'bad', timestamp: '1', nonce: 'n' },
      body: '<xml><Encrypt>e</Encrypt></xml>',
      headers: {},
    };
    assert.equal(wecomProvider.verify(req, 'token'), false);
  });

  it('parses XML message', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '<xml><Content><![CDATA[hello wecom]]></Content><FromUserName><![CDATA[user-1]]></FromUserName><ToUserName><![CDATA[bot-1]]></ToUserName><MsgType><![CDATA[text]]></MsgType></xml>',
      headers: {},
    };
    const msg = wecomProvider.parseMessage(req);
    assert.equal(msg.text, 'hello wecom');
    assert.equal(msg.senderId, 'user-1');
  });

  it('formats XML reply', () => {
    const reply = wecomProvider.formatReply({ text: 'reply text' });
    assert.ok(String(reply.body).includes('<![CDATA[reply text]]>'));
    assert.equal(reply.headers?.['Content-Type'], 'application/xml');
  });

  it('rejects request with missing query params', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '<xml><Encrypt>e</Encrypt></xml>',
      headers: {},
    };
    assert.equal(wecomProvider.verify(req, 'token'), false);
  });

  it('rejects request with missing Encrypt in body', () => {
    const req = {
      method: 'POST',
      query: { msg_signature: 'sig', timestamp: '1', nonce: 'n' },
      body: '<xml><NoEncrypt>data</NoEncrypt></xml>',
      headers: {},
    };
    assert.equal(wecomProvider.verify(req, 'token'), false);
  });

  it('parses non-CDATA XML fields', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '<xml><Content>plain text</Content><FromUserName>user-2</FromUserName><ToUserName>bot-2</ToUserName><MsgType>text</MsgType></xml>',
      headers: {},
    };
    const msg = wecomProvider.parseMessage(req);
    assert.equal(msg.text, 'plain text');
    assert.equal(msg.senderId, 'user-2');
  });

  it('parses message with object body by stringifying', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '<xml><Content><![CDATA[hello]]></Content><FromUserName><![CDATA[u1]]></FromUserName></xml>',
      headers: {},
    };
    const msg = wecomProvider.parseMessage(req);
    assert.equal(msg.text, 'hello');
  });

  it('parses message with missing XML fields', () => {
    const req = {
      method: 'POST',
      query: {},
      body: '<xml></xml>',
      headers: {},
    };
    const msg = wecomProvider.parseMessage(req);
    assert.equal(msg.text, '');
    assert.equal(msg.senderId, 'unknown');
  });
});
