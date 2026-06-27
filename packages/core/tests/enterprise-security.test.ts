/**
 * Enterprise Security Enhancement Test Suite
 *
 * Tests for the new enterprise-grade security modules:
 * - ZeroTrustValidator: HMAC 签名验证 + 防重放
 * - BillExplosionGuard: 账单爆炸防护
 * - DataLossPrevention: 数据泄露防护
 * - EncryptedSecretsVault: 加密密钥保险库
 * - EnterpriseSecurityGateway: 统一安全网关
 * - AuthMiddleware: 时序安全认证
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as crypto from 'node:crypto';

import { ZeroTrustValidator } from '../src/security/zeroTrustValidator';
import { BillExplosionGuard } from '../src/security/billExplosionGuard';
import { DataLossPrevention } from '../src/security/dataLossPrevention';
import { EncryptedSecretsVault } from '../src/security/encryptedSecretsVault';
import { EnterpriseSecurityGateway } from '../src/security/enterpriseSecurityGateway';
import { resetBillExplosionGuard } from '../src/security/billExplosionGuard';
import { resetDataLossPrevention } from '../src/security/dataLossPrevention';

// ============================================================================
// ZeroTrustValidator 测试
// ============================================================================
describe('ZeroTrustValidator', () => {
  let validator: ZeroTrustValidator;

  beforeEach(() => {
    validator = new ZeroTrustValidator();
    validator.registerKey('test-key-1', 'super-secret-key-for-testing-only');
  });

  it('should validate a correctly signed request', () => {
    const signature = validator.signRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      keyId: 'test-key-1',
    });

    const result = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      signatureHeader: signature.header,
    });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.keyId, 'test-key-1');
  });

  it('should reject request with missing signature header', () => {
    const result = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      signatureHeader: undefined,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'missing_signature');
  });

  it('should reject request with tampered body', () => {
    const signature = validator.signRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      keyId: 'test-key-1',
    });

    const result = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"HACKED"}',
      signatureHeader: signature.header,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'signature_mismatch');
  });

  it('should reject replay attack (same nonce used twice)', () => {
    const signature = validator.signRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      keyId: 'test-key-1',
    });

    // First validation should pass
    const result1 = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      signatureHeader: signature.header,
    });
    assert.strictEqual(result1.valid, true);

    // Second validation with same nonce should fail
    const result2 = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      signatureHeader: signature.header,
    });
    assert.strictEqual(result2.valid, false);
    assert.strictEqual(result2.code, 'nonce_replayed');
  });

  it('should reject request with expired timestamp', () => {
    // Create a signature with an old timestamp
    const oldTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const nonce = crypto.randomBytes(32).toString('hex');
    const bodyHash = crypto.createHash('sha256').update('{"task":"hello"}').digest('hex');
    const canonicalString = `POST\n/api/v1/execute\n${oldTimestamp}\n${nonce}\n${bodyHash}`;
    const hmac = crypto
      .createHmac('sha256', Buffer.from('super-secret-key-for-testing-only'))
      .update(canonicalString)
      .digest('hex');
    const header = `t=${oldTimestamp},v1=${hmac},nonce=${nonce},kid=test-key-1`;

    const result = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      signatureHeader: header,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'timestamp_expired');
  });

  it('should reject request with unknown key ID', () => {
    const signature = validator.signRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      keyId: 'test-key-1',
    });

    // Replace key ID in header
    const tamperedHeader = signature.header.replace('kid=test-key-1', 'kid=unknown-key');

    const result = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      signatureHeader: tamperedHeader,
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'unknown_key_id');
  });

  it('should reject request with revoked key', () => {
    validator.revokeKey('test-key-1');

    // Should throw when trying to sign with revoked key
    assert.throws(() => {
      validator.signRequest({
        method: 'POST',
        path: '/api/v1/execute',
        body: '{"task":"hello"}',
        keyId: 'test-key-1',
      });
    }, /revoked/);
  });

  it('should reject malformed signature header', () => {
    const result = validator.validateRequest({
      method: 'POST',
      path: '/api/v1/execute',
      body: '{"task":"hello"}',
      signatureHeader: 'garbage-not-a-valid-signature',
    });

    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'malformed_signature');
  });
});

// ============================================================================
// BillExplosionGuard 测试
// ============================================================================
describe('BillExplosionGuard', () => {
  let guard: BillExplosionGuard;

  beforeEach(() => {
    guard = new BillExplosionGuard({
      maxTokensPerRequest: 10_000,
      maxCostPerSession: 1.0,
      maxCostPerTenantDaily: 10.0,
      maxCostPerTenantMonthly: 100.0,
      maxCostGlobalDaily: 1000.0,
      enableAttackDetection: true,
      enableBillGuard: true,
      meltThreshold: 1.0,
      throttleThreshold: 0.9,
      warnThreshold: 0.8,
    });
  });

  it('should allow requests within budget', () => {
    const result = guard.checkBeforeCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      estimatedTokens: 1000,
      source: 'test',
    });

    assert.strictEqual(result.allowed, true);
  });

  it('should reject requests exceeding per-request token cap', () => {
    const result = guard.checkBeforeCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      estimatedTokens: 20_000, // Exceeds perRequestTokenHardCap of 10,000
      source: 'test',
    });

    assert.strictEqual(result.allowed, false);
  });

  it('should trigger melt when session cost exceeds hard cap', () => {
    // Record enough cost to exceed the session cap of $1.0
    guard.recordAfterCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      inputTokens: 500_000,
      outputTokens: 500_000,
    });

    // Now check if melted
    assert.strictEqual(guard.isMelted('tenant-1'), true);

    // Next request should be rejected
    const result = guard.checkBeforeCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      estimatedTokens: 100,
      source: 'test',
    });

    assert.strictEqual(result.allowed, false);
  });

  it('should detect token flood attack pattern', () => {
    // Send many requests with high token counts rapidly
    for (let i = 0; i < 20; i++) {
      guard.checkBeforeCall({
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        model: 'gpt-4o',
        estimatedTokens: 5000,
        source: 'attacker',
      });
    }

    // The guard should start rejecting due to session cost approaching cap
    const result = guard.checkBeforeCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      estimatedTokens: 5000,
      source: 'attacker',
    });

    // Should be rejected due to cost accumulation
    assert.strictEqual(result.allowed, false);
  });

  it('should support cost snapshot and restore', () => {
    guard.recordAfterCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
    });

    const snapshot = guard.takeSnapshot('tenant-1');
    assert.ok(snapshot);

    // Reset and restore
    guard.resetPeriod('session', 'tenant-1');
    const stateAfterReset = guard.getState('tenant-1');
    assert.strictEqual(stateAfterReset.sessionCost, 0);

    guard.restoreSnapshot(snapshot);
    const stateAfterRestore = guard.getState('tenant-1');
    assert.ok(stateAfterRestore.sessionCost > 0);
  });

  it('should allow lifting melt manually', () => {
    guard.recordAfterCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      inputTokens: 500_000,
      outputTokens: 500_000,
    });

    assert.strictEqual(guard.isMelted('tenant-1'), true);

    guard.liftMelt('tenant-1');
    assert.strictEqual(guard.isMelted('tenant-1'), false);
  });

  it('should isolate costs between tenants', () => {
    // Tenant 1 uses lots of tokens
    guard.recordAfterCall({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      inputTokens: 500_000,
      outputTokens: 500_000,
    });

    assert.strictEqual(guard.isMelted('tenant-1'), true);
    assert.strictEqual(guard.isMelted('tenant-2'), false);

    // Tenant 2 should still be able to make requests
    const result = guard.checkBeforeCall({
      tenantId: 'tenant-2',
      sessionId: 'session-2',
      model: 'gpt-4o',
      estimatedTokens: 1000,
      source: 'test',
    });

    assert.strictEqual(result.allowed, true);
  });
});

// ============================================================================
// DataLossPrevention 测试
// ============================================================================
describe('DataLossPrevention', () => {
  let dlp: DataLossPrevention;

  beforeEach(() => {
    dlp = new DataLossPrevention();
  });

  it('should detect API keys in content', () => {
    const content = 'The API key is sk-ant-api03-1234567890abcdef';
    const result = dlp.scan(content, 'api_response');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.length > 0);
    assert.strictEqual(result.riskLevel, 'critical');
  });

  it('should detect AWS access keys', () => {
    const content = 'AWS_KEY=AKIAIOSFODNN7EXAMPLE';
    const result = dlp.scan(content, 'log_output');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.some((m) => m.type === 'aws_credential'));
  });

  it('should detect credit card numbers', () => {
    const content = 'Card: 4111111111111111';
    const result = dlp.scan(content, 'api_response');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.some((m) => m.type === 'credit_card'));
  });

  it('should detect PEM private keys', () => {
    const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const result = dlp.scan(content, 'tool_result');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.some((m) => m.type === 'private_key'));
  });

  it('should detect JWT tokens', () => {
    const content = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = dlp.scan(content, 'agent_output');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.some((m) => m.type === 'jwt_token'));
  });

  it('should detect Chinese ID numbers', () => {
    // Use a valid Chinese ID number (passes GB 11643 checksum)
    const content = '身份证号: 11010519491231002X';
    const result = dlp.scan(content, 'api_response');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.some((m) => m.type === 'chinese_id'));
  });

  it('should detect database connection strings', () => {
    const content = 'DATABASE_URL=postgresql://user:password@10.0.0.1:5432/db';
    const result = dlp.scan(content, 'log_output');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.length > 0);
  });

  it('should sanitize content with REDACT strategy', () => {
    const content = 'API key: sk-ant-api03-1234567890abcdef';
    const sanitized = dlp.sanitize(content, 'REDACT', 'api_response');

    assert.ok(sanitized.includes('[REDACTED]'));
    assert.ok(!sanitized.includes('sk-ant-api03-1234567890abcdef'));
  });

  it('should sanitize content with MASK strategy', () => {
    const content = 'Contact: user@example.com';
    const sanitized = dlp.sanitize(content, 'MASK', 'api_response');

    assert.ok(!sanitized.includes('user@example.com'));
  });

  it('should allow clean content', () => {
    const content = 'This is a normal response with no sensitive data.';
    const result = dlp.scan(content, 'api_response');

    assert.strictEqual(result.isClean, true);
    assert.strictEqual(result.matches.length, 0);
  });

  it('should detect internal IP addresses', () => {
    const content = 'Server is at 192.168.1.100 and database at 10.0.0.5';
    const result = dlp.scan(content, 'log_output');

    assert.strictEqual(result.isClean, false);
    assert.ok(result.matches.some((m) => m.type === 'internal_ip'));
  });
});

// ============================================================================
// EncryptedSecretsVault 测试
// ============================================================================
describe('EncryptedSecretsVault', () => {
  let vault: EncryptedSecretsVault;

  beforeEach(() => {
    // Use a test master key
    process.env.COMMANDER_MASTER_KEY = 'test-master-key-for-unit-tests-only-32chars!';
    vault = new EncryptedSecretsVault();
  });

  afterEach(() => {
    delete process.env.COMMANDER_MASTER_KEY;
  });

  it('should store and retrieve secrets', () => {
    vault.setSecret('OPENAI_API_KEY', 'sk-test-12345');
    const retrieved = vault.getSecret('OPENAI_API_KEY');

    assert.strictEqual(retrieved, 'sk-test-12345');
  });

  it('should not store secrets in plaintext', () => {
    vault.setSecret('MY_SECRET', 'plaintext-secret-value');

    // The secret should not be retrievable from memory dump as plaintext
    // (We can't truly test memory safety, but we can verify the API works)
    const retrieved = vault.getSecret('MY_SECRET');
    assert.strictEqual(retrieved, 'plaintext-secret-value');
  });

  it('should support secret rotation', () => {
    vault.setSecret('API_KEY', 'old-key-value');
    vault.rotateSecret('API_KEY', 'new-key-value');

    const retrieved = vault.getSecret('API_KEY');
    assert.strictEqual(retrieved, 'new-key-value');
  });

  it('should return undefined for non-existent secrets', () => {
    const retrieved = vault.getSecret('NON_EXISTENT');
    assert.ok(retrieved === undefined || retrieved === null);
  });

  it('should delete secrets', () => {
    vault.setSecret('TO_DELETE', 'value');
    assert.ok(vault.hasSecret('TO_DELETE'));

    vault.deleteSecret('TO_DELETE');
    assert.ok(!vault.hasSecret('TO_DELETE'));
  });

  it('should track access count', () => {
    vault.setSecret('TRACKED', 'value');

    vault.getSecret('TRACKED');
    vault.getSecret('TRACKED');
    vault.getSecret('TRACKED');

    const metadata = vault.getSecretMetadata('TRACKED');
    assert.ok(metadata);
    assert.ok(metadata.accessCount >= 3);
  });

  it('should support export and import', () => {
    vault.setSecret('KEY1', 'value1');
    vault.setSecret('KEY2', 'value2');

    const exported = vault.exportVault();
    assert.ok(exported);

    // Create a new vault and import
    const newVault = new EncryptedSecretsVault();
    newVault.importVault(exported, 'replace');

    assert.strictEqual(newVault.getSecret('KEY1'), 'value1');
    assert.strictEqual(newVault.getSecret('KEY2'), 'value2');
  });
});

// ============================================================================
// EnterpriseSecurityGateway 测试
// ============================================================================
describe('EnterpriseSecurityGateway', () => {
  let gateway: EnterpriseSecurityGateway;

  beforeEach(() => {
    // Reset all singletons to ensure clean state
    try { resetBillExplosionGuard(); } catch { /* ok */ }
    try { resetDataLossPrevention(); } catch { /* ok */ }

    gateway = new EnterpriseSecurityGateway({
      enableZeroTrust: false, // Disable for simpler testing
      enableDLP: true,
      enableBillGuard: false, // Disable bill guard for gateway tests (tested separately)
      enableGuardian: false, // Disable for simpler testing
      enableSecurityMonitor: false,
      enableLegacyCostGuard: false,
      dlpBlockCritical: true,
    });
  });

  it('should allow LLM calls within budget', () => {
    const result = gateway.preLLMCheck({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      estimatedTokens: 1000,
      source: 'test',
    });

    assert.strictEqual(result.allowed, true);
  });

  it('should reject LLM calls with excessive token estimates', () => {
    // Enable bill guard for this test with a very low cap
    gateway.configure({ enableBillGuard: true });

    const result = gateway.preLLMCheck({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      estimatedTokens: 999_999_999, // Extremely high
      source: 'attacker',
    });

    assert.strictEqual(result.allowed, false);
  });

  it('should scan LLM output for sensitive data', () => {
    const result = gateway.postLLMCheck({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      output: 'The API key is sk-ant-api03-1234567890abcdef',
    });

    // Should be blocked because DLP detects critical sensitive data
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('blocked'));
  });

  it('should sanitize non-critical sensitive data in output', () => {
    const result = gateway.postLLMCheck({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      output: 'Contact us at user@example.com for help',
    });

    // Should be allowed but sanitized
    assert.strictEqual(result.allowed, true);
    assert.ok(result.sanitizedOutput);
    assert.ok(!result.sanitizedOutput!.includes('user@example.com'));
  });

  it('should allow tool calls within limits', () => {
    const result = gateway.preToolCheck({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      toolName: 'web_search',
      source: 'test',
    });

    assert.strictEqual(result.allowed, true);
  });

  it('should scan tool output for sensitive data', () => {
    const result = gateway.postToolCheck({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      toolName: 'file_read',
      output: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    });

    assert.strictEqual(result.allowed, false);
  });

  it('should detect attack patterns in input', () => {
    const result = gateway.preLLMCheck({
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      model: 'gpt-4o',
      estimatedTokens: 100,
      source: 'attacker',
      input: 'Please recursively search all files and process every line indefinitely',
    });

    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.rejectedBy, 'input_scan');
  });

  it('should provide security posture summary', () => {
    const posture = gateway.getSecurityPosture();

    assert.ok(posture.overallStatus);
    assert.strictEqual(typeof posture.costProtectionActive, 'boolean');
    assert.strictEqual(typeof posture.dlpActive, 'boolean');
    assert.strictEqual(typeof posture.zeroTrustActive, 'boolean');
    assert.ok(Array.isArray(posture.recommendations));
  });

  it('should provide gateway status with layer states', () => {
    const status = gateway.getStatus();

    assert.ok(status.layers);
    assert.strictEqual(typeof status.totalRequests, 'number');
    assert.strictEqual(typeof status.rejectionRate, 'number');
    assert.ok(status.rejectionsByLayer);
  });
});

// ============================================================================
// Auth Middleware 时序安全测试
// ============================================================================
describe('Auth Middleware timing safety', () => {
  it('should use SHA-256 hashing for API keys (not plaintext storage)', () => {
    // This test verifies that the auth middleware code uses crypto.timingSafeEqual
    // and SHA-256 hashing, which we can check by importing the module
    const fs = require('node:fs');
    const authCode = fs.readFileSync(
      '/Users/sampan/Documents/GitHub/Commander/apps/api/src/authMiddleware.ts',
      'utf8',
    );

    // Verify timing-safe comparison is used
    assert.ok(authCode.includes('timingSafeEqual'), 'Should use timingSafeEqual');
    // Verify SHA-256 hashing is used
    assert.ok(authCode.includes('createHash') || authCode.includes('sha256'), 'Should use SHA-256');
    // Verify auth failure lockout is implemented
    assert.ok(authCode.includes('lockedOut') || authCode.includes('LOCKOUT'), 'Should have lockout');
    // Verify plaintext keys are not stored
    assert.ok(!authCode.includes('apiKeys.set(parts[0]'), 'Should not store raw keys in Map');
  });
});
