import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeOutgoingWebhookUrl } from '../src/outgoingWebhookEndpoints';

describe('outgoing webhook SSRF guard', () => {
  it('allows public https URLs', () => {
    assert.equal(isSafeOutgoingWebhookUrl('https://hooks.example.com/webhook'), true);
    assert.equal(isSafeOutgoingWebhookUrl('http://api.example.org/events'), true);
  });

  it('rejects localhost and loopback', () => {
    assert.equal(isSafeOutgoingWebhookUrl('http://localhost/hook'), false);
    assert.equal(isSafeOutgoingWebhookUrl('http://127.0.0.1/hook'), false);
    assert.equal(isSafeOutgoingWebhookUrl('http://[::1]/hook'), false);
  });

  it('rejects private RFC1918 ranges', () => {
    assert.equal(isSafeOutgoingWebhookUrl('http://10.0.0.5/hook'), false);
    assert.equal(isSafeOutgoingWebhookUrl('http://172.16.1.1/hook'), false);
    assert.equal(isSafeOutgoingWebhookUrl('http://192.168.1.10/hook'), false);
  });

  it('rejects cloud metadata endpoints', () => {
    assert.equal(isSafeOutgoingWebhookUrl('http://169.254.169.254/latest/meta-data'), false);
    assert.equal(
      isSafeOutgoingWebhookUrl('http://metadata.google.internal/computeMetadata/v1/'),
      false,
    );
  });

  it('rejects non-http schemes', () => {
    assert.equal(isSafeOutgoingWebhookUrl('file:///etc/passwd'), false);
    assert.equal(isSafeOutgoingWebhookUrl('ftp://example.com/hook'), false);
  });
});
