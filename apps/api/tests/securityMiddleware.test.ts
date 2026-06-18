import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeError,
  sanitizeString,
  isNonEmptyString,
  isValidUUID,
  isValidProjectId,
} from '../src/securityMiddleware';

describe('securityMiddleware', () => {
  describe('sanitizeError', () => {
    it('returns 400 for ValifyError', () => {
      const err = new Error('validation failed');
      err.name = 'ValifyError';
      const result = sanitizeError(err, 'req-123');
      assert.equal(result.status, 400);
      assert.equal(result.message, 'Validation error');
      assert.equal(result.requestId, 'req-123');
    });

    it('returns 400 for JSON parse errors', () => {
      const err = new Error('Unexpected token in JSON at position 0');
      const result = sanitizeError(err);
      assert.equal(result.status, 400);
      assert.equal(result.message, 'Invalid JSON in request body');
    });

    it('returns 413 for body too large', () => {
      const err = new Error('request entity too large') as Error & { type?: string };
      err.type = 'entity.too.large';
      const result = sanitizeError(err);
      assert.equal(result.status, 413);
      assert.equal(result.message, 'Request body too large');
    });

    it('returns 500 for unknown errors without leaking details', () => {
      const err = new Error('internal database connection string: postgres://user:pass@host/db');
      const result = sanitizeError(err, 'req-456');
      assert.equal(result.status, 500);
      assert.equal(result.message, 'Internal server error');
      assert.equal(result.requestId, 'req-456');
      // Must NOT contain the original error message
      assert.ok(!result.message.includes('database'));
    });

    it('handles errors without message', () => {
      const err = new Error();
      const result = sanitizeError(err);
      assert.equal(result.status, 500);
      assert.equal(result.message, 'Internal server error');
    });

    it('includes requestId when provided', () => {
      const err = new Error('test');
      const result = sanitizeError(err, 'abc-123');
      assert.equal(result.requestId, 'abc-123');
    });

    it('requestId is undefined when not provided', () => {
      const err = new Error('test');
      const result = sanitizeError(err);
      assert.equal(result.requestId, undefined);
    });
  });

  describe('sanitizeString', () => {
    it('returns empty string for non-string input', () => {
      assert.equal(sanitizeString(null), '');
      assert.equal(sanitizeString(undefined), '');
      assert.equal(sanitizeString(123), '');
      assert.equal(sanitizeString({}), '');
    });

    it('strips control characters', () => {
      const input = 'hello\x00\x01\x02world';
      assert.equal(sanitizeString(input), 'helloworld');
    });

    it('preserves tabs, newlines, and carriage returns', () => {
      const input = 'hello\tworld\n\r';
      assert.equal(sanitizeString(input), 'hello\tworld\n\r');
    });

    it('truncates to maxLength', () => {
      const input = 'a'.repeat(20000);
      assert.equal(sanitizeString(input, 100).length, 100);
    });

    it('uses default maxLength of 10000', () => {
      const input = 'a'.repeat(15000);
      assert.equal(sanitizeString(input).length, 10000);
    });

    it('does not truncate strings within limit', () => {
      const input = 'short string';
      assert.equal(sanitizeString(input), 'short string');
    });
  });

  describe('isNonEmptyString', () => {
    it('returns true for non-empty strings', () => {
      assert.equal(isNonEmptyString('hello'), true);
      assert.equal(isNonEmptyString('a'), true);
    });

    it('returns false for empty or whitespace strings', () => {
      assert.equal(isNonEmptyString(''), false);
      assert.equal(isNonEmptyString('   '), false);
      assert.equal(isNonEmptyString('\t'), false);
    });

    it('returns false for non-string types', () => {
      assert.equal(isNonEmptyString(null), false);
      assert.equal(isNonEmptyString(undefined), false);
      assert.equal(isNonEmptyString(0), false);
      assert.equal(isNonEmptyString(false), false);
    });
  });

  describe('isValidUUID', () => {
    it('validates correct UUID v4', () => {
      assert.equal(isValidUUID('550e8400-e29b-41d4-a716-446655440000'), true);
      assert.equal(isValidUUID('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'), true);
    });

    it('rejects invalid UUIDs', () => {
      assert.equal(isValidUUID('not-a-uuid'), false);
      assert.equal(isValidUUID('550e8400-e29b-41d4-a716'), false); // too short
      assert.equal(isValidUUID('550e8400-e29b-41d4-a716-446655440000-extra'), false); // too long
      assert.equal(isValidUUID(''), false);
    });

    it('rejects non-string types', () => {
      assert.equal(isValidUUID(null), false);
      assert.equal(isValidUUID(undefined), false);
      assert.equal(isValidUUID(123), false);
    });

    it('is case-insensitive', () => {
      assert.equal(isValidUUID('550E8400-E29B-41D4-A716-446655440000'), true);
      assert.equal(isValidUUID('550e8400-e29b-41d4-a716-446655440000'), true);
    });
  });

  describe('isValidProjectId', () => {
    it('validates alphanumeric project IDs', () => {
      assert.equal(isValidProjectId('my-project'), true);
      assert.equal(isValidProjectId('project_123'), true);
      assert.equal(isValidProjectId('ABC'), true);
    });

    it('rejects empty strings', () => {
      assert.equal(isValidProjectId(''), false);
      assert.equal(isValidProjectId('   '), false);
    });

    it('rejects strings with special characters', () => {
      assert.equal(isValidProjectId('project/name'), false);
      assert.equal(isValidProjectId('project name'), false);
      assert.equal(isValidProjectId('project@name'), false);
    });

    it('rejects strings over 100 characters', () => {
      assert.equal(isValidProjectId('a'.repeat(101)), false);
      assert.equal(isValidProjectId('a'.repeat(100)), true);
    });

    it('rejects non-string types', () => {
      assert.equal(isValidProjectId(null), false);
      assert.equal(isValidProjectId(undefined), false);
      assert.equal(isValidProjectId(123), false);
    });
  });
});
