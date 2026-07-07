import { describe, it, expect, beforeEach } from 'vitest';
import {
  UniversalSanitizer,
  ResourceGovernor,
  IntegrityLayer,
  StateContract,
  getSecurityPrimitives,
  resetSecurityPrimitives,
} from '../../src/security/securityPrimitives';

describe('SecurityPrimitives', () => {
  describe('UniversalSanitizer', () => {
    const sanitizer = new UniversalSanitizer();

    it('scrubs PII from all contexts', () => {
      const input = 'my key is sk-abcd1234567890123456789012';
      const result = sanitizer.sanitize(input, 'output');
      expect(result.sanitized).toContain('[REDACTED]');
      expect(result.sanitized).not.toContain('sk-abcd1234567890123456789012');
      expect(result.modified).toBe(true);
      expect(result.patterns).toContain('api_key');
    });

    it('scrubs JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4f';
      const result = sanitizer.sanitize(jwt, 'output');
      expect(result.sanitized).toContain('[JWT_REDACTED]');
      expect(result.patterns).toContain('jwt');
    });

    it('scrubs PEM private keys', () => {
      const pem =
        '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----';
      const result = sanitizer.sanitize(pem, 'output');
      expect(result.sanitized).toContain('[PEM_REDACTED]');
      expect(result.patterns).toContain('pem_key');
    });

    it('scrubs email addresses', () => {
      const result = sanitizer.sanitize('contact: user@example.com', 'output');
      expect(result.sanitized).toContain('[EMAIL_REDACTED]');
      expect(result.patterns).toContain('email');
    });

    it('scrubs SSN', () => {
      const result = sanitizer.sanitize('SSN: 123-45-6789', 'output');
      expect(result.sanitized).toContain('[SSN_REDACTED]');
    });

    it('strips XSS from input context', () => {
      const result = sanitizer.sanitize('<script>alert("xss")</script>hello', 'input');
      expect(result.sanitized).not.toContain('<script>');
      expect(result.patterns).toContain('script_tag');
    });

    it('strips event handlers from input context', () => {
      const result = sanitizer.sanitize('<div onclick="evil()">text</div>', 'input');
      expect(result.sanitized).not.toContain('onclick');
    });

    it('strips path traversal from filename context', () => {
      const result = sanitizer.sanitize('../../etc/passwd', 'filename');
      expect(result.sanitized).not.toContain('..');
      expect(result.patterns).toContain('path_traversal');
    });

    it('strips unsafe chars from identifier context', () => {
      const result = sanitizer.sanitize('file name;rm -rf', 'identifier');
      expect(result.sanitized).not.toContain(';');
      expect(result.patterns).toContain('unsafe_identifier_chars');
    });

    it('sanitizes channel text: strips @mentions and URLs', () => {
      const result = sanitizer.sanitize('Hey @channel check https://evil.com', 'channel_text');
      expect(result.sanitized).not.toContain('@channel');
      expect(result.sanitized).not.toContain('https://evil.com');
      expect(result.patterns).toContain('channel_mention');
      expect(result.patterns).toContain('url_stripped');
    });

    it('caps channel text length at 500 chars', () => {
      const long = 'a'.repeat(600);
      const result = sanitizer.sanitize(long, 'channel_text');
      expect(result.sanitized.length).toBe(500);
      expect(result.patterns).toContain('length_capped');
    });

    it('sanitizeObject recursively sanitizes nested objects', () => {
      const obj = {
        name: 'user@example.com',
        nested: {
          key: 'sk-abcd1234567890123456789012',
          list: ['ghp_1234567890abcdef1234567890abcdef12345678', 'safe text'],
        },
      };
      const result = sanitizer.sanitizeObject(obj, 'output');
      expect(result.name).toContain('[EMAIL_REDACTED]');
      expect(result.nested.key).toContain('[REDACTED]');
      expect(result.nested.list[0]).toContain('[REDACTED]');
      expect(result.nested.list[1]).toBe('safe text');
    });

    it('returns unmodified for non-string input', () => {
      const result = sanitizer.sanitize(123 as unknown as string, 'output');
      expect(result.modified).toBe(false);
    });
  });

  describe('ResourceGovernor', () => {
    it('withTimeout resolves normally when function completes in time', async () => {
      const result = await ResourceGovernor.withTimeout(async () => 42, 1000);
      expect(result).toBe(42);
    });

    it('withTimeout rejects when function exceeds timeout', async () => {
      await expect(
        ResourceGovernor.withTimeout(
          async () => new Promise((resolve) => setTimeout(resolve, 200)),
          50,
        ),
      ).rejects.toThrow('TIMEOUT');
    });

    it('withSizeCap rejects oversized input', async () => {
      await expect(
        ResourceGovernor.withSizeCap(
          async () => 'ok',
          10,
          'this input is way too long for the limit',
        ),
      ).rejects.toThrow('PAYLOAD_TOO_LARGE');
    });

    it('withSizeCap rejects oversized output', async () => {
      await expect(ResourceGovernor.withSizeCap(async () => 'a'.repeat(1000), 100)).rejects.toThrow(
        'PAYLOAD_TOO_LARGE',
      );
    });

    it('govern returns structured result on success', async () => {
      const result = await ResourceGovernor.govern(async () => 'success', {
        timeoutMs: 1000,
        maxPayloadBytes: 1000,
      });
      expect(result.result).toBe('success');
      expect(result.timedOut).toBe(false);
      expect(result.oversize).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it('govern returns structured result on timeout', async () => {
      const result = await ResourceGovernor.govern(
        async () => new Promise((resolve) => setTimeout(resolve, 200)),
        { timeoutMs: 50 },
      );
      expect(result.result).toBeNull();
      expect(result.timedOut).toBe(true);
      expect(result.error).toContain('TIMEOUT');
    });

    it('govern returns structured result on oversize', async () => {
      const result = await ResourceGovernor.govern(async () => 'a'.repeat(1000), {
        maxPayloadBytes: 100,
      });
      expect(result.result).toBeNull();
      expect(result.oversize).toBe(true);
    });
  });

  describe('IntegrityLayer', () => {
    let layer: IntegrityLayer;

    beforeEach(() => {
      layer = new IntegrityLayer('test-secret-key');
    });

    it('signs and verifies data correctly', () => {
      const data = { id: 'gap-001', title: 'Test gap', severity: 'high' };
      const signed = layer.sign(data);
      expect(signed._sig).toHaveLength(64); // hex SHA-256
      expect(signed._ts).toBeGreaterThan(0);
      expect(layer.verify(signed)).toBe(true);
    });

    it('fails verification when data is tampered', () => {
      const data = { id: 'gap-001', title: 'Test gap' };
      const signed = layer.sign(data);
      // Tamper with the data
      signed.data.title = 'Tampered title';
      expect(layer.verify(signed)).toBe(false);
    });

    it('fails verification when signature is wrong', () => {
      const signed = {
        data: { id: 'test', _ts: Date.now() },
        _sig: 'a'.repeat(64),
        _ts: Date.now(),
      };
      expect(layer.verify(signed)).toBe(false);
    });

    it('requireFields passes when all fields present', () => {
      const data = { id: 'gap-001', title: 'Test', regressionTestIds: ['test-1'] };
      expect(() => layer.requireFields(data, ['id', 'title', 'regressionTestIds'])).not.toThrow();
    });

    it('requireFields throws when field is missing', () => {
      const data = { id: 'gap-001', title: 'Test' };
      expect(() => layer.requireFields(data, ['regressionTestIds'])).toThrow('INTEGRITY_VIOLATION');
    });

    it('requireFields throws when field is null', () => {
      const data = { id: 'gap-001', title: null };
      expect(() => layer.requireFields(data, ['title'])).toThrow('INTEGRITY_VIOLATION');
    });
  });

  describe('StateContract', () => {
    it('useScope commits on success', async () => {
      let committed = false;
      let rolledBack = false;
      const result = await StateContract.useScope(
        () => ({
          state: { value: 0 },
          commit: () => {
            committed = true;
          },
          rollback: () => {
            rolledBack = true;
          },
        }),
        async (state) => {
          state.value = 42;
        },
      );
      expect(result.committed).toBe(true);
      expect(committed).toBe(true);
      expect(rolledBack).toBe(false);
    });

    it('useScope rolls back on error', async () => {
      let committed = false;
      let rolledBack = false;
      const result = await StateContract.useScope(
        () => ({
          state: { value: 0 },
          commit: () => {
            committed = true;
          },
          rollback: () => {
            rolledBack = true;
          },
        }),
        async () => {
          throw new Error('fail');
        },
      );
      expect(result.committed).toBe(false);
      expect(committed).toBe(false);
      expect(rolledBack).toBe(true);
      expect(result.error).toBe('fail');
    });

    it('useDisarmScope always calls disarm', async () => {
      let armed = false;
      let disarmed = false;

      const result = await StateContract.useDisarmScope(
        () => {
          armed = true;
        },
        () => {
          disarmed = true;
        },
        async () => {
          /* success */
        },
      );
      expect(armed).toBe(true);
      expect(disarmed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('useDisarmScope calls disarm even on error', async () => {
      let disarmed = false;

      const result = await StateContract.useDisarmScope(
        () => {},
        () => {
          disarmed = true;
        },
        async () => {
          throw new Error('fail');
        },
      );
      expect(disarmed).toBe(true);
      expect(result.error).toBe('fail');
    });
  });

  describe('getSecurityPrimitives', () => {
    it('returns unified facade with all 4 primitives', () => {
      resetSecurityPrimitives();
      const primitives = getSecurityPrimitives('test-secret');
      expect(primitives.sanitizer).toBeInstanceOf(UniversalSanitizer);
      expect(primitives.governor).toBe(ResourceGovernor);
      expect(primitives.integrity).toBeInstanceOf(IntegrityLayer);
      expect(primitives.stateContract).toBe(StateContract);
    });

    it('returns same instance on subsequent calls', () => {
      resetSecurityPrimitives();
      const p1 = getSecurityPrimitives();
      const p2 = getSecurityPrimitives();
      expect(p1).toBe(p2);
    });
  });
});
