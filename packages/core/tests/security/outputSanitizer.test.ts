import { describe, it, expect, beforeEach } from 'vitest';
import {
  OutputSanitizer,
  resetOutputSanitizer,
  sanitizeOutput,
  sanitizeIfNeeded,
  type SensitivityCategory,
  type RedactionStrategy,
} from '../../src/security/outputSanitizer';

describe('OutputSanitizer', () => {
  let sanitizer: OutputSanitizer;

  beforeEach(() => {
    resetOutputSanitizer();
    sanitizer = new OutputSanitizer();
  });

  describe('basic functionality', () => {
    it('returns clean output unchanged', () => {
      const result = sanitizer.sanitize('Hello, this is normal text.');
      expect(result.redacted).toBe(false);
      expect(result.sanitized).toBe('Hello, this is normal text.');
      expect(result.redactionCount).toBe(0);
    });

    it('handles empty input', () => {
      const result = sanitizer.sanitize('');
      expect(result.redacted).toBe(false);
      expect(result.sanitized).toBe('');
    });

    it('handles null-ish input gracefully', () => {
      const result = sanitizer.sanitize('');
      expect(result.redacted).toBe(false);
    });

    it('respects enabled: false', () => {
      const disabled = new OutputSanitizer({ enabled: false });
      const result = disabled.sanitize('sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result.redacted).toBe(false);
      expect(result.sanitized).toContain('sk-proj');
    });
  });

  describe('API key redaction', () => {
    it('redacts OpenAI API keys', () => {
      const result = sanitizer.sanitize('My API key is sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).not.toContain('sk-proj-abc');
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('redacts Anthropic API keys', () => {
      const result = sanitizer.sanitize('Key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('redacts Google API keys', () => {
      const result = sanitizer.sanitize('AIzaSyD8lS0pX9qR5tU2vW4yB6nM1kO3cA7hJ0fL');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('redacts GitHub tokens (classic)', () => {
      const result = sanitizer.sanitize('ghp_1A2b3C4d5E6f7G8h9I0j1K2l3M4n5O6p7Q8r9S0t');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('redacts GitHub server-to-server tokens', () => {
      const result = sanitizer.sanitize('ghs_abcdefghijklmnopqrstuvwxyz1234567890');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('redacts HuggingFace tokens', () => {
      const result = sanitizer.sanitize('hf_abcdefghijklmnopqrstuvwxyz12345678901234');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('redacts Slack tokens', () => {
      const result = sanitizer.sanitize('xoxb-1234567890abcdefghijklmnopqrstuv');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('redacts Stripe keys', () => {
      const result = sanitizer.sanitize('sk_test_abcdefghijklmnopqrstuvwxyz1234');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });
  });

  describe('cloud credential redaction', () => {
    it('redacts AWS access key IDs', () => {
      const result = sanitizer.sanitize('AWS key: AKIAIOSFODNN7EXAMPLE');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:cloud-credential]');
    });

    it('redacts AWS STS temporary keys', () => {
      const result = sanitizer.sanitize('ASIA1234567890ABCDEF');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:cloud-credential]');
    });

    it('redacts AWS credential config lines', () => {
      const result = sanitizer.sanitize('aws_access_key_id = AKIA1234567890ABCDEF');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:cloud-credential]');
    });

    it('redacts Azure client secrets', () => {
      const result = sanitizer.sanitize('AZURE_CLIENT_SECRET = superSecret123!@#');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:cloud-credential]');
    });
  });

  describe('connection string redaction', () => {
    it('redacts MongoDB connection strings', () => {
      const result = sanitizer.sanitize(
        'mongodb://admin:password@db.example.com:27017/mydb?authSource=admin',
      );
      expect(result.redacted).toBe(true);
      expect(result.sanitized).not.toContain('mongodb://');
      expect(result.sanitized).toContain('...');
    });

    it('redacts PostgreSQL connection strings', () => {
      const result = sanitizer.sanitize(
        'postgresql://user:pass@localhost:5432/mydb',
      );
      expect(result.redacted).toBe(true);
    });

    it('redacts Redis connection strings', () => {
      const result = sanitizer.sanitize('redis://:password@redis.example.com:6379/0');
      expect(result.redacted).toBe(true);
    });

    it('redacts DATABASE_URL assignments', () => {
      const result = sanitizer.sanitize(
        'DATABASE_URL = "postgresql://user:pass@db.internal:5432/prod"',
      );
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:connection-string]');
    });
  });

  describe('private key redaction', () => {
    it('removes RSA private key blocks entirely', () => {
      const output = `Some text before
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3x...
-----END RSA PRIVATE KEY-----
Some text after`;
      const result = sanitizer.sanitize(output);
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('Some text before');
      expect(result.sanitized).toContain('Some text after');
      expect(result.sanitized).not.toContain('BEGIN RSA PRIVATE KEY');
    });

    it('removes EC private key blocks', () => {
      const output = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEII...
-----END EC PRIVATE KEY-----`;
      const result = sanitizer.sanitize(output);
      expect(result.redacted).toBe(true);
      expect(result.sanitized).not.toContain('BEGIN EC PRIVATE KEY');
    });

    it('partially redacts SSH public keys', () => {
      const keyBody = 'AAAAB3NzaC1yc2EAAAADAQABAAABAQC8' + 'a'.repeat(150);
      const output = 'ssh-rsa ' + keyBody;
      const result = sanitizer.sanitize(output);
      expect(result.redacted).toBe(true);
      expect(result.sanitized).not.toContain('AAAAB3Nza');
    });
  });

  describe('JWT redaction', () => {
    it('partially redacts JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = sanitizer.sanitize(jwt);
      expect(result.redacted).toBe(true);
      expect(result.sanitized).not.toContain(jwt);
    });

    it('redacts Bearer JWT in auth headers', () => {
      const output = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummySignature1234567890abcdefghijklmnopqrstuvwxyz';
      const result = sanitizer.sanitize(output);
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:jwt-token]');
    });
  });

  describe('internal IP redaction', () => {
    it('redacts class A private IPs', () => {
      const result = sanitizer.sanitize('Server at 10.0.1.25 responded');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:internal-ip]');
    });

    it('redacts class B private IPs', () => {
      const result = sanitizer.sanitize('Connecting to 172.16.100.5');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:internal-ip]');
    });

    it('redacts class C private IPs', () => {
      const result = sanitizer.sanitize('Found host at 192.168.1.100');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:internal-ip]');
    });

    it('masks loopback IPs', () => {
      const result = sanitizer.sanitize('Listening on 127.0.0.1:3000');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:internal-ip]');
    });

    it('does not redact public IPs', () => {
      const result = sanitizer.sanitize('API at 203.0.113.42 responded');
      expect(result.redacted).toBe(false);
    });
  });

  describe('PII redaction', () => {
    it('partially redacts email addresses', () => {
      const result = sanitizer.sanitize('Contact: john.doe@example.com for support');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).not.toContain('john.doe@example.com');
    });

    it('masks US phone numbers', () => {
      const result = sanitizer.sanitize('Call 555-123-4567 for help');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:pii]');
    });

    it('masks US SSNs', () => {
      const result = sanitizer.sanitize('SSN: 123-45-6789');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:pii]');
    });

    it('masks credit card numbers', () => {
      const result = sanitizer.sanitize('Card: 4111-1111-1111-1111');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:pii]');
    });
  });

  describe('password and secret redaction', () => {
    it('redacts password assignments', () => {
      const result = sanitizer.sanitize('password = "superSecret123!"');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:password-secret]');
    });

    it('redacts secret key assignments', () => {
      const result = sanitizer.sanitize('SECRET_KEY = "abcdefghijklmnop"');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:password-secret]');
    });

    it('redacts token assignments', () => {
      const result = sanitizer.sanitize('API_TOKEN = "tok_abcdefghijklmnop"');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:password-secret]');
    });

    it('redacts Authorization header values', () => {
      const result = sanitizer.sanitize('Authorization: Basic dXNlcjpwYXNzd29yZA==');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:password-secret]');
    });
  });

  describe('base64 blob redaction', () => {
    it('removes large base64 blobs', () => {
      const blob = 'A'.repeat(250);
      const output = `File contents:\n${blob}\nEnd of file`;
      const result = sanitizer.sanitize(output);
      expect(result.redacted).toBe(true);
      expect(result.sanitized).not.toContain(blob);
    });

    it('does not remove short base64 strings', () => {
      const result = sanitizer.sanitize('Short: dXNlcjpwYXNz');
      expect(result.redacted).toBe(false);
    });
  });

  describe('multiple categories', () => {
    it('handles multiple sensitive types in one output', () => {
      const output = `
Configuration:
  API Key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx
  Database: postgresql://admin:secret@10.0.1.50:5432/production
  Admin: admin@company.com
  Internal IP: 192.168.1.100
      `;
      const result = sanitizer.sanitize(output);
      expect(result.redacted).toBe(true);
      expect(result.redactionCount).toBeGreaterThanOrEqual(4);
      // Each category should appear in records
      const categories = result.records.map((r) => r.category);
      expect(categories).toContain('api_key');
      expect(categories).toContain('connection_string');
      expect(categories).toContain('internal_ip');
      expect(categories).toContain('pii');
    });

    it('returns correct total redaction count', () => {
      const output = 'Key1: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx\nKey2: sk-proj-zyx987wvu654tsr321qpo098nml765kji432hgf';
      const result = sanitizer.sanitize(output);
      expect(result.redactionCount).toBe(2);
    });
  });

  describe('containsSensitiveData', () => {
    it('returns true when sensitive data is present', () => {
      expect(sanitizer.containsSensitiveData('sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx')).toBe(true);
    });

    it('returns false for clean content', () => {
      expect(sanitizer.containsSensitiveData('Hello, this is normal text.')).toBe(false);
    });
  });

  describe('categorizeSensitiveData', () => {
    it('returns correct categories', () => {
      const output = 'Key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx\nDB: mongodb://localhost\nEmail: test@example.com';
      const categories = sanitizer.categorizeSensitiveData(output);
      expect(categories).toContain('api_key');
      expect(categories).toContain('connection_string');
      expect(categories).toContain('pii');
    });
  });

  describe('sanitizeToolResults', () => {
    it('sanitizes a batch of tool results', () => {
      const results = [
        { toolCallId: '1', name: 'file_read', output: 'Found key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx', durationMs: 10 },
        { toolCallId: '2', name: 'web_fetch', output: 'Page loaded ok', durationMs: 20 },
        { toolCallId: '3', name: 'shell_execute', output: 'DB at mongodb://admin:pass@10.0.1.1/db', durationMs: 30 },
      ];
      const batch = sanitizer.sanitizeToolResults(results);
      expect(batch.totalRedacted).toBeGreaterThanOrEqual(2);
      expect(batch.results[0].output).toContain('[REDACTED:api-key]');
      expect(batch.results[1].output).toBe('Page loaded ok');
      expect(batch.results[2].output).not.toContain('mongodb://');
    });

    it('preserves error fields without sanitization', () => {
      const results = [
        { toolCallId: '1', name: 'shell', output: '', error: 'Command failed with exit code 1', durationMs: 10 },
      ];
      const batch = sanitizer.sanitizeToolResults(results);
      expect(batch.results[0].error).toBe('Command failed with exit code 1');
    });
  });

  describe('convenience functions', () => {
    it('sanitizeOutput returns sanitized string', () => {
      const output = sanitizeOutput('My key is sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(output).not.toContain('sk-proj-abc');
      expect(output).toContain('[REDACTED:api-key]');
    });

    it('sanitizeIfNeeded returns clean output unchanged', () => {
      const result = sanitizeIfNeeded('Hello world');
      expect(result.output).toBe('Hello world');
      expect(result.wasRedacted).toBe(false);
      expect(result.categories).toEqual([]);
    });

    it('sanitizeIfNeeded redacts when sensitive data present', () => {
      const result = sanitizeIfNeeded('Key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result.wasRedacted).toBe(true);
      expect(result.categories).toContain('api_key');
    });
  });

  describe('configuration', () => {
    it('respects skipCategories', () => {
      const config = new OutputSanitizer({ skipCategories: ['api_key'] });
      const result = config.sanitize('sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result.redacted).toBe(false);
    });

    it('respects strategyOverrides with hash strategy', () => {
      const config = new OutputSanitizer({
        strategyOverrides: { api_key: 'hash' },
      });
      const result = config.sanitize('sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result.sanitized).toContain('[REDACTED:api-key:');
    });

    it('respects strategyOverrides with remove strategy', () => {
      const config = new OutputSanitizer({
        strategyOverrides: { api_key: 'remove' },
      });
      const result = config.sanitize('Prefix sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx suffix');
      expect(result.sanitized).toBe('Prefix  suffix');
    });

    it('respects maxOutputLength for truncation', () => {
      const config = new OutputSanitizer({ maxOutputLength: 50 });
      const longOutput = 'x'.repeat(200);
      const result = config.sanitize(longOutput);
      expect(result.sanitized.length).toBeLessThan(200);
    });

    it('reconfigure updates rules at runtime', () => {
      const result1 = sanitizer.sanitize('sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result1.redacted).toBe(true);

      sanitizer.reconfigure({ skipCategories: ['api_key'] });
      const result2 = sanitizer.sanitize('sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result2.redacted).toBe(false);
    });
  });

  describe('output hash', () => {
    it('generates SHA-256 hash of sanitized output', () => {
      const result = sanitizer.sanitize('Hello world');
      expect(result.outputHash).toBeTruthy();
      expect(result.outputHash.length).toBe(64);
    });

    it('generates same hash for same sanitized output', () => {
      const output = 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx anotherKey sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx';
      const r1 = sanitizer.sanitize(output);
      resetOutputSanitizer();
      const s2 = new OutputSanitizer();
      const r2 = s2.sanitize(output);
      expect(r1.outputHash).toBe(r2.outputHash);
    });

    it('respects hashOutput: false', () => {
      const config = new OutputSanitizer({ hashOutput: false });
      const result = config.sanitize('Hello');
      expect(result.outputHash).toBe('');
    });
  });

  describe('duration tracking', () => {
    it('tracks sanitization duration', () => {
      const result = sanitizer.sanitize('Hello world');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('edge cases', () => {
    it('handles output with only sensitive data', () => {
      const result = sanitizer.sanitize('sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx');
      expect(result.redacted).toBe(true);
      expect(result.sanitized).toContain('[REDACTED:api-key]');
    });

    it('handles overlapping patterns correctly', () => {
      // Database connection strings contain internal IPs and credentials
      const result = sanitizer.sanitize('postgresql://admin:pass@10.0.1.50:5432/db');
      expect(result.redacted).toBe(true);
      // Connection string pattern should catch the whole URI first
    });

    it('handles very long output efficiently', () => {
      const long = 'Normal text. '.repeat(1000) + 'sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx';
      const result = sanitizer.sanitize(long);
      expect(result.redacted).toBe(true);
      expect(result.durationMs).toBeLessThan(5000); // Should be fast
    });

    it('does not redact partial matches', () => {
      // sk- followed by fewer than 20 chars should not match
      const result = sanitizer.sanitize('sk-short');
      expect(result.redacted).toBe(false);
    });
  });
});
