// packages/core/tests/shadow/scrubber.test.ts
import { describe, it, expect } from 'vitest';
import { scrubRequest, redactPii, DEFAULT_IGNORE_FIELDS } from '../../src/shadow/scrubber';

describe('scrubber', () => {
  it('redacts Authorization header', () => {
    const result = scrubRequest(
      { headers: { Authorization: 'Bearer secret' } },
      DEFAULT_IGNORE_FIELDS,
    );
    expect(result.headers['Authorization']).toBe('[REDACTED]');
  });

  it('preserves non-sensitive headers', () => {
    const result = scrubRequest(
      { headers: { 'content-type': 'application/json' } },
      DEFAULT_IGNORE_FIELDS,
    );
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('redactPii removes emails', () => {
    const result = redactPii('Contact me at user@example.com');
    expect(result).not.toContain('user@example.com');
  });

  it('redactPii removes phone numbers', () => {
    const result = redactPii('Call +1-555-123-4567');
    expect(result).not.toContain('555-123-4567');
  });

  it('redactPii removes OpenAI keys', () => {
    const result = redactPii('My key is sk-abcdefghijklmnopqrstuvwxyz');
    expect(result).toContain('sk-[REDACTED]');
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts sensitive field names in object bodies', () => {
    const result = scrubRequest(
      {
        headers: { 'content-type': 'application/json' },
        body: {
          password: 'mysecret123',
          api_key: 'raw-secret',
          nested: { token: 'tok-abc', safe: 'ok' },
          user: 'alice',
        },
      },
      DEFAULT_IGNORE_FIELDS,
    );
    expect(result.body).toEqual({
      password: '[REDACTED]',
      api_key: '[REDACTED]',
      nested: { token: '[REDACTED]', safe: 'ok' },
      user: 'alice',
    });
  });

  it('redacts password fields inside JSON string bodies', () => {
    const result = scrubRequest(
      {
        headers: {},
        body: '{"password":"mysecret123","note":"hello"}',
      },
      DEFAULT_IGNORE_FIELDS,
    );
    expect(typeof result.body).toBe('string');
    const parsed = JSON.parse(result.body as string);
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.note).toBe('hello');
    expect(result.body as string).not.toContain('mysecret123');
  });
});
