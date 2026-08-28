import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { DESIGN_PARTNER_FAULT_POINTS, DESIGN_PARTNER_SCENARIOS } from './design-partner-faults.js';
import {
  parseDesignPartnerProofArgs,
  runDesignPartnerFieldReview,
  runDesignPartnerTechnicalProof,
  type DesignPartnerProofConfig,
  type DesignPartnerProofPorts,
} from './design-partner-proof.js';
import {
  customerAcceptanceSigningPayload,
  sha256,
  stableJson,
  type CustomerAcceptance,
} from './proof-metadata.js';

const digest = (character: string): string => character.repeat(64);

function config(): DesignPartnerProofConfig {
  return {
    schema: 'commander-design-partner-proof-config/v1',
    workflowId: 'partner-rollback',
    tenantId: 'partner-tenant',
    scope: {
      clusterIdentitySha256: digest('9'),
      namespace: 'commander-proof',
      deployment: 'partner-api',
      targetRevisionRange: ['17', '18'],
      escalationOwner: 'role:sre-oncall',
    },
    versions: {
      images: {
        gateway: `commander/gateway@sha256:${digest('1')}`,
        kernelOps: `commander/kernel-ops@sha256:${digest('2')}`,
        adapterOps: `commander/adapter-ops@sha256:${digest('3')}`,
        worker: `commander/worker@sha256:${digest('4')}`,
      },
      protocol: 'action-operations/v1',
      contract: 'actions/v1',
      policy: 'partner-policy-v1',
      adapter: 'kubernetes.rollback/v1',
    },
    driver: {
      command: '/opt/commander/bin/design-partner-driver',
      args: [],
    },
    limitations: ['bounded rollback scope'],
    untestedBranches: [],
  };
}

function ports(): DesignPartnerProofPorts {
  return {
    captureSource: async () => ({
      commit: 'a'.repeat(40),
      dirty: false,
      dependencyLockSha256: digest('b'),
    }),
    runCampaign: async () => ({
      observation: {
        schema: 'commander-design-partner-campaign/v1',
        startedAt: '2026-07-29T00:00:00.000Z',
        endedAt: '2026-07-29T00:05:00.000Z',
        driver: { boundary: 'external-process', identity: 'container:fault-driver-1' },
        topology: {
          backend: 'postgresql',
          processIdentities: {
            gateway: 'container:gateway-1',
            kernelOps: 'container:kernel-ops-1',
            adapterOps: 'container:adapter-ops-1',
            worker: 'container:worker-1',
            verifier: 'container:verifier-1',
          },
          databaseRoles: [
            'commander_owner',
            'commander_app',
            'commander_tenant_authority',
            'commander_scheduler',
            'commander_worker',
            'commander_adapter_ops',
          ],
          externalSystem: { mode: 'real', identitySha256: digest('c') },
          standardClientPath: true,
        },
        faultPoints: [...DESIGN_PARTNER_FAULT_POINTS],
        scenarios: DESIGN_PARTNER_SCENARIOS.map((scenario) => ({
          id: scenario.id,
          passed: true,
          expectedExternalWrites: scenario.expectedExternalWrites,
          observedExternalWrites: scenario.expectedExternalWrites,
          observedOutcomeQueries: scenario.requiresOutcomeQuery ? 1 : 0,
          terminalDisposition: scenario.allowedTerminalDispositions[0],
          receiptVerified: true,
          evidencePersisted: true,
          reconciliationLatencyMs: scenario.requiresOutcomeQuery ? 2_000 : 0,
        })),
      },
      artifacts: {
        'events.ndjson': '{"type":"verified-transition"}\n',
        'receipt.json': '{"schema":"commander-evidence/v1","signature":"verified"}\n',
        'verification.json': '{"verified":true}\n',
        'metrics.json': '{"duplicateWrites":0}\n',
        'rotation-evidence.json': `${JSON.stringify({
          retainedJwksSha256: digest('f'),
          preRotationReceiptsVerified: true,
          postRotationReceiptsVerified: true,
          revokedSignerRejected: true,
        })}\n`,
      },
    }),
    runDisasterRecoveryGate: async () => ({
      passed: true,
      honestyLevel: 'PROVEN',
      reportSha256: digest('d'),
      evidenceReceiptsRestored: true,
      evidenceAnchorsRestored: true,
      identityOutcomeAccountingPreserved: true,
    }),
    runSigningRotationGate: async () => ({
      passed: true,
      status: 'GREEN',
      reportSha256: digest('e'),
      retainedJwksSha256: digest('f'),
      preRotationReceiptsVerified: true,
      postRotationReceiptsVerified: true,
      revokedSignerRejected: true,
    }),
    now: (() => {
      const values = ['2026-07-29T00:00:00.000Z', '2026-07-29T00:10:00.000Z'];
      return () => values.shift() ?? '2026-07-29T00:10:00.000Z';
    })(),
  };
}

describe('design-partner proof CLI contract', () => {
  it('parses technical and field-review modes without an evidence-level override', () => {
    assert.deepEqual(
      parseDesignPartnerProofArgs(['--config', 'proof.json', '--output', 'evidence/run']),
      { mode: 'technical', config: 'proof.json', output: 'evidence/run' },
    );
    assert.deepEqual(
      parseDesignPartnerProofArgs(['--', '--config', 'proof.json', '--output', 'evidence/run']),
      { mode: 'technical', config: 'proof.json', output: 'evidence/run' },
    );
    assert.deepEqual(
      parseDesignPartnerProofArgs([
        '--technical-manifest',
        'manifest.json',
        '--customer-acceptance',
        'acceptance.json',
        '--customer-public-key',
        'reviewer.pem',
        '--output',
        'evidence/field',
      ]),
      {
        mode: 'field-review',
        technicalManifest: 'manifest.json',
        customerAcceptance: 'acceptance.json',
        customerPublicKey: 'reviewer.pem',
        output: 'evidence/field',
      },
    );
    assert.throws(
      () =>
        parseDesignPartnerProofArgs([
          '--config',
          'proof.json',
          '--output',
          'evidence/run',
          '--evidence-level',
          'PROVEN',
        ]),
      /unknown argument/,
    );
  });
});

describe('technical design-partner proof', () => {
  it('emits a PROVEN manifest with hashes only after campaign, DR, and rotation pass', async () => {
    const result = await runDesignPartnerTechnicalProof(config(), ports());
    assert.equal(result.manifest.verdict, 'PROVEN');
    assert.equal(result.manifest.passed, true);
    assert.deepEqual(result.manifest.failures, []);
    assert.deepEqual(result.manifest.artifacts.map(({ path }) => path).sort(), [
      'campaign-observation.json',
      'events.ndjson',
      'metrics.json',
      'receipt.json',
      'rotation-evidence.json',
      'verification.json',
    ]);
    for (const artifact of result.manifest.artifacts)
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      JSON.stringify(result).includes('/opt/commander/bin/design-partner-driver'),
      false,
    );
  });

  it('retains NOT_READY when an operational gate is incomplete', async () => {
    const incomplete = ports();
    incomplete.runDisasterRecoveryGate = async () => ({
      passed: true,
      honestyLevel: 'PROVEN',
      reportSha256: digest('d'),
      evidenceReceiptsRestored: true,
      evidenceAnchorsRestored: false,
      identityOutcomeAccountingPreserved: true,
    });
    const result = await runDesignPartnerTechnicalProof(config(), incomplete);
    assert.equal(result.manifest.verdict, 'NOT_READY');
    assert.equal(result.manifest.passed, false);
    assert.ok(result.manifest.failures.includes('DISASTER_RECOVERY_EVIDENCE_INCOMPLETE'));
  });

  it('fails closed without retaining driver artifacts containing secrets or raw payloads', async () => {
    const unsafe = ports();
    const runCampaign = unsafe.runCampaign;
    unsafe.runCampaign = async (value) => {
      const campaign = await runCampaign(value);
      campaign.artifacts['events.ndjson'] =
        '{"password":"customer-secret","payload":{"change":"raw"}}\n';
      return campaign;
    };
    const result = await runDesignPartnerTechnicalProof(config(), unsafe);
    assert.equal(result.manifest.verdict, 'NOT_READY');
    assert.ok(result.manifest.failures.includes('RETAINED_ARTIFACT_UNSAFE:events.ndjson'));
    assert.deepEqual(result.artifacts, {});
    assert.equal(JSON.stringify(result).includes('customer-secret'), false);
  });

  it('returns NOT_READY when the external driver cannot run and does not execute later gates', async () => {
    const unavailable = ports();
    let gateCalls = 0;
    unavailable.runCampaign = async () => {
      throw new Error('driver unavailable at postgres://user:secret@db/commander');
    };
    unavailable.runDisasterRecoveryGate = async () => {
      gateCalls += 1;
      throw new Error('must not run');
    };
    unavailable.runSigningRotationGate = async () => {
      gateCalls += 1;
      throw new Error('must not run');
    };
    const result = await runDesignPartnerTechnicalProof(config(), unavailable);
    assert.equal(result.manifest.verdict, 'NOT_READY');
    assert.ok(result.manifest.failures.includes('CAMPAIGN_DRIVER_UNAVAILABLE'));
    assert.equal(gateCalls, 0);
    assert.equal(JSON.stringify(result).includes('postgres://'), false);
  });
});

describe('field review', () => {
  it('upgrades an exact PROVEN manifest only after customer signature verification', () => {
    const technicalManifest = `${stableJson({
      schema: 'commander-design-partner-proof/v1',
      verdict: 'PROVEN',
      workflowId: 'partner-rollback',
    })}\n`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const unsigned: Omit<CustomerAcceptance, 'signature'> = {
      schema: 'commander-design-partner-acceptance/v1',
      technicalManifestSha256: sha256(technicalManifest),
      workflowId: 'partner-rollback',
      decision: 'accepted',
      reviewer: {
        organization: 'Design Partner',
        role: 'security-reviewer',
        subject: 'reviewer@example.invalid',
      },
      observationWindow: {
        startedAt: '2026-07-01T00:00:00.000Z',
        endedAt: '2026-07-28T00:00:00.000Z',
      },
      workflowCount: 7,
      criticalBypasses: 0,
      acceptedAt: '2026-07-29T00:00:00.000Z',
    };
    const acceptance: CustomerAcceptance = {
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        keyId: 'partner-key',
        value: sign(
          null,
          Buffer.from(customerAcceptanceSigningPayload(unsigned)),
          privateKey,
        ).toString('base64'),
      },
    };
    const result = runDesignPartnerFieldReview({
      technicalManifest,
      acceptance,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    assert.equal(result.verdict, 'FIELD-PROVEN');
    assert.equal(result.technicalManifestSha256, sha256(technicalManifest));
    assert.equal(result.acceptanceSha256, sha256(`${stableJson(acceptance)}\n`));
  });
});
