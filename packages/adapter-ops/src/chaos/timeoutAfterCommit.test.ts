import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  canonicalEvidenceBody,
  createEvidenceSigner,
  verifyEvidenceSignature,
  type EvidenceBundle,
  type EvidenceSignature,
} from '@commander/effect-broker';
import { consumeCompensationBatch, type CompensationOutboxPort } from '@commander/kernel';
import {
  sealGovernedCompensationAuthorization,
  type GovernedCompensationAuthorizationInput,
} from '../../../kernel/src/ops/compensationAuthority.js';
import { ReconciliationDaemon } from '../reconciliationDaemon.js';

const COMPENSATION_WORKER = {
  workerId: 'compensation:timeout-chaos',
  workerGeneration: 3,
  claimSecret: 'compensation-timeout-secret',
} as const;

const RECONCILE_WORKER = {
  workerId: 'reconcile:timeout-chaos',
  workerGeneration: 6,
  claimSecret: 'reconcile-timeout-secret',
} as const;

/**
 * Real Ed25519 signer. The previous `verify: () => true` double made the
 * daemon's evidence acceptance check vacuous, and the assertion below compared
 * the persisted signature to the value the stub itself had produced.
 */
const TEST_EVIDENCE_SIGNER = createEvidenceSigner({
  privateKeyPem: generateKeyPairSync('ed25519').privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string,
  keyId: 'timeout-chaos-key',
});

type ClaimedCompensationWork = Awaited<
  ReturnType<CompensationOutboxPort['claimCompensationWork']>
>[number];

function authorityInput(): GovernedCompensationAuthorizationInput {
  return {
    schema: 'commander.compensation/v1',
    authorizationId: 'authorization-timeout',
    requestId: 'request-timeout',
    tenantId: 'tenant-timeout',
    originalRunId: 'run-forward',
    originalEffectId: 'effect-forward',
    originalRunStateAtRequest: 'COMPENSATING',
    compensationRunId: 'run-compensation',
    compensationStepId: 'step-compensation',
    compensationEffectId: 'effect-compensation-timeout',
    compensationEffectType: 'compensate.test.remote-write',
    compensationRequest: {
      originalEffectId: 'effect-forward',
      destination: 'test://remote/resource-1',
      forwardResponse: { revision: 7 },
      compensationPatch: { revision: 6 },
    },
    idempotencyKey: 'cmp:effect-forward:test-adapter-1',
    forwardReceipt: { revision: 7 },
    adapterVersion: 'test-adapter-1',
    policyDecisionId: 'decision-timeout',
    policySnapshotId: 'policy-timeout',
    decisionEffect: 'allow',
    authorizationExpiresAt: '2099-07-29T11:00:00.000Z',
    approvalBinding: null,
  };
}

describe('L4-02 operations chaos - compensation timeout after commit', () => {
  it('atomically hands off the same effect and reconciles without a second compensate', async () => {
    const authorization = sealGovernedCompensationAuthorization(authorityInput());
    const work: ClaimedCompensationWork = {
      messageId: 'outbox-timeout',
      tenantId: authorization.tenantId,
      claimToken: 'outbox-timeout-claim',
      authorization,
      lease: {
        workerId: COMPENSATION_WORKER.workerId,
        workerGeneration: COMPENSATION_WORKER.workerGeneration,
        token: 'compensation-step-lease',
        fencingEpoch: 9,
      },
    };
    let claimServed = false;
    let handoffInput: Record<string, unknown> | undefined;
    const outbox: CompensationOutboxPort = {
      async claimCompensationWork() {
        if (claimServed) return [];
        claimServed = true;
        return [work];
      },
      async completeCompensationWork() {
        throw new Error('uncertain completion must not be marked complete');
      },
      async handoffCompensationUnknown(input) {
        handoffInput = input;
        return { applied: true, disposition: 'HANDOFF_UNKNOWN' };
      },
      async escalateCompensationWork() {
        throw new Error('valid governed compensation must not be escalated');
      },
    };

    let compensateCalls = 0;
    let remoteApplied = false;
    const consumed = await consumeCompensationBatch(
      outbox,
      {
        async admit(input) {
          return { admitted: true, effectId: input.effectId, replayed: false };
        },
        async executeAdmitted() {
          compensateCalls += 1;
          remoteApplied = true;
          throw Object.assign(new Error('response lost after remote commit'), {
            code: 'COMPLETION_UNCONFIRMED',
          });
        },
      },
      async () => 'governed-compensation-token',
      {
        ...COMPENSATION_WORKER,
        registry: {
          resolve: (effectType) =>
            effectType === authorization.compensationEffectType
              ? { descriptor: { adapterVersion: authorization.adapterVersion } }
              : null,
        },
      },
    );

    assert.deepEqual(consumed, {
      consumed: 1,
      succeeded: 0,
      handedOff: 1,
      escalated: 0,
      replayed: 0,
    });
    assert.deepEqual(handoffInput, {
      ...COMPENSATION_WORKER,
      tenantId: authorization.tenantId,
      messageId: work.messageId,
      outboxClaimToken: work.claimToken,
      compensationEffectId: authorization.compensationEffectId,
      error: {
        code: 'COMPLETION_UNCONFIRMED',
        message: 'Compensation completion is uncertain',
      },
    });

    const effect = {
      id: authorization.compensationEffectId,
      runId: authorization.compensationRunId,
      stepId: authorization.compensationStepId,
      tenantId: authorization.tenantId,
      type: authorization.compensationEffectType,
      idempotencyKey: authorization.idempotencyKey,
      request: authorization.compensationRequest,
      response: undefined,
      state: 'COMPLETION_UNKNOWN',
      actionDigest: 'b'.repeat(64),
      policyDecisionId: authorization.policyDecisionId,
      policySnapshotId: authorization.policySnapshotId,
      requestHash: 'timeout-compensation-request-hash',
      createdAt: '2026-07-29T00:00:00.000Z',
    };
    let queryCalls = 0;
    let completedEffectId: string | undefined;
    let completedEvidence: unknown;
    const reconciliation = new ReconciliationDaemon({
      ...RECONCILE_WORKER,
      pollIntervalMs: 60_000,
      batchSize: 1,
      evidenceSigner: TEST_EVIDENCE_SIGNER,
      repository: {
        claimReconcileEffects: async () => [
          { effect: effect as never, claimToken: 'reconcile-claim' },
        ],
        listEffectsForRun: async () => [effect as never],
        listEvents: async () => [],
        completeReconcileEffect: async (input) => {
          completedEffectId = input.effectId;
          completedEvidence = input.evidence;
          return {
            applied: true,
            replayed: false,
            disposition: 'COMPLETED',
            receipt: { linkedDisposition: true },
          };
        },
        confirmEffectNotApplied: async () => {
          throw new Error('remote compensation was applied');
        },
        rescheduleReconcileEffect: async () => {
          throw new Error('applied compensation must not be rescheduled');
        },
        escalateReconcileEffect: async () => {
          throw new Error('query support is available');
        },
      },
      registry: {
        resolve: (effectType) => (effectType === authorization.compensationEffectType ? {} : null),
        outcomeQuerierFor: (effectType) =>
          effectType === authorization.compensationEffectType
            ? {
                queryOutcome: async (input) => {
                  queryCalls += 1;
                  assert.equal(input.effectId, authorization.compensationEffectId);
                  assert.equal(remoteApplied, true);
                  return {
                    status: 'APPLIED' as const,
                    response: { revision: 6, restored: true },
                  };
                },
              }
            : null,
      },
      brokerFactory: (querier) => ({
        reconcileUnknown: async ({ effect: claimedEffect }) =>
          querier.queryOutcome({
            effectId: claimedEffect.id,
            idempotencyKey: claimedEffect.idempotencyKey,
            type: claimedEffect.type,
            request: claimedEffect.request,
            tenantId: claimedEffect.tenantId,
            signal: AbortSignal.timeout(5_000),
          }),
      }),
    });

    assert.deepEqual(await reconciliation.tick(), {
      claimed: 1,
      completed: 1,
      escalated: 0,
      rescheduled: 0,
    });
    assert.equal(completedEffectId, authorization.compensationEffectId);
    const evidence = completedEvidence as
      { body?: unknown; signature?: EvidenceSignature } | undefined;
    assert.ok(evidence?.body, 'the daemon must persist the signed evidence body');
    assert.equal(evidence.signature?.algorithm, 'Ed25519');
    assert.equal(evidence.signature?.keyId, 'timeout-chaos-key');
    // Cryptographically verify the persisted terminal evidence, and prove the
    // check can fail by tampering with the signed body.
    assert.equal(
      verifyEvidenceSignature(
        canonicalEvidenceBody(evidence.body as EvidenceBundle),
        evidence.signature!,
        TEST_EVIDENCE_SIGNER.jwks,
      ),
      true,
      'terminal evidence signature must verify against the signing key',
    );
    assert.equal(
      verifyEvidenceSignature(
        canonicalEvidenceBody({ ...(evidence.body as Record<string, unknown>) } as EvidenceBundle),
        { ...evidence.signature!, value: 'AAAA' },
        TEST_EVIDENCE_SIGNER.jwks,
      ),
      false,
      'a forged signature must not verify',
    );
    assert.equal(queryCalls, 1);
    assert.equal(compensateCalls, 1);
  });
});
