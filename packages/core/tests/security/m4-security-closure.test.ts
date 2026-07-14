import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';

import {
  SecretBroker,
  EnvVarKmsAdapter,
  SecretBrokerError,
  resetSecretBroker,
  type KmsAdapter,
} from '../../src/security/secretBroker';

import {
  SignedPolicyBundleManager,
  InMemoryDecisionLog,
  SignedPolicyBundleError,
  resetSignedPolicyBundleManager,
} from '../../src/security/signedPolicyBundle';

import {
  OutboundNetworkPolicy,
  type DataClassification,
} from '../../src/security/outboundNetworkPolicy';

// ============================================================================
// SecretBroker tests
// ============================================================================

describe('SecretBroker', () => {
  let broker: SecretBroker;

  beforeEach(() => {
    // Use a mock KMS adapter for deterministic tests
    const mockKms: KmsAdapter = {
      name: 'mock',
      async retrieve(input: { connector: string }) {
        return { credential: `mock-credential-for-${input.connector}` };
      },
    };
    broker = new SecretBroker(mockKms, {
      signingKey: 'a'.repeat(64),
      defaultTtlSeconds: 60,
      maxTtlSeconds: 300,
    });
  });

  afterEach(() => {
    resetSecretBroker();
  });

  it('issues a handle and allows access within TTL', async () => {
    const handle = await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });

    assert.ok(handle.handleId.startsWith('sh_'));
    assert.ok(handle.signature);
    assert.equal(handle.connector, 'slack');
    assert.deepEqual(handle.scopes, ['chat:write']);
    assert.equal(handle.tenantId, 'tenant-a');

    const material = await broker.access(handle, 'tenant-a');
    assert.equal(material.credential, 'mock-credential-for-slack');
    assert.equal(material.handleId, handle.handleId);
  });

  it('rejects access after expiry', async () => {
    const handle = await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      ttlSeconds: 1,
    });

    // Wait for expiry
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await assert.rejects(
      () => broker.access(handle, 'tenant-a'),
      (err: SecretBrokerError) => err.code === 'HANDLE_EXPIRED',
    );
  });

  it('rejects access from wrong tenant', async () => {
    const handle = await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });

    await assert.rejects(
      () => broker.access(handle, 'tenant-b'),
      (err: SecretBrokerError) => err.code === 'TENANT_MISMATCH',
    );
  });

  it('rejects access after revocation', async () => {
    const handle = await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });

    broker.revoke(handle.handleId, 'tenant-a');

    await assert.rejects(
      () => broker.access(handle, 'tenant-a'),
      (err: SecretBrokerError) => err.code === 'HANDLE_REVOKED',
    );
  });

  it('revokes all handles for a run', async () => {
    const h1 = await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 's1',
    });
    const h2 = await broker.issue({
      connector: 'github',
      scopes: ['repo:read'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 's2',
    });

    const count = broker.revokeRun('run-1', 'tenant-a');
    assert.equal(count, 2);

    await assert.rejects(
      () => broker.access(h1, 'tenant-a'),
      (e: SecretBrokerError) => e.code === 'HANDLE_REVOKED',
    );
    await assert.rejects(
      () => broker.access(h2, 'tenant-a'),
      (e: SecretBrokerError) => e.code === 'HANDLE_REVOKED',
    );
  });

  it('rejects forged handle signatures', async () => {
    const handle = await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });

    const forgedHandle = { ...handle, signature: 'deadbeef'.repeat(8) };

    await assert.rejects(
      () => broker.access(forgedHandle, 'tenant-a'),
      (err: SecretBrokerError) => err.code === 'HANDLE_INVALID',
    );
  });

  it('records audit entries for all operations', async () => {
    const handle = await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
    });
    await broker.access(handle, 'tenant-a');
    broker.revoke(handle.handleId, 'tenant-a');

    const log = broker.getAuditLog();
    assert.ok(log.some((e) => e.type === 'issued'));
    assert.ok(log.some((e) => e.type === 'accessed'));
    assert.ok(log.some((e) => e.type === 'revoked'));
  });

  it('sweeps expired handles', async () => {
    await broker.issue({
      connector: 'slack',
      scopes: ['chat:write'],
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      ttlSeconds: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const removed = broker.sweep();
    assert.equal(removed, 1);
    assert.equal(broker.getActiveHandleCount(), 0);
  });
});

describe('EnvVarKmsAdapter', () => {
  it('reads from environment variables', async () => {
    process.env.COMMANDER_SECRET_TESTSVC = 'env-secret-value';
    const adapter = new EnvVarKmsAdapter();
    const result = await adapter.retrieve({ connector: 'testsvc', scopes: [], tenantId: 't1' });
    assert.equal(result.credential, 'env-secret-value');
    delete process.env.COMMANDER_SECRET_TESTSVC;
  });

  it('throws when secret is not found', async () => {
    delete process.env.COMMANDER_SECRET_MISSING;
    const adapter = new EnvVarKmsAdapter();
    await assert.rejects(
      () => adapter.retrieve({ connector: 'missing', scopes: [], tenantId: 't1' }),
      (err: SecretBrokerError) => err.code === 'SECRET_NOT_FOUND',
    );
  });
});

// ============================================================================
// SignedPolicyBundle tests
// ============================================================================

describe('SignedPolicyBundleManager', () => {
  let manager: SignedPolicyBundleManager;

  beforeEach(() => {
    manager = new SignedPolicyBundleManager({
      signingKey: 'k'.repeat(64),
      keyId: 'test-key',
    });
  });

  afterEach(() => {
    resetSignedPolicyBundleManager();
  });

  const createPayload = (version: number = 1) => ({
    name: 'default',
    version,
    snapshotId: `ps_v${version}`,
    effectDefaults: { allow: false, requireApproval: false },
    rules: [{ name: 'rule1', effect: 'allow' }],
    schemaVersion: '1.0',
    publishedAt: new Date().toISOString(),
  });

  it('publishes and retrieves a signed bundle', () => {
    const bundle = manager.publish(createPayload());
    assert.ok(bundle.signature);
    assert.equal(bundle.keyId, 'test-key');

    const bundles = manager.getBundles();
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].snapshotId, 'ps_v1');
  });

  it('verifies integrity of a valid bundle', () => {
    const bundle = manager.publish(createPayload());
    assert.equal(manager.verifyIntegrity(bundle.snapshotId), true);
  });

  it('fails verification for tampered bundle', () => {
    manager.publish(createPayload());
    // Can't easily tamper without internal access — verify by loading a bad bundle
    assert.throws(
      () =>
        manager.verifyAndLoad({
          ...createPayload(),
          signature: 'tampered',
          keyId: 'test-key',
        }),
      (err: SignedPolicyBundleError) => err.code === 'SIGNATURE_INVALID',
    );
  });

  it('rejects bundle with wrong key ID', () => {
    const bundle = manager.publish(createPayload());
    assert.throws(
      () =>
        manager.verifyAndLoad({
          ...bundle,
          keyId: 'wrong-key',
        }),
      (err: SignedPolicyBundleError) => err.code === 'KEY_MISMATCH',
    );
  });

  it('pins a run to a snapshot and resolves correctly', () => {
    manager.publish(createPayload(1));
    manager.publish({ ...createPayload(2), snapshotId: 'ps_v2' });

    const pin = manager.pin('run-1', 'tenant-a', 'ps_v1');
    assert.equal(pin.snapshotId, 'ps_v1');

    const resolved = manager.resolveForRun('run-1');
    assert.equal(resolved.snapshotId, 'ps_v1');
    assert.equal(resolved.version, 1);
  });

  it('falls back to latest when run is not pinned', () => {
    manager.publish(createPayload(1));
    manager.publish({ ...createPayload(2), snapshotId: 'ps_v2' });

    const resolved = manager.resolveForRun('run-2');
    assert.equal(resolved.version, 2);
  });

  it('unpins a run', () => {
    manager.publish(createPayload(1));
    manager.pin('run-1', 'tenant-a', 'ps_v1');
    assert.ok(manager.getPin('run-1'));

    manager.unpin('run-1');
    assert.equal(manager.getPin('run-1'), null);
  });

  it('logs and queries policy decisions', async () => {
    manager.publish(createPayload(1));
    manager.pin('run-1', 'tenant-a', 'ps_v1');

    await manager.logDecision({
      decisionId: 'pd_1',
      tenantId: 'tenant-a',
      runId: 'run-1',
      stepId: 'step-1',
      effect: 'allow',
      reason: 'rule1 matched',
      snapshotId: 'ps_v1',
      packVersion: 1,
      riskScore: 10,
      latencyMs: 2,
    });

    const decisions = await manager.queryDecisions({ runId: 'run-1' });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].effect, 'allow');
    assert.equal(decisions[0].snapshotId, 'ps_v1');
  });
});

// ============================================================================
// OutboundNetworkPolicy per-classification tests
// ============================================================================

describe('OutboundNetworkPolicy per-classification allowlist', () => {
  let policy: OutboundNetworkPolicy;

  beforeEach(() => {
    policy = new OutboundNetworkPolicy({
      enabled: true,
      allowlist: ['api.openai.com', 'api.anthropic.com', 'api.slack.com'],
      blocklist: [],
      auditLog: false,
      blockPrivateIPs: true,
      classificationAllowlist: {
        pii: ['api.anthropic.com'],
        phi: [],
      },
    });
  });

  it('allows public classification on any globally-allowed domain', () => {
    const result = policy.checkWithClassification('https://api.openai.com/v1/chat', 'public');
    assert.equal(result.allowed, true);
  });

  it('allows pii classification only on pii-allowed domains', () => {
    const ok = policy.checkWithClassification('https://api.anthropic.com/v1', 'pii');
    assert.equal(ok.allowed, true);

    const blocked = policy.checkWithClassification('https://api.openai.com/v1', 'pii');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.reason?.includes('classification'));
  });

  it('blocks phi classification entirely when allowlist is empty', () => {
    const result = policy.checkWithClassification('https://api.anthropic.com/v1', 'phi');
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes('classification'));
  });

  it('falls back to global check when no classification provided', () => {
    const result = policy.checkWithClassification('https://api.openai.com/v1');
    assert.equal(result.allowed, true);
  });

  it('falls back to global check when classification has no per-class allowlist', () => {
    const result = policy.checkWithClassification('https://api.slack.com/api', 'confidential');
    assert.equal(result.allowed, true);
  });

  it('blocklist still takes precedence over classification', () => {
    const policyWithBlock = new OutboundNetworkPolicy({
      enabled: true,
      allowlist: ['api.openai.com'],
      blocklist: ['api.openai.com'],
      classificationAllowlist: {
        pii: ['api.openai.com'],
      },
    });
    const result = policyWithBlock.checkWithClassification('https://api.openai.com/v1', 'pii');
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes('blocklist'));
  });
});
