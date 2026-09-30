import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  customerAcceptanceSigningPayload,
  deriveTechnicalVerdict,
  sha256,
  stableJson,
  verifyCustomerAcceptance,
  type CustomerAcceptance,
  type TechnicalProofAttestation,
} from './proof-metadata.js';

const digest = (character: string): string => character.repeat(64);

function completeAttestation(): TechnicalProofAttestation {
  return {
    tenantId: 'partner-tenant',
    source: {
      commit: 'a'.repeat(40),
      dirty: false,
      dependencyLockSha256: digest('b'),
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
    campaign: {
      driverBoundary: 'external-process',
      matrixComplete: true,
      allFaultPointsObserved: true,
      invariantsPassed: true,
      artifactsVerified: true,
    },
    gates: {
      disasterRecovery: {
        passed: true,
        honestyLevel: 'PROVEN',
        reportSha256: digest('d'),
        evidenceReceiptsRestored: true,
        evidenceAnchorsRestored: true,
        identityOutcomeAccountingPreserved: true,
      },
      signingRotation: {
        passed: true,
        status: 'GREEN',
        reportSha256: digest('e'),
        retainedJwksSha256: digest('f'),
        preRotationReceiptsVerified: true,
        postRotationReceiptsVerified: true,
        revokedSignerRejected: true,
      },
    },
  };
}

describe('technical product-proof derivation', () => {
  it('returns PROVEN only for a clean real multi-process campaign with both operational gates', () => {
    assert.deepEqual(deriveTechnicalVerdict(completeAttestation()), {
      verdict: 'PROVEN',
      failures: [],
    });
  });

  it('keeps mocked, in-memory, same-process, dirty, and incomplete runs NOT_READY', () => {
    const cases: Array<[string, (value: TechnicalProofAttestation) => void]> = [
      ['SOURCE_DIRTY', (value) => (value.source.dirty = true)],
      ['POSTGRESQL_BACKEND_REQUIRED', (value) => (value.topology.backend = 'in-memory')],
      ['REAL_EXTERNAL_SYSTEM_REQUIRED', (value) => (value.topology.externalSystem.mode = 'mocked')],
      [
        'DISTINCT_PROCESS_IDENTITIES_REQUIRED',
        (value) =>
          (value.topology.processIdentities.worker = value.topology.processIdentities.gateway),
      ],
      ['DATABASE_ROLE_ATTESTATION_INCOMPLETE', (value) => value.topology.databaseRoles.pop()],
      [
        'EXTERNAL_FAULT_DRIVER_REQUIRED',
        (value) => (value.campaign.driverBoundary = 'same-process'),
      ],
      ['FAULT_MATRIX_INCOMPLETE', (value) => (value.campaign.matrixComplete = false)],
      ['DISASTER_RECOVERY_GATE_REQUIRED', (value) => (value.gates.disasterRecovery.passed = false)],
      [
        'DISASTER_RECOVERY_EVIDENCE_INCOMPLETE',
        (value) => (value.gates.disasterRecovery.evidenceAnchorsRestored = false),
      ],
      ['SIGNING_ROTATION_GATE_REQUIRED', (value) => (value.gates.signingRotation.passed = false)],
      [
        'SIGNING_ROTATION_EVIDENCE_INCOMPLETE',
        (value) => (value.gates.signingRotation.revokedSignerRejected = false),
      ],
    ];

    for (const [failure, mutate] of cases) {
      const attestation = completeAttestation();
      mutate(attestation);
      const result = deriveTechnicalVerdict(attestation);
      assert.equal(result.verdict, 'NOT_READY', failure);
      assert.ok(result.failures.includes(failure), JSON.stringify(result));
    }
  });
});

describe('customer acceptance verification', () => {
  it('assigns FIELD-PROVEN only to a signed acceptance bound to the technical manifest', () => {
    const technicalManifest = `${stableJson({ verdict: 'PROVEN', workflowId: 'partner-rollback' })}\n`;
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
    const signature = sign(
      null,
      Buffer.from(customerAcceptanceSigningPayload(unsigned)),
      privateKey,
    );
    const acceptance: CustomerAcceptance = {
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        keyId: 'partner-review-key-1',
        value: signature.toString('base64'),
      },
    };

    assert.deepEqual(
      verifyCustomerAcceptance({
        technicalManifest,
        expectedWorkflowId: 'partner-rollback',
        acceptance,
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }),
      { verdict: 'FIELD-PROVEN', failures: [] },
    );
  });

  it('does not upgrade rejected, unsigned, tampered, or critically bypassed evidence', () => {
    const technicalManifest = `${stableJson({ verdict: 'PROVEN', workflowId: 'partner-rollback' })}\n`;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const base: Omit<CustomerAcceptance, 'signature'> = {
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
    const signature = sign(null, Buffer.from(customerAcceptanceSigningPayload(base)), privateKey);
    const signed: CustomerAcceptance = {
      ...base,
      signature: {
        algorithm: 'ed25519',
        keyId: 'partner-key',
        value: signature.toString('base64'),
      },
    };
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    for (const acceptance of [
      { ...signed, decision: 'rejected' as const },
      { ...signed, technicalManifestSha256: digest('0') },
      { ...signed, criticalBypasses: 1 },
      { ...signed, workflowCount: 0 },
      { ...signed, signature: { ...signed.signature, value: 'not-a-signature' } },
    ]) {
      assert.equal(
        verifyCustomerAcceptance({
          technicalManifest,
          expectedWorkflowId: 'partner-rollback',
          acceptance,
          publicKeyPem,
        }).verdict,
        'NOT_READY',
      );
    }
  });
});
