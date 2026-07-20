/**
 * Crypto helpers for IM webhook verification — length-safe timing compare,
 * DingTalk freshness, Feishu constant-time token check.
 *
 * Imports the shared production module so tests cannot drift from live routes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { timingSafeEqualString, verifyDingTalkSignature } from '../src/webhookCrypto';

describe('timingSafeEqualString', () => {
  it('matches equal non-empty strings', () => {
    assert.equal(timingSafeEqualString('abc', 'abc'), true);
  });

  it('rejects unequal content of same length', () => {
    assert.equal(timingSafeEqualString('abc', 'abd'), false);
  });

  it('rejects unequal lengths without throwing', () => {
    assert.equal(timingSafeEqualString('short', 'longer-value'), false);
    assert.equal(timingSafeEqualString('longer-value', 'short'), false);
  });

  it('rejects empty strings', () => {
    assert.equal(timingSafeEqualString('', ''), false);
    assert.equal(timingSafeEqualString('', 'x'), false);
    assert.equal(timingSafeEqualString('x', ''), false);
  });
});

describe('DingTalk signature + freshness', () => {
  const secret = 'super-secret-token-value';

  it('accepts a fresh valid signature', () => {
    const timestamp = String(Date.now());
    const sign = crypto
      .createHmac('sha256', secret)
      .update(timestamp + '\n' + secret)
      .digest('base64');
    assert.equal(verifyDingTalkSignature(timestamp, sign, secret), true);
  });

  it('rejects a stale timestamp even with a valid HMAC', () => {
    const timestamp = String(Date.now() - 10 * 60 * 1000); // 10 min ago
    const sign = crypto
      .createHmac('sha256', secret)
      .update(timestamp + '\n' + secret)
      .digest('base64');
    assert.equal(verifyDingTalkSignature(timestamp, sign, secret), false);
  });

  it('rejects wrong signature of different length', () => {
    const timestamp = String(Date.now());
    assert.equal(verifyDingTalkSignature(timestamp, 'nope', secret), false);
  });
});

describe('Feishu-style token compare', () => {
  it('uses constant-time equal (not !==)', () => {
    const secret = 'feishu-verification-token-xyz';
    assert.equal(timingSafeEqualString(secret, secret), true);
    assert.equal(timingSafeEqualString(secret, 'wrong'), false);
    assert.equal(timingSafeEqualString(secret, secret + 'x'), false);
  });
});
