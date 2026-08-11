import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { InMemoryKernelRepository } from '@commander/kernel/testing/inMemoryRepository';
import { KERNEL_COMPENSATION_TOPIC } from '@commander/kernel';
import {
  canonicalRequestHash,
  canonicalEvidenceBody,
  createEvidenceSigner,
  EffectBroker,
  verifyEvidenceSignature,
  verifySignedEvidenceBundle,
} from '@commander/effect-broker';
import { CompensationDaemon, reverseCompensationEffectIds } from './compensationDaemon.js';

const COMP_PAYLOAD = {
  type: 'kernel.compensation.requested',
  tenantId: 'tenant-a',
  runId: 'run-cmp',
  stepId: 'step-cmp',
  compensationAction: 'compensate.github.pull-request.create',
  // Mirrors the real requestCompensation payload shape: fencingEpoch is always
  // derived from the original effect's own lease, never invented by the consumer.
  compensationPayload: { originalEffectId: 'effect-1', forwardResponse: { prNumber: 1 }, fencingEpoch: 1 },
  idempotencyKey: 'cmp:effect-1:1.0.0',
};

describe('CompensationDaemon', () => {
  it('reverseCompensationEffectIds processes latest effect first', () => {
    assert.deepEqual(reverseCompensationEffectIds(['a', 'b', 'c']), ['c', 'b', 'a']);
  });

  it('succeeds once when adapter is registered (single claim path)', async () => {
    const kernel = new InMemoryKernelRepository();
    kernel.seedOutboxMessage({
      topic: KERNEL_COMPENSATION_TOPIC,
      tenantId: 'tenant-a',
      key: 'tenant-a/run-cmp/effect-1',
      payload: COMP_PAYLOAD,
    });
    const daemon = new CompensationDaemon({
      repository: kernel,
      registry: {
        resolve: (action) => (action === 'compensate.github.pull-request.create' ? {} : null),
        outcomeQuerierFor: () => null,
        listDescriptors: () => [],
      } as never,
      broker: {
        admit: async () => ({ admitted: true, effectId: 'eff', replayed: false }),
        executeAdmitted: async () => ({ effectId: 'eff', replayed: false, response: {} }),
      },
      tokenProvider: async () => 'token',
      pollIntervalMs: 60_000,
      batchSize: 10,
    });
    const result = await daemon.tick();
    assert.equal(result.consumed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
  });

  it('retries unregistered adapter messages instead of starving them', async () => {
    const kernel = new InMemoryKernelRepository();
    const seeded = kernel.seedOutboxMessage({
      topic: KERNEL_COMPENSATION_TOPIC,
      tenantId: 'tenant-a',
      key: 'tenant-a/run-cmp/effect-1',
      payload: COMP_PAYLOAD,
    });
    const daemon = new CompensationDaemon({
      repository: kernel,
      registry: { resolve: () => null, outcomeQuerierFor: () => null, listDescriptors: () => [] } as never,
      broker: {
        admit: async () => ({ admitted: true, effectId: 'eff', replayed: false }),
        executeAdmitted: async () => ({ effectId: 'eff', replayed: false, response: {} }),
      },
      tokenProvider: async () => 'token',
      pollIntervalMs: 60_000,
      batchSize: 10,
    });
    const result = await daemon.tick();
    assert.equal(result.consumed, 1);
    assert.equal(result.succeeded, 0);
    assert.ok(result.failed >= 1);
    const reclaimed = await kernel.claimOutboxByTopic(
      KERNEL_COMPENSATION_TOPIC,
      10,
      new Date(Date.now() + 120_000),
    );
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0]?.id, seeded.id);
  });

  it('returns zero counts when consumeCompensationBatch rejects', async () => {
    const kernel = new InMemoryKernelRepository();
    const daemon = new CompensationDaemon({
      repository: {
        ...kernel,
        claimOutboxByTopic: async () => {
          throw new Error('db unavailable');
        },
      } as never,
      registry: { resolve: () => null, outcomeQuerierFor: () => null, listDescriptors: () => [] } as never,
      broker: {
        admit: async () => ({ admitted: true, effectId: 'eff', replayed: false }),
        executeAdmitted: async () => ({ effectId: 'eff', replayed: false, response: {} }),
      },
      tokenProvider: async () => 'token',
      pollIntervalMs: 60_000,
      batchSize: 10,
    });
    const result = await daemon.tick();
    assert.deepEqual(result, { consumed: 0, succeeded: 0, failed: 0 });
  });

  it('persists a verifiable receipt when a compensation broker completes', async () => {
    const kernel = new InMemoryKernelRepository();
    await kernel.createRun(
      {
        id: 'run-compensation-evidence',
        tenantId: 'tenant-a',
        intentHash: 'intent',
        workGraphHash: 'graph',
        workGraphVersion: 'v1',
        policySnapshotId: 'adapter-ops-v1',
        steps: [{ id: 'step-compensation-evidence', kind: 'tool' }],
      },
      'gateway',
    );
    const step = await kernel.claimNextStep({
      workerId: 'compensation-daemon',
      workerGeneration: 1,
      leaseTtlMs: 60_000,
    });
    assert.ok(step?.lease);
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = createEvidenceSigner({
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'compensation-evidence-key',
    });
    const request = { originalEffectId: 'effect-forward' };
    const actionDigest = 'c'.repeat(64);
    const broker = new EffectBroker(
      {
        verify: async () => ({
          jti: 'compensation-grant',
          tenantId: 'tenant-a',
          runId: 'run-compensation-evidence',
          stepId: step.id,
          audience: 'commander.effect-broker',
          effectTypes: ['compensate.github.pull-request.create'],
          expiresAt: '2099-01-01T00:00:00.000Z',
          policySnapshotId: 'adapter-ops-v1',
          requestHash: canonicalRequestHash(request),
          actionDigest,
          workerId: 'compensation-daemon',
          workerGeneration: 1,
        }),
      },
      {
        evaluate: async () => ({
          effect: 'allow',
          decisionId: 'adapter-ops-allow',
          reason: 'registered compensation adapter',
          policySnapshotId: 'adapter-ops-v1',
        }),
      },
      {
        admitEffect: (input) => kernel.admitEffect(input),
        completeEffect: (...args) => kernel.completeEffect(...args),
        completeEffectWithEvidence: (...args) => kernel.completeEffectWithEvidence(...args),
      },
      { execute: async () => ({ status: 'compensated' }) },
      { append: async () => {} },
      { evidenceSigner: signer },
    );

    await broker.execute({
      effectId: 'effect-compensation',
      token: 'verified-by-test-port',
      type: 'compensate.github.pull-request.create',
      request,
      idempotencyKey: 'compensation-evidence',
      lease: step.lease,
      actor: 'compensation-daemon',
    });
    const evidence = await kernel.getEvidence({
      tenantId: 'tenant-a',
      runId: 'run-compensation-evidence',
      effectId: 'effect-compensation',
      actionDigest,
    });
    assert.equal(evidence?.receipt.terminalDisposition, 'SUCCEEDED');
    assert.equal(verifySignedEvidenceBundle(evidence!.receipt).ok, true);
    assert.equal(
      verifyEvidenceSignature(
        canonicalEvidenceBody(evidence!.receipt),
        evidence!.receipt.signature,
        signer.jwks,
      ),
      true,
    );
  });
});
