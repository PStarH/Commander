/**
 * Crypto helpers for IM webhook verification — length-safe timing compare,
 * DingTalk freshness, Feishu constant-time token check.
 *
 * Mirrors the private helpers in webhookEndpoints.ts (kept local so we can
 * unit-test without exporting production internals).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length === 0 || bBuf.length === 0) return false;
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const contentEq = crypto.timingSafeEqual(aPad, bPad);
  const lenA = Buffer.alloc(4);
  const lenB = Buffer.alloc(4);
  lenA.writeUInt32BE(aBuf.length);
  lenB.writeUInt32BE(bBuf.length);
  const lengthEq = crypto.timingSafeEqual(lenA, lenB);
  return contentEq && lengthEq;
}

function isTimestampFresh(timestamp: string, unit: 'ms' | 's', maxSkewSec = 300): boolean {
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return false;
  const tsMs = unit === 'ms' ? n : n * 1000;
  return Math.abs(Date.now() - tsMs) <= maxSkewSec * 1000;
}

function verifyDingTalkSignature(timestamp: string, sign: string, secret: string): boolean {
  if (!isTimestampFresh(timestamp, 'ms')) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(timestamp + '\n' + secret)
    .digest('base64');
  return timingSafeEqualString(expected, sign);
}

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
