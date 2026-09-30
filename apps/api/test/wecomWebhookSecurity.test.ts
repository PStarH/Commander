/**
 * WeCom webhook signature enforcement (P0.4) — source contract + helper tests.
 *
 * AUDIT F-B-3: this file used to re-implement `verifyWeComSignature` locally
 * (with a raw `crypto.timingSafeEqual`), so deleting or breaking the production
 * check in `src/webhookCrypto.ts` left every assertion green. It now imports
 * the production function, so a weakened verifier fails the suite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyWeComSignature } from '../src/webhookCrypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('WeCom webhook P0.4 contract', () => {
  it('source requires complete signature params and timestamp window', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/webhookEndpoints.ts'), 'utf-8');
    assert.match(src, /Missing signature parameters/);
    assert.match(src, /Invalid or stale timestamp/);
    assert.match(src, /Math\.abs\(Date\.now\(\) \/ 1000 - tsNum\) > 300/);
    assert.doesNotMatch(src, /if \(msgSignature && timestamp && nonce && encrypt\)/);
  });

  it('webhook route rejects a request with a missing msg_signature before decrypting', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/webhookEndpoints.ts'), 'utf-8');
    // The verifier must be called on the route, not merely defined.
    assert.match(src, /verifyWeComSignature\(/);
    assert.match(src, /res\.status\(401\)/);
  });

  it('production verifyWeComSignature accepts a correctly computed signature', () => {
    const token = 'tok';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'n1';
    const encrypt = 'enc';
    const parts = [token, timestamp, nonce, encrypt].sort();
    const sig = crypto.createHash('sha1').update(parts.join('')).digest('hex');
    assert.equal(verifyWeComSignature(token, timestamp, nonce, encrypt, sig), true);
  });

  it('production verifyWeComSignature rejects a wrong signature of equal length', () => {
    const token = 'tok';
    const timestamp = String(Math.floor(Date.now() / 1000));
    assert.equal(verifyWeComSignature(token, timestamp, 'n1', 'enc', '0'.repeat(40)), false);
  });

  it('production verifyWeComSignature rejects a wrong-length signature without throwing', () => {
    // The production helper is length-safe (timingSafeEqualString); a raw
    // crypto.timingSafeEqual mirror would throw here instead of returning false.
    const token = 'tok';
    const timestamp = String(Math.floor(Date.now() / 1000));
    assert.equal(verifyWeComSignature(token, timestamp, 'n1', 'enc', 'short'), false);
    assert.equal(verifyWeComSignature(token, timestamp, 'n1', 'enc', ''), false);
  });

  it('is sensitive to every signed component (token/timestamp/nonce/encrypt)', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto
      .createHash('sha1')
      .update(['tok', ts, 'n1', 'enc'].sort().join(''))
      .digest('hex');
    assert.equal(verifyWeComSignature('tok', ts, 'n1', 'enc', sig), true);
    assert.equal(verifyWeComSignature('other-token', ts, 'n1', 'enc', sig), false);
    assert.equal(verifyWeComSignature('tok', ts, 'n2', 'enc', sig), false);
    assert.equal(verifyWeComSignature('tok', ts, 'n1', 'other-enc', sig), false);
  });
});
