import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { actionGatewayPolicySnapshot } from '@commander/contracts';
import { canonicalBytes, sha256Hex } from './canonical.js';
import { parseShadowManifest, parseShadowObservation } from './contracts.js';
import { observationDigest } from './evaluator.js';
import { runShadowCli, type ShadowCliRepository } from './cli.js';

const manifestKeys = generateKeyPairSync('ed25519');
const reportKeys = generateKeyPairSync('ed25519');
const snapshot = actionGatewayPolicySnapshot();

function observation() {
  return parseShadowObservation({
    schema: 'commander.shadow-observation/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    batchId: 'batch-1',
    index: 0,
    observationId: 'observation-1',
    occurredAt: '2026-09-01T00:00:00.000Z',
    workflow: 'kubernetes.deployment.rollback',
    effectType: 'connector.kubernetes.deployment.rollback',
    tool: 'kubernetes.deployment.rollback',
    destination: 'k8s://cluster/namespace/deployments/api',
    productionDecision: 'require_approval',
    productionReasonCode: 'REGISTERED_ADAPTER_POLICY',
  });
}

function manifest() {
  const input = observation();
  const unsigned = {
    schema: 'commander.shadow-manifest/v1',
    campaignId: 'campaign-1',
    tenantId: 'tenant-1',
    producerId: 'producer-1',
    policyId: snapshot.policyId,
    policyDigest: snapshot.descriptorDigest,
    batchId: 'batch-1',
    closesAt: '2026-09-02T00:00:00.000Z',
    records: [{ index: 0, observationId: input.observationId, digest: observationDigest(input) }],
    keyId: 'manifest-key-1',
  };
  return parseShadowManifest({
    ...unsigned,
    signature: sign(null, canonicalBytes(unsigned), manifestKeys.privateKey).toString('base64url'),
  });
}

class FakeRepository implements ShadowCliRepository {
  readonly calls: string[] = [];
  readonly imported: unknown[] = [];
  async registerManifest() {
    this.calls.push('register');
    return { idempotent: false };
  }
  async importObservation(_tenantId: string, value: unknown) {
    this.calls.push('import');
    this.imported.push(value);
    if (value === null || typeof value !== 'object' || !('campaignId' in value)) {
      throw new Error('SHADOW_MISSING_FIELD');
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      'productionDecision' in value &&
      value.productionDecision === 'invalid'
    ) {
      throw new Error('SHADOW_INVALID_DECISION');
    }
    return { idempotent: false };
  }
  async closeDueBatch() {
    this.calls.push('close');
  }
  async readReport() {
    this.calls.push('report');
    const input = observation();
    const registeredManifest = manifest();
    return {
      campaign: {
        campaign_id: 'campaign-1',
        policy_id: snapshot.policyId,
        policy_digest: snapshot.descriptorDigest,
        state: 'open',
      },
      batches: [
        {
          batch_id: 'batch-1',
          state: 'closed',
          manifest: registeredManifest,
          manifest_digest: sha256Hex(canonicalBytes(registeredManifest)),
        },
      ],
      records: [
        {
          batch_id: 'batch-1',
          record_index: 0,
          observation_id: input.observationId,
          digest: observationDigest(input),
          status: 'compared',
          canonical_observation: input,
          hypothetical_decision: 'require_approval',
          hypothetical_decision_id: 'action-gateway-manifest-require_approval',
          hypothetical_reason_code: 'REGISTERED_ADAPTER_POLICY',
          production_decision: 'require_approval',
          production_reason_code: 'REGISTERED_ADAPTER_POLICY',
          comparison: 'match',
        },
      ],
    };
  }
  async withdrawCampaign() {
    this.calls.push('withdraw');
  }
  async runRetention() {
    this.calls.push('retention');
    return 2;
  }
  async readiness() {
    this.calls.push('status');
    return { ready: true, code: 'SHADOW_READY' };
  }
}

function dependencies(repository: ShadowCliRepository) {
  return {
    repository,
    tenantId: 'tenant-1',
    cleanupFreshnessMinutes: 90,
    reportSigning: { keyId: 'report-key-1', privateKey: reportKeys.privateKey },
    sourceRevision: 'abc123',
    now: () => new Date('2026-09-03T00:00:00.000Z'),
  };
}

describe('commander-shadow CLI', () => {
  it('routes every command through the repository and verifies exported evidence offline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const manifestFile = join(directory, 'manifest.json');
    const importFile = join(directory, 'observations.ndjson');
    const reportFile = join(directory, 'report.json');
    const publicKeyFile = join(directory, 'report-public.pem');
    writeFileSync(manifestFile, JSON.stringify(manifest()));
    writeFileSync(importFile, `${JSON.stringify(observation())}\n`);
    writeFileSync(publicKeyFile, reportKeys.publicKey.export({ format: 'pem', type: 'spki' }));
    const repository = new FakeRepository();
    const deps = dependencies(repository);

    for (const argv of [
      ['manifest', 'register', '--file', manifestFile],
      ['import', '--file', importFile],
      ['batch', 'close', '--campaign', 'campaign-1', '--batch', 'batch-1'],
      ['report', 'export', '--campaign', 'campaign-1', '--output', reportFile],
      ['campaign', 'withdraw', '--campaign', 'campaign-1', '--confirm', 'campaign-1'],
      ['retention', 'run'],
      ['status'],
    ])
      assert.equal((await runShadowCli(argv, deps)).exitCode, 0);

    const verify = await runShadowCli([
      'report',
      'verify',
      '--bundle',
      reportFile,
      '--public-key',
      publicKeyFile,
    ]);
    assert.deepEqual(verify, {
      exitCode: 0,
      output: { status: 'ok', code: 'SHADOW_REPORT_VALID' },
    });
    assert.deepEqual(repository.calls, [
      'register',
      'import',
      'close',
      'report',
      'withdraw',
      'retention',
      'status',
    ]);
    assert.equal(JSON.parse(readFileSync(reportFile, 'utf8')).schema, 'commander.shadow-report/v1');
  });

  it('requires exact withdrawal confirmation and reports partial imports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'partial.ndjson');
    writeFileSync(file, `${JSON.stringify(observation())}\n{"bad":true}\n`);
    const repository = new FakeRepository();
    assert.equal(
      (
        await runShadowCli(
          ['campaign', 'withdraw', '--campaign', 'campaign-1', '--confirm', 'yes'],
          dependencies(repository),
        )
      ).exitCode,
      1,
    );
    const result = await runShadowCli(['import', '--file', file], dependencies(repository));
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.output, {
      status: 'error',
      code: 'SHADOW_IMPORT_PARTIAL',
      imported: 1,
      rejected: 1,
    });
  });

  it('passes bound schema-invalid observations to PostgreSQL for rejection evidence', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'rejected.ndjson');
    writeFileSync(file, `${JSON.stringify({ ...observation(), productionDecision: 'invalid' })}\n`);
    const repository = new FakeRepository();
    const result = await runShadowCli(['import', '--file', file], dependencies(repository));
    assert.deepEqual(result, {
      exitCode: 1,
      output: { status: 'error', code: 'SHADOW_IMPORT_PARTIAL', imported: 0, rejected: 1 },
    });
    assert.equal(repository.imported.length, 1);
  });

  it('bounds NDJSON lines and sanitizes unexpected errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'commander-shadow-cli-'));
    const file = join(directory, 'oversize.ndjson');
    writeFileSync(file, `${'x'.repeat(17_000)}\n`);
    const repository = new FakeRepository();
    const oversized = await runShadowCli(['import', '--file', file], dependencies(repository));
    assert.equal(oversized.exitCode, 1);
    assert.equal(oversized.output.code, 'SHADOW_IMPORT_PARTIAL');
    repository.registerManifest = async () => {
      throw new Error('postgres://user:top-secret@db/customer');
    };
    const manifestFile = join(directory, 'manifest.json');
    writeFileSync(manifestFile, JSON.stringify(manifest()));
    const failed = await runShadowCli(
      ['manifest', 'register', '--file', manifestFile],
      dependencies(repository),
    );
    assert.deepEqual(failed, {
      exitCode: 1,
      output: { status: 'error', code: 'SHADOW_COMMAND_FAILED' },
    });
    assert.doesNotMatch(JSON.stringify(failed), /top-secret|postgres:/);
  });
});
