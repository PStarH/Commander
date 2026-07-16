/**
 * WeCom webhook signature enforcement (P0.4) — source contract + helper tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function verifyWeComSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
  msgSignature: string,
): boolean {
  const parts = [token, timestamp, nonce, encrypt].sort();
  const sha1 = crypto.createHash('sha1').update(parts.join('')).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sha1), Buffer.from(msgSignature));
}

describe('WeCom webhook P0.4 contract', () => {
  it('source requires complete signature params and timestamp window', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/webhookEndpoints.ts'),
      'utf-8',
    );
    assert.match(src, /Missing signature parameters/);
    assert.match(src, /Invalid or stale timestamp/);
    assert.match(src, /Math\.abs\(Date\.now\(\) \/ 1000 - tsNum\) > 300/);
    assert.doesNotMatch(src, /if \(msgSignature && timestamp && nonce && encrypt\)/);
  });

  it('signature helper verifies correctly', () => {
    const token = 'tok';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'n1';
    const encrypt = 'enc';
    const parts = [token, timestamp, nonce, encrypt].sort();
    const sig = crypto.createHash('sha1').update(parts.join('')).digest('hex');
    assert.equal(verifyWeComSignature(token, timestamp, nonce, encrypt, sig), true);
    assert.equal(verifyWeComSignature(token, timestamp, nonce, encrypt, '0'.repeat(40)), false);
  });
});
